import path from "node:path";
import type { EmbeddingProvider, KnowledgeChunkRecord, KnowledgeStore, MetadataStore, ProjectId, SnapshotId, VectorStore } from "../core/types.js";
import { knowledgeQueryEmbeddingText } from "./embedding.js";
import { KnowledgeLexicalIndex } from "./lexical-index.js";
import type { DocumentMetadata } from "./document-metadata-types.js";
import { isTestFile } from "../engine/searcher.js";

export interface DocumentSearchResult {
	path: string;
	title: string;
	kind: DocumentMetadata["kind"];
	status: DocumentMetadata["status"];
	provenance: { kind: DocumentMetadata["kindSource"]; status: DocumentMetadata["statusSource"] };
	score: number;
	semanticScore: number;
	lexicalScore: number;
	summary: string;
	content?: string;
	reasonCodes: string[];
	bestRanges: Array<{ startLine: number; endLine: number; score: number }>;
	metadata?: DocumentMetadata;
}
export interface DocumentSearchOptions {
	limit?: number;
	mode?: "hybrid" | "semantic" | "lexical";
	pathPrefix?: string;
	filePath?: string;
	minScore?: number;
	includeContent?: boolean;
	chunkTypes?: string[];
	excludeTests?: boolean;
}
export interface DocumentSearchDiagnostics {
	mode: "hybrid" | "semantic" | "lexical";
	semanticAvailable: boolean;
	semanticError?: string;
	lexicalCandidates: number;
	vectorCandidates: number;
	note?: string;
}
type Candidate = { chunk: KnowledgeChunkRecord; lexical: number; semantic: number };
const rangeKey = (file: string, start: number, end: number): string => `${file}\0${start}\0${end}`;

/** Classification describes results; it never controls whether a document is searchable. */
export class DocumentSearchEngine {
	private readonly lexical: KnowledgeLexicalIndex;
	private diagnostics?: DocumentSearchDiagnostics;
	constructor(
		private readonly projectId: ProjectId,
		private readonly snapshotId: SnapshotId,
		private readonly knowledge: KnowledgeStore,
		private readonly vectors: VectorStore | null,
		private readonly embedder: EmbeddingProvider | null,
		_metadata?: MetadataStore,
	) { this.lexical = new KnowledgeLexicalIndex(knowledge); }

	getDiagnostics(): DocumentSearchDiagnostics | undefined { return this.diagnostics; }

	async search(query: string, options: DocumentSearchOptions = {}): Promise<DocumentSearchResult[]> {
		if (!query.trim()) throw new Error("Document search query must not be empty.");
		const mode = options.mode ?? "hybrid";
		const limit = Math.max(1, options.limit ?? 8);
		const prefix = options.pathPrefix?.replace(/\/+$/, "");
		const [hits, chunks] = await Promise.all([
			mode === "semantic" ? [] : this.lexical.search(this.projectId, this.snapshotId, query),
			this.knowledge.listKnowledgeChunks(this.projectId, this.snapshotId),
		]);
		const candidates = new Map<string, Candidate>();
		for (const chunk of chunks) {
			if (options.chunkTypes?.length && !options.chunkTypes.includes(chunk.chunkType)) continue;
			if (options.excludeTests && isTestFile(chunk.filePath)) continue;
			if (prefix && chunk.filePath !== prefix && !chunk.filePath.startsWith(`${prefix}/`)) continue;
			if (options.filePath && chunk.filePath !== options.filePath) continue;
			candidates.set(rangeKey(chunk.filePath, chunk.startLine, chunk.endLine), { chunk, lexical: 0, semantic: 0 });
		}
		for (const hit of hits) {
			const candidate = candidates.get(rangeKey(hit.filePath, hit.startLine, hit.endLine));
			if (candidate) candidate.lexical = hit.score;
		}
		let vectorCount = 0;
		let semanticError: string | undefined;
		if (mode !== "lexical") {
			try {
				if (!this.embedder || !this.vectors) throw new Error("unavailable");
				const [embedding] = await this.embedder.embed([knowledgeQueryEmbeddingText(query)]);
				if (!embedding) throw new Error("empty embedding");
				const vectors = await this.vectors.search(embedding, Math.max(40, limit * 8), {
					projectId: this.projectId, snapshotId: this.snapshotId, domain: "document",
					pathPrefix: prefix, filePath: options.filePath,
				});
				vectorCount = vectors.length;
				for (const hit of vectors) {
					const candidate = candidates.get(rangeKey(hit.filePath, hit.startLine, hit.endLine));
					// Weak nearest neighbours alone are not evidence of relevance.
					if (candidate && Number.isFinite(hit.score) && hit.score > 0.5) candidate.semantic = Math.max(candidate.semantic, Math.min(1, hit.score));
				}
			} catch {
				semanticError = "Document embedding/vector retrieval unavailable";
			}
		}
		this.diagnostics = {
			mode, semanticAvailable: mode !== "lexical" && !semanticError, semanticError,
			lexicalCandidates: hits.length, vectorCandidates: vectorCount,
			note: semanticError && mode === "hybrid" ? `${semanticError}; using lexical results.` : undefined,
		};
		if (mode === "semantic" && semanticError) throw new Error(`Semantic document search unavailable: ${semanticError}`);
		const score = (candidate: Candidate): number => mode === "semantic" ? candidate.semantic : mode === "lexical" ? candidate.lexical : Math.max(candidate.semantic, candidate.lexical * 0.9);
		const files = new Map<string, Candidate[]>();
		for (const candidate of candidates.values()) {
			if (score(candidate) <= 0) continue;
			const values = files.get(candidate.chunk.filePath) ?? [];
			values.push(candidate);
			files.set(candidate.chunk.filePath, values);
		}
		const results: DocumentSearchResult[] = [];
		for (const [filePath, values] of files) {
			values.sort((a, b) => score(b) - score(a) || a.chunk.startLine - b.chunk.startLine);
			const best = values[0];
			if (score(best) < (options.minScore ?? 0)) continue;
			const raw = best.chunk.metadata?.document;
			const document = raw && typeof raw === "object" ? raw as DocumentMetadata : undefined;
			const text = typeof best.chunk.metadata?.searchText === "string" ? best.chunk.metadata.searchText : "";
			results.push({
				path: filePath, title: best.chunk.heading || path.basename(filePath, path.extname(filePath)),
				kind: document?.kind ?? "unknown", status: document?.status ?? "unknown",
				provenance: { kind: document?.kindSource ?? "unknown", status: document?.statusSource ?? "unknown" },
				score: score(best), semanticScore: Math.max(...values.map(v => v.semantic)), lexicalScore: Math.max(...values.map(v => v.lexical)),
				summary: text.replace(/\s+/g, " ").slice(0, 240), ...(options.includeContent ? { content: text } : {}),
				reasonCodes: [...(best.semantic ? ["semantic"] : []), ...(best.lexical ? ["lexical"] : [])],
				bestRanges: values.slice(0, 3).map(v => ({ startLine: v.chunk.startLine, endLine: v.chunk.endLine, score: score(v) })),
				...(document ? { metadata: document } : {}),
			});
		}
		return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
	}
}
