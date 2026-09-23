import type { EmbeddingProvider, KnowledgeStore, MetadataStore, ProjectId, VectorStore } from "../core/types.js";
import type { SearchEngine, SearchOptions, SearchResult } from "./searcher.js";
import { DocumentSearchEngine, type DocumentSearchResult } from "../knowledge/search.js";

export type UnifiedSearchDomain = "all" | "code" | "document";
export type UnifiedSearchResult = ({ domain: "code" } & SearchResult) | ({ domain: "document" } & DocumentSearchResult);
export interface UnifiedSearchOptions extends SearchOptions { domain?: UnifiedSearchDomain; }

export class UnifiedSearchEngine {
	private readonly documents: DocumentSearchEngine;
	private warnings: string[] = [];
	constructor(private readonly code: SearchEngine, projectId: ProjectId, snapshotId: string,
		knowledge: KnowledgeStore, vectors: VectorStore | null, documentEmbedder: EmbeddingProvider | null, metadata?: MetadataStore) {
		this.documents = new DocumentSearchEngine(projectId, snapshotId, knowledge, vectors, documentEmbedder, metadata);
	}
	getDocumentSearch(): DocumentSearchEngine { return this.documents; }
	getWarnings(): string[] { return [...this.warnings]; }

	async search(projectId: ProjectId, snapshotId: string, query: string, options: UnifiedSearchOptions = {}): Promise<UnifiedSearchResult[]> {
		this.warnings = [];
		const domain = options.domain ?? "all";
		const limit = Math.max(1, options.topK ?? 8);
		const mode = options.mode ?? "hybrid";
		const codeSearch = async (): Promise<SearchResult[]> => {
			if (domain === "document") return [];
			try { return await this.code.search(projectId, snapshotId, query, { ...options, mode, topK: limit }); }
			catch (error) {
				if (mode !== "hybrid") throw error;
				this.warnings.push("Code hybrid retrieval unavailable; using lexical results.");
				return this.code.search(projectId, snapshotId, query, { ...options, mode: "lexical", topK: limit });
			}
		};
		const [code, documents] = await Promise.all([
			codeSearch(),
			domain === "code" || (mode === "symbol" && domain !== "document") ? [] : this.documents.search(query, {
				limit, mode: mode === "symbol" ? "lexical" : mode, pathPrefix: options.pathPrefix,
				filePath: options.filePath, minScore: options.minScore, includeContent: options.includeContent,
				chunkTypes: options.chunkTypes, excludeTests: options.excludeTests,
			}),
		]);
		const note = this.documents.getDiagnostics()?.note;
		if (note && domain !== "code") this.warnings.push(note);
		// Preserve relevance scores: being first in a weak domain must not imply confidence 1.
		const tagged: UnifiedSearchResult[] = [
			...code.map(result => ({ ...result, domain: "code" as const })),
			...documents.map(result => ({ ...result, domain: "document" as const })),
		];
		const ranked = tagged.sort((a, b) => b.score - a.score ||
			(a.domain === "code" ? a.filePath : a.path).localeCompare(b.domain === "code" ? b.filePath : b.path));
		const selected = ranked.slice(0, limit);
		// Domain scores are informative, not interchangeable probabilities. Reserve
		// one slot for a relevant missing domain rather than letting common prose
		// matches crowd out all code (or vice versa). Never elevate a weak singleton.
		if (domain === "all" && limit >= 2 && selected.length >= 2 && selected.every(result => result.domain === selected[0].domain)) {
			const alternate = ranked.find(result => result.domain !== selected[0].domain && result.score >= Math.max(0.55, options.minScore ?? 0));
			if (alternate) selected[selected.length - 1] = alternate;
		}
		return selected;
	}
}
