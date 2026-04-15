import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
	ChunkRecord,
	ChunkOverlapSymbol,
	DependencyRecord,
	EmbeddingProvider,
	GitDiff,
	GitOperations,
	MetadataStore,
	ProjectId,
	SnapshotId,
	SnapshotStatus,
	SymbolRecord,
	VectorStore,
} from "../core/types.js";
import { LanguagePluginRegistry } from "../languages/plugin.js";
import type {
	LanguageCodeChunk,
	LanguagePlugin,
	LanguageSymbol,
} from "../languages/plugin.js";
import { TypeScriptPlugin } from "../languages/typescript.js";
import { PythonPlugin } from "../languages/python.js";
import { CSharpPlugin } from "../languages/csharp.js";
import { GDScriptPlugin } from "../languages/gdscript.js";
import { RubyPlugin } from "../languages/ruby.js";
import { SystemLogger } from "../core/logger.js";
import { config } from "../core/config.js";
import { TokenEstimator } from "../utils/token-estimator.js";
import { computeHash } from "../utils/hash.js";
import { AdaptiveChunker } from "../chunking/adaptive.js";
import { ArchitectureGenerator } from "./architecture.js";
import { resolveDependency } from "./dependency-resolver.js";
import { scanProjectFiles } from "./scanner.js";

const logger = new SystemLogger("indexer-engine");

type MetadataStoreWithProgress = MetadataStore & {
	updateSnapshotProgress(
		id: SnapshotId,
		processedFiles: number,
		totalFiles: number,
	): Promise<void>;
};

type PreparedFileData = {
	filePath: string;
	content: string;
	fileRecord: {
		snapshotId: SnapshotId;
		path: string;
		sha256: string;
		mtimeMs: number;
		size: number;
		languageId: string;
	};
	chunkRecords: ChunkRecord[];
	chunksContent: Map<string, string>;
	symbolRecords: SymbolRecord[];
	dependencyRecords: DependencyRecord[];
	metrics: {
		complexity: number;
		maintainability: number;
		churn: number;
		testCoverage?: number;
	};
};

interface ImportInfo {
	id: string;
	spec: string;
	resolvedPath?: string;
	kind: string;
}

interface IndexingOptions {
	codeExtensions?: string[];
	skipImportChunksInVectors?: boolean;
}

export interface IndexProjectOptions {
	projectId?: ProjectId;
	gitRef?: string;
	repoRoot?: string;
	isFullReindex: boolean;
	changedFiles?: GitDiff;
	onProgress?: (processed: number, total: number) => void;
	onFileStart?: (filePath: string, current: number, total: number) => void;
}

export interface IndexResult {
	snapshotId: string;
	filesIndexed: number;
	errors: string[];
}

interface IndexFileOptions {
	snapshotId: string;
	projectId: string;
	filePath: string;
	content: string;
	gitRef: string;
	knownFiles: Set<string>;
}

export interface IndexerEngineOptions {
	projectId: ProjectId;
	repoRoot: string;
	metadata: MetadataStore;
	vectors: VectorStore;
	embedder: EmbeddingProvider;
	git: GitOperations;
	indexingOptions?: IndexingOptions;
	languagePlugins?: LanguagePlugin[];
}

export type BuiltinLanguagePluginId =
	| "typescript"
	| "python"
	| "csharp"
	| "gdscript"
	| "ruby";

export const DEFAULT_LANGUAGE_PLUGIN_IDS: readonly BuiltinLanguagePluginId[] = [
	"typescript",
	"python",
	"csharp",
	"gdscript",
	"ruby",
];

const BUILTIN_LANGUAGE_PLUGIN_FACTORIES: Record<
	BuiltinLanguagePluginId,
	() => LanguagePlugin
> = {
	typescript: () => new TypeScriptPlugin(),
	python: () => new PythonPlugin(),
	csharp: () => new CSharpPlugin(),
	gdscript: () => new GDScriptPlugin(),
	ruby: () => new RubyPlugin(),
};

function normalizeImportKind(
	kind: string,
): "import" | "require" | "dynamic_import" {
	if (kind === "require") return "require";
	if (kind === "dynamic_import") return "dynamic_import";
	return "import";
}

export const createDefaultLanguagePlugins = (
	pluginIds?: readonly string[],
): LanguagePlugin[] => {
	const ids =
		pluginIds && pluginIds.length > 0 ? pluginIds : DEFAULT_LANGUAGE_PLUGIN_IDS;
	const normalizedIds = Array.from(
		new Set(
			ids
				.map((value) => value.trim().toLowerCase())
				.filter((value) => value.length > 0),
		),
	);

	return normalizedIds.map((id) => {
		if (!(id in BUILTIN_LANGUAGE_PLUGIN_FACTORIES)) {
			throw new Error(`Unsupported language plugin id: ${id}`);
		}
		return BUILTIN_LANGUAGE_PLUGIN_FACTORIES[id as BuiltinLanguagePluginId]();
	});
};

export class IndexerEngine {
	private readonly projectId: ProjectId;
	private readonly repoRoot: string;
	private readonly metadata: MetadataStore;
	private readonly vectors: VectorStore;
	private readonly embedder: EmbeddingProvider;
	private readonly git: GitOperations;
	private readonly languagePluginRegistry = new LanguagePluginRegistry();
	private readonly indexingOptions: Required<IndexingOptions>;
	private churnByFile = new Map<string, number>();
	private readonly tokenEstimator = new TokenEstimator();
	private readonly chunker = new AdaptiveChunker();
	private readonly architectureGenerator: ArchitectureGenerator;

	constructor(options: IndexerEngineOptions) {
		this.projectId = options.projectId;
		this.repoRoot = options.repoRoot;
		this.metadata = options.metadata;
		this.vectors = options.vectors;
		this.embedder = options.embedder;
		this.git = options.git;

		const languagePlugins =
			options.languagePlugins ?? createDefaultLanguagePlugins();
		this.languagePluginRegistry.registerMany(languagePlugins);

		const pluginCodeExtensions = Array.from(
			new Set(
				this.languagePluginRegistry
					.list()
					.flatMap((plugin) =>
						plugin.fileExtensions.map((ext) => ext.toLowerCase()),
					),
			),
		);

		this.indexingOptions = {
			codeExtensions:
				options.indexingOptions?.codeExtensions &&
				options.indexingOptions.codeExtensions.length > 0
					? options.indexingOptions.codeExtensions.map((ext) =>
							ext.toLowerCase(),
						)
					: pluginCodeExtensions,
			skipImportChunksInVectors:
				options.indexingOptions?.skipImportChunksInVectors ?? false,
		};

		this.architectureGenerator = new ArchitectureGenerator(
			this.metadata,
			this.languagePluginRegistry.list(),
			this.repoRoot,
		);
	}

	private get metadataWithProgress(): MetadataStoreWithProgress {
		return this.metadata as MetadataStoreWithProgress;
	}

	private getConfiguredOllamaNumCtx(): number | null {
		if (config.get("embeddingProvider") !== "ollama") {
			return null;
		}

		const numCtx = config.get("ollamaNumCtx");
		return Number.isFinite(numCtx) && numCtx > 0 ? Math.floor(numCtx) : null;
	}

	private isOllamaContextLengthError(error: unknown): boolean {
		const message =
			error instanceof Error ? error.message : String(error ?? "");
		const normalized = message.toLowerCase();
		return (
			normalized.includes("input length exceeds the context length") ||
			(normalized.includes("context length") &&
				normalized.includes("status=400"))
		);
	}

	private trimToTokenBudget(content: string, tokenBudget: number): string {
		if (tokenBudget <= 0 || content.length === 0) {
			return content;
		}

		let trimmed = content;
		let estimatedTokens = this.tokenEstimator.estimate(trimmed);

		if (estimatedTokens <= tokenBudget) {
			return trimmed;
		}

		const initialRatio = Math.min(
			1,
			tokenBudget / Math.max(estimatedTokens, 1),
		);
		const initialLength = Math.max(
			32,
			Math.floor(trimmed.length * initialRatio * 0.95),
		);
		trimmed = trimmed.slice(0, initialLength);
		estimatedTokens = this.tokenEstimator.estimate(trimmed);

		while (estimatedTokens > tokenBudget && trimmed.length > 32) {
			const nextLength = Math.max(32, Math.floor(trimmed.length * 0.85));
			if (nextLength >= trimmed.length) {
				break;
			}
			trimmed = trimmed.slice(0, nextLength);
			estimatedTokens = this.tokenEstimator.estimate(trimmed);
		}

		return trimmed;
	}

	private async embedWithContextGuard(
		contents: string[],
		operation: string,
	): Promise<number[][]> {
		try {
			return await this.embedder.embed(contents);
		} catch (error) {
			const ollamaNumCtx = this.getConfiguredOllamaNumCtx();
			if (!ollamaNumCtx || !this.isOllamaContextLengthError(error)) {
				throw error;
			}

			const retryWithBudget = async (
				tokenBudget: number,
				passName: string,
			): Promise<number[][]> => {
				const sizeDetails = contents.map((content, index) => {
					const originalTokens = this.tokenEstimator.estimate(content);
					const trimmedContent = this.trimToTokenBudget(content, tokenBudget);
					const trimmedTokens = this.tokenEstimator.estimate(trimmedContent);
					return {
						index,
						content: trimmedContent,
						originalChars: content.length,
						originalBytes: Buffer.byteLength(content, "utf8"),
						originalTokens,
						trimmedChars: trimmedContent.length,
						trimmedBytes: Buffer.byteLength(trimmedContent, "utf8"),
						trimmedTokens,
					};
				});

				logger.warn(`Embedding context overflow during ${operation}`, {
					operation,
					passName,
					embeddingModel: config.get("embeddingModel"),
					numCtx: ollamaNumCtx,
					tokenBudget,
					itemCount: sizeDetails.length,
					trimmedCount: sizeDetails.filter(
						(item) => item.trimmedChars < item.originalChars,
					).length,
					sizes: sizeDetails.map(({ content: _content, ...detail }) => detail),
				});

				return this.embedder.embed(sizeDetails.map((item) => item.content));
			};

			try {
				return await retryWithBudget(
					Math.max(16, Math.floor(ollamaNumCtx * 0.9)),
					"first",
				);
			} catch (retryError) {
				if (!this.isOllamaContextLengthError(retryError)) {
					throw retryError;
				}
				return retryWithBudget(
					Math.max(16, Math.floor(ollamaNumCtx * 0.75)),
					"second",
				);
			}
		}
	}

	private shouldIndexChunkInVectors(chunk: ChunkRecord): boolean {
		return (
			!this.indexingOptions.skipImportChunksInVectors ||
			chunk.chunkType !== "imports"
		);
	}

	private normalizeChunkType(
		value: unknown,
		chunkContent: string,
		primarySymbol?: string,
	): ChunkRecord["chunkType"] {
		if (typeof value === "string") {
			const normalized = value.trim().toLowerCase();
			if (normalized === "imports") return "imports";
			if (normalized === "types") return "types";
			if (normalized === "impl") return "impl";
			if (normalized === "preamble") return "preamble";
			if (normalized === "declaration") return "declaration";
			if (normalized === "module_section") return "module_section";
			if (normalized === "full_file") return "full_file";
		}

		if (primarySymbol) {
			return "impl";
		}

		const trimmed = chunkContent.trim();
		if (!trimmed) return "full_file";

		const lines = trimmed
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);

		if (
			lines.length > 0 &&
			lines.filter((line) =>
				/^(import\b|from\s+\S+\s+import\b|using\s+\S+\s*;|export\b.+\bfrom\b|const\s+.+\s*=\s*require\()/i.test(
					line,
				),
			).length /
				lines.length >=
				0.8
		) {
			return "imports";
		}

		if (
			/(^|\s)(interface|type|enum|protocol|trait|typedef|delegate)\b/i.test(
				trimmed,
			)
		) {
			return "types";
		}

		return "impl";
	}

	private inferPrimarySymbol(
		chunk: LanguageCodeChunk,
		symbolRecords: SymbolRecord[],
	): string | undefined {
		const explicitPrimary =
			typeof chunk.metadata?.primarySymbol === "string"
				? String(chunk.metadata.primarySymbol).trim()
				: undefined;
		if (explicitPrimary) {
			return explicitPrimary;
		}

		// Match symbols whose range overlaps the chunk range
		const overlapping = symbolRecords.filter(
			(symbol) =>
				symbol.range.start.line <= chunk.range.endLine &&
				symbol.range.end.line >= chunk.range.startLine,
		);
		if (overlapping.length === 0) {
			return undefined;
		}

		const kindPriority = new Map<string, number>([
			["function", 5],
			["method", 5],
			["class", 4],
			["interface", 3],
			["type", 2],
			["variable", 1],
		]);

		return overlapping.sort((a, b) => {
			const aPriority = kindPriority.get(a.kind) ?? 0;
			const bPriority = kindPriority.get(b.kind) ?? 0;
			if (aPriority !== bPriority) {
				return bPriority - aPriority;
			}
			// Symbols starting inside the chunk are more representative than
			// enclosing ones that only overlap from before the chunk start
			const aInside = a.range.start.line >= chunk.range.startLine ? 1 : 0;
			const bInside = b.range.start.line >= chunk.range.startLine ? 1 : 0;
			if (aInside !== bInside) {
				return bInside - aInside;
			}
			if (aInside) {
				// First symbol in chunk is most representative
				return a.range.start.line - b.range.start.line;
			}
			// For enclosing symbols, prefer the most specific (smallest span)
			const aSpan = a.range.end.line - a.range.start.line;
			const bSpan = b.range.end.line - b.range.start.line;
			return aSpan - bSpan;
		})[0]?.name;
	}

	private getOverlappingChunkSymbols(
		chunk: LanguageCodeChunk,
		symbolRecords: SymbolRecord[],
	): ChunkOverlapSymbol[] {
		return symbolRecords
			.filter(
				(symbol) =>
					(symbol.kind === "function" || symbol.kind === "method") &&
					symbol.range.start.line <= chunk.range.endLine &&
					symbol.range.end.line >= chunk.range.startLine,
			)
			.sort((a, b) => {
				const aInside = a.range.start.line >= chunk.range.startLine ? 1 : 0;
				const bInside = b.range.start.line >= chunk.range.startLine ? 1 : 0;
				if (aInside !== bInside) {
					return bInside - aInside;
				}
				if (a.range.start.line !== b.range.start.line) {
					return a.range.start.line - b.range.start.line;
				}
				return a.range.end.line - b.range.end.line;
			})
			.map((symbol) => ({
				name: symbol.name,
				kind: symbol.kind,
				startLine: symbol.range.start.line,
				endLine: symbol.range.end.line,
				signature: symbol.signature,
			}));
	}

	private splitHeuristicChunks(
		content: string,
		languageId: string,
	): Array<{
		content: string;
		startLine: number;
		endLine: number;
		chunkType: ChunkRecord["chunkType"];
		primarySymbol?: string;
	}> {
		const lines = content.split(/\r?\n/);
		if (lines.length === 0) {
			return [];
		}

		const isPython = languageId === "python";
		const isCSharp = languageId === "csharp";
		const isGDScript = languageId === "gdscript";
		const isRuby = languageId === "ruby";
		const isJSImport =
			languageId === "typescript" || languageId === "javascript";
		if (!isPython && !isCSharp && !isGDScript && !isRuby && !isJSImport) {
			return [];
		}

		const chunks: Array<{
			content: string;
			startLine: number;
			endLine: number;
			chunkType: ChunkRecord["chunkType"];
			primarySymbol?: string;
		}> = [];

		const importPattern = isPython
			? /^(import\s+\S+|from\s+\S+\s+import\s+)/
			: isCSharp
				? /^using\s+[^;]+;/
				: isGDScript
					? /^(extends\s+\S+|class_name\s+\S+|const\s+\S+\s*=\s*preload\(|var\s+\S+\s*=\s*preload\()/
					: isRuby
						? /^(require|require_relative|include|extend)\b/
						: /^(import\s+|export\s+.+\s+from\s+|const\s+.+\s*=\s*require\()/;

		let importEnd = 0;
		for (let index = 0; index < lines.length; index += 1) {
			const trimmed = lines[index].trim();
			if (
				trimmed === "" ||
				trimmed.startsWith("//") ||
				trimmed.startsWith("#") ||
				trimmed.startsWith("/*") ||
				importPattern.test(trimmed)
			) {
				if (importPattern.test(trimmed)) {
					importEnd = index + 1;
				}
				continue;
			}
			break;
		}

		if (importEnd > 0) {
			const importContent = lines.slice(0, importEnd).join("\n").trim();
			if (importContent) {
				chunks.push({
					content: importContent,
					startLine: 1,
					endLine: importEnd,
					chunkType: "imports",
				});
			}
		}

		const definitions: Array<{
			line: number;
			chunkType: ChunkRecord["chunkType"];
			primarySymbol?: string;
		}> = [];

		const pythonDefPattern =
			/^(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
		const csharpTypePattern =
			/\b(class|interface|enum|struct|record)\s+([A-Za-z_][A-Za-z0-9_]*)/;
		const csharpMethodPattern =
			/\b(?:public|private|protected|internal|static|virtual|override|sealed|partial|async|extern|unsafe|abstract|new|readonly|ref|out|in)+\s+[A-Za-z_][A-Za-z0-9_<>,\[\]?]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
		const gdClassPattern = /^(?:class_name|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
		const gdFuncPattern = /^(?:static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
		const rubyTypePattern = /^(?:class|module)\s+([A-Z][A-Za-z0-9_:]*)/;
		const rubyMethodPattern =
			/^def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_]*[!?=]?)/;
		const jsDefPattern =
			/^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/;

		for (let index = importEnd; index < lines.length; index += 1) {
			const line = lines[index].trim();
			if (!line) continue;

			if (isPython) {
				const match = line.match(pythonDefPattern);
				if (match) {
					definitions.push({
						line: index + 1,
						chunkType: /^class\b/.test(line) ? "types" : "impl",
						primarySymbol: match[1],
					});
				}
				continue;
			}

			if (isCSharp) {
				const typeMatch = line.match(csharpTypePattern);
				if (typeMatch) {
					definitions.push({
						line: index + 1,
						chunkType:
							typeMatch[1] === "interface" || typeMatch[1] === "enum"
								? "types"
								: "impl",
						primarySymbol: typeMatch[2],
					});
					continue;
				}
				const methodMatch = line.match(csharpMethodPattern);
				if (methodMatch) {
					definitions.push({
						line: index + 1,
						chunkType: "impl",
						primarySymbol: methodMatch[1],
					});
				}
				continue;
			}

			if (isGDScript) {
				const classMatch = line.match(gdClassPattern);
				if (classMatch) {
					definitions.push({
						line: index + 1,
						chunkType: "types",
						primarySymbol: classMatch[1],
					});
					continue;
				}
				const funcMatch = line.match(gdFuncPattern);
				if (funcMatch) {
					definitions.push({
						line: index + 1,
						chunkType: "impl",
						primarySymbol: funcMatch[1],
					});
				}
				continue;
			}

			if (isRuby) {
				const typeMatch = line.match(rubyTypePattern);
				if (typeMatch) {
					definitions.push({
						line: index + 1,
						chunkType: "types",
						primarySymbol: typeMatch[1],
					});
					continue;
				}

				const methodMatch = line.match(rubyMethodPattern);
				if (methodMatch) {
					definitions.push({
						line: index + 1,
						chunkType: "impl",
						primarySymbol: methodMatch[1],
					});
				}
				continue;
			}

			const jsMatch = line.match(jsDefPattern);
			if (jsMatch) {
				definitions.push({
					line: index + 1,
					chunkType: /^.*\bclass\b/.test(line) ? "types" : "impl",
					primarySymbol: jsMatch[1],
				});
			}
		}

		if (definitions.length === 0) {
			const fallback = lines.slice(importEnd).join("\n").trim();
			if (fallback) {
				chunks.push({
					content: fallback,
					startLine: importEnd + 1,
					endLine: lines.length,
					chunkType: "impl",
				});
			}
			return chunks;
		}

		for (let index = 0; index < definitions.length; index += 1) {
			const current = definitions[index];
			const next = definitions[index + 1];
			const startLine = current.line;
			const endLine = next ? Math.max(startLine, next.line - 1) : lines.length;
			const chunkText = lines
				.slice(startLine - 1, endLine)
				.join("\n")
				.trim();
			if (!chunkText) continue;
			chunks.push({
				content: chunkText,
				startLine,
				endLine,
				chunkType: current.chunkType,
				primarySymbol: current.primarySymbol,
			});
		}

		return chunks;
	}

	private deriveLanguageChunks(
		languagePlugin: LanguagePlugin | null,
		parsed: unknown,
		languageId: string,
		filePath: string,
		content: string,
		symbolRecords: SymbolRecord[],
	): Array<{
		content: string;
		startLine: number;
		endLine: number;
		chunkType: ChunkRecord["chunkType"];
		primarySymbol?: string;
		metadata?: ChunkRecord["metadata"];
	}> {
		if (languagePlugin && parsed) {
			const pluginChunks = languagePlugin.splitIntoChunks(parsed as any, {
				targetTokens: 280,
				maxTokens: 560,
			});
			if (pluginChunks.length > 0) {
				return pluginChunks.map((chunk) => {
					const primarySymbol = this.inferPrimarySymbol(chunk, symbolRecords);
					const overlappingSymbols = this.getOverlappingChunkSymbols(
						chunk,
						symbolRecords,
					);
					return {
						content: chunk.content,
						startLine: chunk.range.startLine,
						endLine: chunk.range.endLine,
						chunkType: this.normalizeChunkType(
							chunk.metadata?.chunkType,
							chunk.content,
							primarySymbol,
						),
						primarySymbol,
						metadata:
							overlappingSymbols.length > 0
								? { overlappingSymbols }
								: undefined,
					};
				});
			}
		}

		const heuristicChunks = this.splitHeuristicChunks(content, languageId);
		if (heuristicChunks.length > 0) {
			return heuristicChunks;
		}

		return this.chunker
			.chunk({ filePath, content, language: languageId })
			.map((chunk) => ({
				content: chunk.content,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				chunkType: this.normalizeChunkType(
					chunk.type,
					chunk.content,
					chunk.primarySymbol,
				),
				primarySymbol: chunk.primarySymbol,
			}));
	}

	async initialize(): Promise<void> {
		await Promise.all([
			this.metadata.initialize(),
			this.vectors.initialize(),
			this.embedder.initialize(),
		]);
	}

	async close(): Promise<void> {
		await Promise.all([
			this.metadata.close(),
			this.vectors.close(),
			this.embedder.close(),
		]);
	}

	async indexProject(options: IndexProjectOptions): Promise<IndexResult> {
		const projectId = options.projectId ?? this.projectId;
		const repoRoot = options.repoRoot ?? this.repoRoot;
		const gitRef =
			options.gitRef ?? (await this.git.getHeadCommit(repoRoot)) ?? "unknown";
		const errors: string[] = [];

		await this.loadChurnByFile(repoRoot);

		const latestSnapshot =
			await this.metadata.getLatestCompletedSnapshot(projectId);
		const shouldDoFullReindex =
			options.isFullReindex ||
			!latestSnapshot ||
			!options.changedFiles ||
			options.changedFiles.deleted.length +
				options.changedFiles.modified.length +
				options.changedFiles.added.length >
				20000;

		if (shouldDoFullReindex) {
			return this.performFullReindex(
				projectId,
				gitRef,
				repoRoot,
				options.onProgress,
				options.onFileStart,
			);
		}

		if (!latestSnapshot || !options.changedFiles) {
			throw new Error("Latest snapshot not found for incremental indexing");
		}

		const snapshot = await this.createSnapshot(projectId, gitRef, "indexing");
		const snapshotId = snapshot.id;

		try {
			await this.prepareIncrementalSnapshot({
				projectId,
				prevSnapshotId: latestSnapshot.id,
				newSnapshotId: snapshotId,
				diff: options.changedFiles,
			});

			const filesToIndex = [
				...options.changedFiles.modified,
				...options.changedFiles.added,
			].filter((filePath) =>
				this.indexingOptions.codeExtensions.includes(
					extname(filePath).toLowerCase(),
				),
			);

			const totalFiles = (await this.metadata.listFiles(projectId, snapshotId))
				.length;
			const knownFiles = new Set(
				(await this.metadata.listFiles(projectId, snapshotId)).map((file) =>
					this.normalizePath(file.path),
				),
			);
			if (filesToIndex.length === 0) {
				await this.metadata.updateSnapshotProgress(
					snapshotId,
					totalFiles,
					totalFiles,
				);
				await this.architectureGenerator.generate(projectId, snapshotId);
				await this.metadata.updateSnapshotStatus(snapshotId, "completed");
				await this.pruneHistoricalSnapshots(projectId, snapshotId);
				return { snapshotId, filesIndexed: totalFiles, errors: [] };
			}

			await this.indexPreparedFiles({
				projectId,
				repoRoot,
				gitRef,
				snapshotId,
				filesToIndex,
				knownFiles,
				totalFiles,
				onProgress: options.onProgress,
				errors,
				operation: "incremental batch indexing",
			});

			await this.architectureGenerator.generate(projectId, snapshotId);
			if (errors.length > 0) {
				const message = `Incremental indexing completed with ${errors.length} preparation error${errors.length === 1 ? "" : "s"}`;
				await this.metadata.updateSnapshotStatus(snapshotId, "failed", message);
				throw new Error(message);
			}
			await this.metadata.updateSnapshotStatus(snapshotId, "completed");
			await this.metadataWithProgress.updateSnapshotProgress(
				snapshotId,
				totalFiles,
				totalFiles,
			);
			await this.pruneHistoricalSnapshots(projectId, snapshotId);
			return { snapshotId, filesIndexed: filesToIndex.length, errors };
		} catch (error) {
			await this.metadata.updateSnapshotStatus(
				snapshotId,
				"failed",
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	}

	async indexFile(options: IndexFileOptions): Promise<void> {
		const data = await this.prepareFileRecords(options);
		const vectorChunks = data.chunkRecords.filter((chunk) =>
			this.shouldIndexChunkInVectors(chunk),
		);

		await Promise.all([
			this.metadata.upsertFile(options.projectId, data.fileRecord),
			this.metadata.replaceChunks(
				options.projectId,
				options.snapshotId,
				options.filePath,
				data.chunkRecords,
			),
			this.metadata.replaceSymbols(
				options.projectId,
				options.snapshotId,
				options.filePath,
				data.symbolRecords,
			),
			this.metadata.replaceDependencies(
				options.projectId,
				options.snapshotId,
				options.filePath,
				data.dependencyRecords,
			),
			this.metadata.upsertFileMetrics(options.projectId, {
				snapshotId: options.snapshotId,
				filePath: options.filePath,
				metrics: data.metrics,
			}),
			(async () => {
				if (vectorChunks.length === 0) {
					return;
				}

				const embeddings = await this.embedWithContextGuard(
					vectorChunks.map(
						(chunk) => data.chunksContent.get(chunk.chunkId) || "",
					),
					"single-file indexing",
				);

				await this.vectors.upsert(
					vectorChunks.map((chunk, index) => ({
						projectId: options.projectId,
						chunkId: chunk.chunkId,
						snapshotId: options.snapshotId,
						filePath: options.filePath,
						startLine: chunk.startLine,
						endLine: chunk.endLine,
						embedding: embeddings[index],
						contentHash: chunk.contentHash,
						chunkType: chunk.chunkType,
						primarySymbol: chunk.primarySymbol,
					})),
				);
			})(),
		]);
	}

	private async indexPreparedFiles(options: {
		projectId: ProjectId;
		repoRoot: string;
		gitRef: string;
		snapshotId: SnapshotId;
		filesToIndex: string[];
		knownFiles: Set<string>;
		totalFiles: number;
		onProgress?: (processed: number, total: number) => void;
		onFileStart?: (filePath: string, current: number, total: number) => void;
		errors: string[];
		operation: string;
	}): Promise<void> {
		const batchSize = this.getBatchSize();
		let processedCount = 0;

		await this.metadataWithProgress.updateSnapshotProgress(
			options.snapshotId,
			0,
			options.totalFiles,
		);
		await this.metadata.updateSnapshotProgress(
			options.snapshotId,
			0,
			options.totalFiles,
		);

		for (
			let index = 0;
			index < options.filesToIndex.length;
			index += batchSize
		) {
			const batch = options.filesToIndex.slice(index, index + batchSize);
			const batchStart = processedCount + 1;
			const batchEnd = Math.min(
				processedCount + batch.length,
				options.totalFiles,
			);
			for (const [batchOffset, filePath] of batch.entries()) {
				options.onFileStart?.(
					filePath,
					Math.min(processedCount + batchOffset + 1, options.totalFiles),
					options.totalFiles,
				);
			}
			const preparedData = await Promise.all(
				batch.map(async (filePath) => {
					try {
						const content = await readFile(
							join(options.repoRoot, filePath),
							"utf8",
						);
						return this.prepareFileRecords({
							snapshotId: options.snapshotId,
							projectId: options.projectId,
							filePath,
							content,
							gitRef: options.gitRef,
							knownFiles: options.knownFiles,
						});
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						logger.error(`Error preparing file ${filePath}`, { message });
						options.errors.push(`Failed to prepare ${filePath}: ${message}`);
						return null;
					}
				}),
			);

			const validData = preparedData.filter(
				(value: PreparedFileData | null): value is PreparedFileData =>
					value !== null,
			);
			if (validData.length > 0) {
				try {
					await this.metadata.transaction(async () => {
						for (const data of validData) {
							await this.metadata.upsertFile(
								options.projectId,
								data.fileRecord,
							);
							await this.metadata.replaceChunks(
								options.projectId,
								options.snapshotId,
								data.filePath,
								data.chunkRecords,
							);
							await this.metadata.replaceSymbols(
								options.projectId,
								options.snapshotId,
								data.filePath,
								data.symbolRecords,
							);
							await this.metadata.replaceDependencies(
								options.projectId,
								options.snapshotId,
								data.filePath,
								data.dependencyRecords,
							);
							await this.metadata.upsertFileMetrics(options.projectId, {
								snapshotId: options.snapshotId,
								filePath: data.filePath,
								metrics: data.metrics,
							});
						}
					});
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					throw new Error(
						`Failed while persisting batch [${batchStart}-${batchEnd}] (${batch[0]} .. ${batch[batch.length - 1]}): ${message}`,
					);
				}

				const vectorChunksWithContext = validData.flatMap(
					(data: PreparedFileData) =>
						data.chunkRecords
							.filter((chunk: ChunkRecord) =>
								this.shouldIndexChunkInVectors(chunk),
							)
							.map((chunk: ChunkRecord) => ({
								chunk,
								filePath: data.filePath,
								content: data.chunksContent.get(chunk.chunkId) || "",
							})),
				);

				if (vectorChunksWithContext.length > 0) {
					try {
						const embeddings = await this.embedWithContextGuard(
							vectorChunksWithContext.map(
								(item: { content: string }) => item.content,
							),
							options.operation,
						);

						if (embeddings.length !== vectorChunksWithContext.length) {
							throw new Error(
								`Embedding count mismatch: got ${embeddings.length}, expected ${vectorChunksWithContext.length} chunks`,
							);
						}

						const badIndices: number[] = [];
						for (let i = 0; i < embeddings.length; i++) {
							const emb = embeddings[i];
							if (
								!Array.isArray(emb) ||
								emb.length === 0 ||
								emb.some(
									(v: unknown) =>
										typeof v !== "number" || !Number.isFinite(v as number),
								)
							) {
								badIndices.push(i);
							}
						}

						if (badIndices.length > 0) {
							const affectedFiles = [
								...new Set(
									badIndices.map((i) => vectorChunksWithContext[i].filePath),
								),
							];
							for (const f of affectedFiles) {
								const msg = `Invalid embedding for ${f} — skipped vector indexing`;
								options.errors.push(msg);
								logger.warn(msg);
							}
						}

						const goodChunks = vectorChunksWithContext.filter(
							(_: unknown, i: number) => !badIndices.includes(i),
						);
						const goodEmbeddings = embeddings.filter(
							(_: unknown, i: number) => !badIndices.includes(i),
						);

						if (goodChunks.length > 0) {
							await this.vectors.upsert(
								goodChunks.map(
									(
										item: {
											chunk: ChunkRecord;
											filePath: string;
											content: string;
										},
										index: number,
									) => ({
										projectId: this.projectId,
										chunkId: item.chunk.chunkId,
										snapshotId: options.snapshotId,
										filePath: item.filePath,
										startLine: item.chunk.startLine,
										endLine: item.chunk.endLine,
										embedding: goodEmbeddings[index],
										contentHash: item.chunk.contentHash,
										chunkType: item.chunk.chunkType,
										primarySymbol: item.chunk.primarySymbol,
									}),
								),
							);
						}
					} catch (embedError) {
						const message =
							embedError instanceof Error
								? embedError.message
								: String(embedError);
						const affectedFiles = [
							...new Set(
								validData.map((data: PreparedFileData) => data.filePath),
							),
						];
						for (const f of affectedFiles) {
							const msg = `Embedding failed for ${f}: ${message} — skipped vector indexing`;
							options.errors.push(msg);
							logger.warn(msg);
						}
					}
				}
			}

			processedCount += batch.length;
			options.onProgress?.(
				Math.min(processedCount, options.totalFiles),
				options.totalFiles,
			);
			if (processedCount % 100 === 0 || processedCount >= options.totalFiles) {
				await this.metadataWithProgress.updateSnapshotProgress(
					options.snapshotId,
					processedCount,
					options.totalFiles,
				);
			}
		}
	}

	private getLanguagePlugin(filePath: string): LanguagePlugin | null {
		return this.languagePluginRegistry.findByFilePath(filePath);
	}

	private getLanguageIdFromPath(filePath: string): string {
		const ext = extname(filePath).toLowerCase();
		switch (ext) {
			case ".ts":
			case ".tsx":
			case ".mts":
			case ".cts":
			case ".js":
			case ".jsx":
			case ".mjs":
			case ".cjs":
				return "typescript";
			case ".py":
			case ".pyi":
				return "python";
			case ".cs":
				return "csharp";
			case ".gd":
				return "gdscript";
			case ".rb":
				return "ruby";
			default:
				return "plaintext";
		}
	}

	private normalizePath(filePath: string): string {
		return filePath.replace(/\\/g, "/");
	}

	private async loadChurnByFile(repoRoot: string): Promise<void> {
		try {
			const churn = await this.git.getChurnByFile(repoRoot, { sinceDays: 30 });
			this.churnByFile = new Map(
				Object.entries(churn).map(([filePath, count]) => {
					const normalized = this.normalizePath(filePath);
					return [
						normalized.startsWith("./") ? normalized.slice(2) : normalized,
						count,
					];
				}),
			);
		} catch (error) {
			logger.warn("Failed to load churn data", {
				message: error instanceof Error ? error.message : String(error),
			});
			this.churnByFile = new Map();
		}
	}

	private async scanFiles(rootPath: string): Promise<string[]> {
		return scanProjectFiles(rootPath, this.indexingOptions.codeExtensions);
	}

	private async prepareFileRecords(
		options: IndexFileOptions,
	): Promise<PreparedFileData> {
		const { snapshotId, filePath, content, knownFiles } = options;
		const languagePlugin = this.getLanguagePlugin(filePath);
		let languageId = this.getLanguageIdFromPath(filePath);
		let symbolRecords: SymbolRecord[] = [];
		let dependencyRecords: DependencyRecord[] = [];
		let parsed: unknown;

		if (languagePlugin) {
			parsed = languagePlugin.parse({
				path: filePath,
				content,
				languageHint: languagePlugin.id,
				projectRoot: this.repoRoot,
			});
			languageId = (parsed as { languageId: string }).languageId;

			const symbols = languagePlugin.extractSymbols(parsed as any);
			symbolRecords = symbols.map((symbol: LanguageSymbol) => ({
				snapshotId,
				id: symbol.id,
				filePath,
				kind: symbol.kind,
				name: symbol.name,
				containerName: symbol.containerName,
				exported: symbol.exported,
				range: {
					start: {
						line: symbol.range.startLine,
						character: symbol.range.startCol,
					},
					end: { line: symbol.range.endLine, character: symbol.range.endCol },
				},
				signature: symbol.signature,
				docComment: symbol.docComment,
				metadata: symbol.metadata,
			}));

			const imports = languagePlugin.extractImports(
				parsed as any,
			) as ImportInfo[];
			dependencyRecords = imports.map((dependency) => ({
				...resolveDependency(dependency.spec, filePath, knownFiles, languageId),
				snapshotId,
				id: dependency.id,
				fromPath: filePath,
				toSpecifier: dependency.spec,
				kind: normalizeImportKind(dependency.kind),
			}));
		}

		const chunks = this.deriveLanguageChunks(
			languagePlugin,
			parsed,
			languageId,
			filePath,
			content,
			symbolRecords,
		);
		const chunkRecords: ChunkRecord[] = [];
		const chunksContent = new Map<string, string>();

		for (const chunk of chunks) {
			const chunkId = randomUUID();
			const chunkHash = computeHash(chunk.content);
			chunkRecords.push({
				snapshotId,
				chunkId,
				filePath,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				contentHash: chunkHash,
				tokenEstimate: this.tokenEstimator.estimate(chunk.content),
				chunkType: chunk.chunkType,
				primarySymbol: chunk.primarySymbol,
				hasOverlap: false,
				metadata: chunk.metadata,
			});
			chunksContent.set(chunkId, chunk.content);
		}

		const churn = this.churnByFile.get(this.normalizePath(filePath)) ?? 0;
		return {
			filePath,
			content,
			fileRecord: {
				snapshotId,
				path: filePath,
				sha256: computeHash(content),
				mtimeMs: Date.now(),
				size: content.length,
				languageId,
			},
			chunkRecords,
			chunksContent,
			symbolRecords,
			dependencyRecords,
			metrics: {
				complexity: 0,
				maintainability: 100,
				churn,
				testCoverage: undefined,
			},
		};
	}

	private async createSnapshot(
		projectId: ProjectId,
		gitRef: string,
		status: SnapshotStatus,
	): Promise<{ id: SnapshotId }> {
		const snapshot = await this.metadata.createSnapshot(projectId, {
			headCommit: gitRef,
			indexedAt: Date.now(),
		});
		await this.metadata.updateSnapshotStatus(snapshot.id, status);
		return { id: snapshot.id };
	}

	private async prepareIncrementalSnapshot(options: {
		projectId: ProjectId;
		prevSnapshotId: SnapshotId;
		newSnapshotId: SnapshotId;
		diff: GitDiff;
	}): Promise<void> {
		const prevFiles = await this.metadata.listFiles(
			options.projectId,
			options.prevSnapshotId,
		);
		const modifiedSet = new Set(options.diff.modified);
		const deletedSet = new Set(options.diff.deleted);
		const unchangedFiles = prevFiles
			.filter(
				(file) => !modifiedSet.has(file.path) && !deletedSet.has(file.path),
			)
			.map((file) => file.path);

		if (unchangedFiles.length === 0) {
			return;
		}

		await this.metadata.copyUnchangedFileData(
			options.projectId,
			options.prevSnapshotId,
			options.newSnapshotId,
			unchangedFiles,
		);

		await this.vectors.copyVectors(
			options.projectId,
			options.prevSnapshotId,
			options.newSnapshotId,
			[
				...new Set([
					...options.diff.modified,
					...options.diff.deleted,
					...options.diff.added,
				]),
			],
		);
	}

	private isTransientVectorDeleteError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return (
			(message.includes("LanceError(IO)") &&
				(message.includes("Not found:") ||
					message.includes("Did not find any data files") ||
					message.includes("/vectors.lance/data/"))) ||
			message.includes("Commit conflict for version")
		);
	}

	private async deleteProjectVectorsWithRetry(
		projectId: ProjectId,
	): Promise<void> {
		const delays = [0, 300, 1200];
		for (let attempt = 0; attempt < delays.length; attempt += 1) {
			if (delays[attempt] > 0) {
				await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
			}
			try {
				await this.vectors.deleteByProject(projectId);
				return;
			} catch (error) {
				if (
					!this.isTransientVectorDeleteError(error) ||
					attempt === delays.length - 1
				) {
					throw error;
				}
			}
		}
	}

	private async deleteSnapshotVectorsWithRetry(
		projectId: ProjectId,
		snapshotId: SnapshotId,
	): Promise<void> {
		const delays = [0, 300, 1200];
		for (let attempt = 0; attempt < delays.length; attempt += 1) {
			if (delays[attempt] > 0) {
				await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
			}
			try {
				await this.vectors.deleteBySnapshot(projectId, snapshotId);
				return;
			} catch (error) {
				if (
					!this.isTransientVectorDeleteError(error) ||
					attempt === delays.length - 1
				) {
					throw error;
				}
			}
		}
	}

	private async pruneHistoricalSnapshots(
		projectId: ProjectId,
		keepSnapshotId: SnapshotId,
	): Promise<void> {
		const staleSnapshotIds = await this.listStaleSnapshotIds(
			projectId,
			keepSnapshotId,
		);

		if (staleSnapshotIds.length === 0) {
			return;
		}

		await this.metadata.clearProjectMetadata(projectId, keepSnapshotId, {
			preserveActiveIndexing: true,
		});

		const remainingSnapshots = await this.metadata.listSnapshots(projectId);
		const remainingIds = new Set(remainingSnapshots.map((s) => s.id));

		const confirmedDeletedIds = staleSnapshotIds.filter(
			(id) => !remainingIds.has(id),
		);

		for (const snapshotId of confirmedDeletedIds) {
			await this.deleteSnapshotVectorsWithRetry(projectId, snapshotId);
		}
	}

	private async listStaleSnapshotIds(
		projectId: ProjectId,
		keepSnapshotId: SnapshotId,
	): Promise<SnapshotId[]> {
		const staleSnapshotIds: SnapshotId[] = [];
		const pageSize = 100;

		for (let offset = 0; ; offset += pageSize) {
			const snapshots = await this.metadata.listSnapshots(projectId, {
				limit: pageSize,
				offset,
			});

			for (const snapshot of snapshots) {
				if (snapshot.id !== keepSnapshotId) {
					staleSnapshotIds.push(snapshot.id);
				}
			}

			if (snapshots.length < pageSize) {
				return staleSnapshotIds;
			}
		}
	}

	private async performFullReindex(
		projectId: ProjectId,
		gitRef: string,
		repoRoot: string,
		onProgress?: (processed: number, total: number) => void,
		onFileStart?: (filePath: string, current: number, total: number) => void,
	): Promise<IndexResult> {
		const snapshot = await this.createSnapshot(projectId, gitRef, "indexing");
		const snapshotId = snapshot.id;
		const errors: string[] = [];

		try {
			await this.metadata.clearProjectMetadata(projectId, snapshotId);
			await this.deleteProjectVectorsWithRetry(projectId);
			const filesToIndex = await this.scanFiles(repoRoot);

			if (filesToIndex.length === 0) {
				await this.metadata.updateSnapshotProgress(snapshotId, 0, 0);
				await this.architectureGenerator.generate(projectId, snapshotId);
				await this.metadata.updateSnapshotStatus(snapshotId, "completed");
				return { snapshotId, filesIndexed: 0, errors: [] };
			}

			await this.indexPreparedFiles({
				projectId,
				repoRoot,
				gitRef,
				snapshotId,
				filesToIndex,
				knownFiles: new Set(
					filesToIndex.map((filePath) => this.normalizePath(filePath)),
				),
				totalFiles: filesToIndex.length,
				onProgress,
				onFileStart,
				errors,
				operation: "full reindex batch indexing",
			});

			try {
				await this.architectureGenerator.generate(projectId, snapshotId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed after indexing ${filesToIndex.length} files while generating architecture snapshot: ${message}`,
				);
			}
			await this.metadata.updateSnapshotStatus(snapshotId, "completed");
			await this.metadataWithProgress.updateSnapshotProgress(
				snapshotId,
				filesToIndex.length,
				filesToIndex.length,
			);
			return { snapshotId, filesIndexed: filesToIndex.length, errors };
		} catch (error) {
			await this.metadata.updateSnapshotStatus(
				snapshotId,
				"failed",
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	}

	private getBatchSize(): number {
		const value = config.get("indexBatchSize");
		return Number.isFinite(value) && value > 0 ? value : 50;
	}
}
