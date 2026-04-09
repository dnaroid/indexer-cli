import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	MetadataStore,
	ProjectId,
	SnapshotId,
} from "../core/types.js";
import { SystemLogger } from "../core/logger.js";
import { computeHash } from "../utils/hash.js";

const logger = new SystemLogger("enricher");

interface OllamaGenerateResponse {
	response: string;
	done: boolean;
}

export interface EnrichProjectOptions {
	pathPrefix?: string;
	force?: boolean;
	dryRun?: boolean;
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
}

export interface EnrichResult {
	filesEnriched: number;
	symbolsEnriched: number;
	filesSkipped: number;
	errors: string[];
}

export class EnricherEngine {
	private readonly requestTimeoutMs = 120_000;

	constructor(
		private readonly baseUrl: string,
		private readonly model: string,
		private readonly repoRoot: string,
		private readonly metadata: MetadataStore,
	) {}

	private async generate(prompt: string): Promise<string> {
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			this.requestTimeoutMs,
		);
		try {
			const response = await fetch(`${this.baseUrl}/api/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: this.model, prompt, stream: false }),
				signal: controller.signal,
			});
			if (!response.ok) {
				throw new Error(`Ollama responded with status ${response.status}`);
			}
			const data = (await response.json()) as OllamaGenerateResponse;
			return data.response.trim();
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private async generateModuleSummary(
		filePath: string,
		chunks: string[],
	): Promise<string> {
		if (chunks.length === 0) return "";

		if (chunks.length === 1) {
			return this.generate(
				`Summarize this code module in 1-2 sentences. Be concise. Only describe what it does, not implementation details.\n\nFile: ${filePath}\n\n${chunks[0]}`,
			);
		}

		// Map: summarize each chunk separately
		const chunkSummaries = await Promise.all(
			chunks.map((chunk) =>
				this.generate(`Describe this code section in one sentence:\n\n${chunk}`),
			),
		);

		// Reduce: combine chunk summaries into module summary
		return this.generate(
			`Based on these section descriptions, write a 1-2 sentence summary of the module "${filePath}":\n\n${chunkSummaries.join("\n")}`,
		);
	}

	async enrichProject(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		options: EnrichProjectOptions = {},
	): Promise<EnrichResult> {
		const {
			pathPrefix,
			force = false,
			dryRun = false,
			concurrency = 1,
			onProgress,
		} = options;
		const result: EnrichResult = {
			filesEnriched: 0,
			symbolsEnriched: 0,
			filesSkipped: 0,
			errors: [],
		};

		const files = await this.metadata.listFiles(projectId, snapshotId, {
			pathPrefix,
		});
		let done = 0;

		// Process files with bounded concurrency
		const queue = [...files];
		const workers = Array(Math.min(concurrency, files.length))
			.fill(null)
			.map(async () => {
				while (queue.length > 0) {
					const file = queue.shift();
					if (!file) break;
					try {
						await this.enrichFile(
							projectId,
							snapshotId,
							file.path,
							file.sha256,
							{ force, dryRun, result },
						);
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						logger.error(`Error enriching ${file.path}`, { message });
						result.errors.push(`${file.path}: ${message}`);
					} finally {
						done++;
						onProgress?.(done, files.length);
					}
				}
			});

		await Promise.all(workers);

		return result;
	}

	private async enrichFile(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		expectedHash: string,
		options: { force: boolean; dryRun: boolean; result: EnrichResult },
	): Promise<void> {
		const { force, dryRun, result } = options;

		// Check if file enrichment is already up-to-date
		if (!force) {
			const existing = await this.metadata.getFileEnrichment(
				projectId,
				filePath,
			);
			if (existing && existing.contentHash === expectedHash) {
				result.filesSkipped++;
				return;
			}
		}

		if (dryRun) {
			result.filesEnriched++;
			return;
		}

		let content: string;
		try {
			content = await readFile(join(this.repoRoot, filePath), "utf8");
		} catch {
			result.errors.push(`${filePath}: could not read file`);
			return;
		}

		const actualHash = computeHash(content);
		if (actualHash !== expectedHash) {
			// File changed since indexing — skip, snapshot is stale for this file
			result.filesSkipped++;
			return;
		}

		const chunkRecords = await this.metadata.listChunks(
			projectId,
			snapshotId,
			filePath,
		);
		const lines = content.split("\n");
		const chunks = chunkRecords
			.filter((c) => c.chunkType !== "imports")
			.map((c) =>
				lines
					.slice(c.startLine - 1, c.endLine)
					.join("\n")
					.trim(),
			)
			.filter(Boolean);

		if (chunks.length === 0) {
			result.filesSkipped++;
			return;
		}

		const moduleSummary = await this.generateModuleSummary(filePath, chunks);
		await this.metadata.upsertFileEnrichment(projectId, {
			projectId,
			filePath,
			contentHash: actualHash,
			moduleSummary,
			enrichedAt: Date.now(),
		});
		result.filesEnriched++;

		// Enrich exported symbols
		const symbols = await this.metadata.listSymbols(
			projectId,
			snapshotId,
			filePath,
		);
		const exportedSymbols = symbols.filter((s) => s.exported);

		for (const symbol of exportedSymbols) {
			try {
				const startLine = symbol.range.start.line;
				const endLine = symbol.range.end.line;
				const symbolContent = lines
					.slice(startLine - 1, endLine)
					.join("\n")
					.trim();
				if (!symbolContent) continue;

				const symbolHash = computeHash(symbolContent);
				if (!force) {
					const existing = await this.metadata.getSymbolEnrichment(
						projectId,
						filePath,
						symbol.name,
					);
					if (existing && existing.contentHash === symbolHash) {
						continue;
					}
				}

				const prompt = symbol.signature
					? `Describe what this ${symbol.kind} does in one sentence. Be concise.\n\nSignature: ${symbol.signature}`
					: `Describe what this ${symbol.kind} does in one sentence. Be concise.\n\n${symbolContent}`;

				const description = await this.generate(prompt);
				await this.metadata.upsertSymbolEnrichment(projectId, {
					projectId,
					filePath,
					symbolName: symbol.name,
					contentHash: symbolHash,
					description,
					enrichedAt: Date.now(),
				});
				result.symbolsEnriched++;
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				logger.warn(
					`Error enriching symbol ${symbol.name} in ${filePath}`,
					{ message },
				);
			}
		}
	}
}
