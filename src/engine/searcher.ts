import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	MetadataStore,
	VectorStore,
	EmbeddingProvider,
	ProjectId,
	VectorSearchFilters,
} from "../core/types.js";
import { SystemLogger } from "../core/logger.js";

const logger = new SystemLogger("search");

export interface SearchOptions {
	topK?: number;
	pathPrefix?: string;
	chunkTypes?: string[];
	filePath?: string;
	includeContent?: boolean;
	minScore?: number;
}

export interface SearchResult {
	filePath: string;
	startLine: number;
	endLine: number;
	score: number;
	chunkType?: string;
	primarySymbol?: string;
	content?: string;
}

export class SearchEngine {
	constructor(
		private metadata: MetadataStore,
		private vectors: VectorStore,
		private embedder: EmbeddingProvider,
		private repoRoot: string,
	) {}

	async search(
		projectId: ProjectId,
		snapshotId: string,
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResult[]> {
		const topK = options.topK ?? 10;
		const includeContent = options.includeContent ?? true;
		const minScore = options.minScore;

		logger.info(`Searching for "${query}" (topK=${topK})`);

		const queryEmbedding = (await this.embedder.embed([query]))[0];
		if (!queryEmbedding) {
			throw new Error("Failed to generate query embedding");
		}

		const filters: VectorSearchFilters = {
			projectId,
			snapshotId,
			filePath: options.filePath,
			pathPrefix: options.pathPrefix,
			chunkTypes: options.chunkTypes,
		};

		const vectorResults = await this.vectors.search(
			queryEmbedding,
			topK,
			filters,
		);

		const results: SearchResult[] = [];
		for (const vr of vectorResults) {
			if (typeof minScore === "number" && vr.score < minScore) {
				continue;
			}

			let content: string | undefined;
			if (includeContent) {
				try {
					const fullPath = join(this.repoRoot, vr.filePath);
					const fileContent = await readFile(fullPath, "utf-8");
					const lines = fileContent.split("\n");
					const start = Math.max(0, vr.startLine - 1);
					const end = Math.min(lines.length, vr.endLine);
					content = lines.slice(start, end).join("\n");
				} catch (err) {
					logger.warn(`Failed to read ${vr.filePath}:`, err);
					content = "";
				}
			}

			results.push({
				filePath: vr.filePath,
				startLine: vr.startLine,
				endLine: vr.endLine,
				score: vr.score,
				chunkType: vr.chunkType,
				primarySymbol: vr.primarySymbol,
				content,
			});
		}

		return results;
	}
}
