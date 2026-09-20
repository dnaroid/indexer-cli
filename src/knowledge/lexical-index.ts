import type { KnowledgeChunkRecord, KnowledgeStore, ProjectId, SnapshotId } from "../core/types.js";

const STOP_WORDS = new Set(["a", "an", "and", "are", "for", "how", "in", "is", "of", "on", "or", "the", "to", "what", "where", "why"]);
const MAX_SNAPSHOTS = 4;
const MAX_TERMS_PER_CHUNK = 2_000;

export function lexicalTerms(value: string): Set<string> {
	const result = new Set<string>();
	for (const token of value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._+@:/-]*/gu) ?? []) {
		if (token.length > 1 && !STOP_WORDS.has(token)) result.add(token);
		for (const part of token.split(/[\/_-]+/)) if (part.length > 1 && !STOP_WORDS.has(part)) result.add(part);
	}
	return result;
}

export interface LexicalHit { filePath: string; startLine: number; endLine: number; score: number; }
type CachedIndex = { postings: Map<string, KnowledgeChunkRecord[]>; chunks: number };
export interface LexicalIndexCoverage { chunks: number; snapshotId: SnapshotId; }

/** A small immutable-snapshot cache. Text is deliberately read only from chunk metadata. */
export class KnowledgeLexicalIndex {
	private readonly cache = new Map<string, Promise<CachedIndex>>();
	constructor(private readonly knowledge: KnowledgeStore) {}

	async search(projectId: ProjectId, snapshotId: SnapshotId, query: string): Promise<LexicalHit[]> {
		const index = await this.get(projectId, snapshotId);
		const wanted = lexicalTerms(query);
		const counts = new Map<string, { chunk: KnowledgeChunkRecord; count: number }>();
		for (const term of wanted) for (const chunk of index.postings.get(term) ?? []) {
			const prior = counts.get(chunk.chunkId);
			counts.set(chunk.chunkId, { chunk, count: (prior?.count ?? 0) + 1 });
		}
		return [...counts.values()].map(({ chunk, count }) => ({ filePath: chunk.filePath, startLine: chunk.startLine, endLine: chunk.endLine, score: count / Math.max(1, wanted.size) })).sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
	}

	async coverage(projectId: ProjectId, snapshotId: SnapshotId): Promise<LexicalIndexCoverage> {
		return { chunks: (await this.get(projectId, snapshotId)).chunks, snapshotId };
	}

	private async get(projectId: ProjectId, snapshotId: SnapshotId): Promise<CachedIndex> {
		const key = `${projectId}\0${snapshotId}`;
		let pending = this.cache.get(key);
		if (!pending) {
			pending = this.build(projectId, snapshotId);
			this.cache.set(key, pending);
			while (this.cache.size > MAX_SNAPSHOTS) this.cache.delete(this.cache.keys().next().value as string);
		}
		return pending;
	}

	private async build(projectId: ProjectId, snapshotId: SnapshotId): Promise<CachedIndex> {
		const postings = new Map<string, KnowledgeChunkRecord[]>();
		const chunks = await this.knowledge.listKnowledgeChunks(projectId, snapshotId);
		for (const chunk of chunks) {
			const text = typeof chunk.metadata?.searchText === "string" ? chunk.metadata.searchText : "";
			let used = 0;
			for (const term of lexicalTerms(text)) {
				if (used++ >= MAX_TERMS_PER_CHUNK) break;
				const values = postings.get(term) ?? []; values.push(chunk); postings.set(term, values);
			}
		}
		return { postings, chunks: chunks.length };
	}
}
