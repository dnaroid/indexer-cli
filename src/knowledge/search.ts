import path from "node:path";
import type {
	EmbeddingProvider,
	KnowledgeEntry,
	KnowledgeRelation,
	KnowledgeStore,
	MetadataStore,
	ProjectId,
	SnapshotId,
	VectorStore,
} from "../core/types.js";
import type {
	KnowledgeFreshnessStatus,
	KnowledgeService,
} from "./service.js";
import { knowledgeQueryEmbeddingText } from "./embedding.js";
import { KnowledgeLexicalIndex, lexicalTerms } from "./lexical-index.js";

export interface KnowledgeSearchResult {
	path: string;
	title: string;
	classification: KnowledgeEntry["classification"];
	behaviorType: KnowledgeEntry["behaviorType"];
	lifecycle: KnowledgeEntry["lifecycle"];
	status: KnowledgeFreshnessStatus;
	score: number;
	semanticScore: number;
	lexicalScore: number;
	summary: string;
	topics: string[];
	reasonCodes: string[];
	bestRanges: Array<{
		startLine: number;
		endLine: number;
		score: number;
	}>;
}

export interface KnowledgeSearchOptions {
	limit?: number;
	includeSecondary?: boolean;
	pathPrefix?: string;
	minScore?: number;
	/** lexical does not require an embedding provider; hybrid falls back to it on outage. */
	mode?: "hybrid" | "semantic" | "lexical";
	/** Vector scores below this are abstained from rather than treated as relevant. */
	semanticMinScore?: number;
}

export interface KnowledgeSearchDiagnostics {
	mode: "hybrid" | "semantic" | "lexical";
	semanticAvailable: boolean;
	semanticError?: string;
	lexicalCandidates: number;
	vectorCandidates: number;
	note?: string;
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function terms(value: string): Set<string> { return lexicalTerms(value); }

function matchesTerm(query: string, candidate: string): boolean {
	if (query === candidate) return true;
	if (query.length < 4 || candidate.length < 4) return false;
	return candidate.startsWith(query) || query.startsWith(candidate);
}

function countOverlap(queryTerms: Set<string>, value: string): number {
	const candidateTerms = terms(value);
	let count = 0;
	for (const queryTerm of queryTerms) {
		if ([...candidateTerms].some((candidate) => matchesTerm(queryTerm, candidate))) {
			count += 1;
		}
	}
	return count;
}

function relationLeafText(relations: KnowledgeRelation[]): string {
	return relations
		.map((relation) => {
			const name = path.basename(relation.targetPath);
			return `${name} ${path.basename(name, path.extname(name))}`;
		})
		.join(" ");
}

function lexicalScore(
	query: string,
	entry: KnowledgeEntry,
	relations: KnowledgeRelation[],
): { score: number; reasons: string[] } {
	const normalizedQuery = normalize(query);
	const queryTerms = terms(query);
	const fields = {
		title: entry.title,
		topics: entry.topics.join(" "),
		summary: entry.summary,
		path: entry.path,
		relations: relationLeafText(relations),
	};
	let score = 0;
	const reasons: string[] = [];

	if (normalize(entry.path) === normalizedQuery) {
		score += 20;
		reasons.push("exact-path");
	}
	if (
		relations.some((relation) => normalize(relation.targetPath) === normalizedQuery)
	) {
		score += 16;
		reasons.push("exact-relation-path");
	}

	for (const [name, value, weight] of [
		["title", fields.title, 4],
		["topics", fields.topics, 3],
		["summary", fields.summary, 1.25],
		["path", fields.path, 2],
		["relations", fields.relations, 1.5],
	] as const) {
		const overlap = countOverlap(queryTerms, value);
		if (overlap > 0) {
			score += overlap * weight;
			reasons.push(`${name}:${overlap}`);
		}
		if (normalizedQuery.length >= 4 && normalize(value).includes(normalizedQuery)) {
			score += weight * 1.5;
			reasons.push(`${name}-phrase`);
		}
	}
	return { score, reasons };
}

function lifecycleBias(entry: KnowledgeEntry): number {
	return {
		active: 1.5,
		proposed: 0.75,
		unknown: 0,
		historical: -0.5,
		superseded: -1.5,
	}[entry.lifecycle];
}

export class KnowledgeSearchEngine {
	constructor(
		private readonly projectId: ProjectId,
		private readonly snapshotId: SnapshotId,
		private readonly knowledge: KnowledgeStore,
		private readonly metadata: MetadataStore,
		private readonly vectors: VectorStore | null,
		private readonly embedder: EmbeddingProvider | null,
		private readonly service: KnowledgeService,
		private readonly lexical = new KnowledgeLexicalIndex(knowledge),
	) {}
	private diagnostics: KnowledgeSearchDiagnostics | undefined;
	getDiagnostics(): KnowledgeSearchDiagnostics | undefined { return this.diagnostics; }

	async search(
		query: string,
		options: KnowledgeSearchOptions = {},
	): Promise<KnowledgeSearchResult[]> {
		if (!query.trim()) throw new Error("Knowledge search query must not be empty.");
		const limit = Math.max(1, options.limit ?? 8);
		const mode = options.mode ?? "hybrid";
		const [entries, relations, lexicalHits] = await Promise.all([
			this.knowledge.listKnowledgeEntries(this.projectId),
			this.knowledge.listKnowledgeRelations(this.projectId),
			mode === "semantic" ? Promise.resolve([]) : this.lexical.search(this.projectId, this.snapshotId, query),
		]);

		const allowed = entries.filter((entry) => {
			if (entry.classification === "spec" || entry.classification === "spec-like") {
				return true;
			}
			return options.includeSecondary && entry.classification === "design-only";
		});
		const allowedPaths = new Set(allowed.map((entry) => entry.path));
		let vectorResults: Awaited<ReturnType<VectorStore["search"]>> = [];
		let semanticError: string | undefined;
		if (mode !== "lexical") {
			try {
				if (!this.embedder || !this.vectors) throw new Error("semantic vector retrieval is unavailable");
				const embedding = await this.embedder.embed([knowledgeQueryEmbeddingText(query)]);
				if (!embedding[0]) throw new Error("failed to generate query embedding");
				vectorResults = await this.vectors.search(embedding[0], Math.max(limit * 8, 40), { projectId: this.projectId, snapshotId: this.snapshotId, filePaths: [...allowedPaths], pathPrefix: options.pathPrefix, domain: "document" });
			} catch (error) { semanticError = error instanceof Error ? error.message : String(error); }
		}
		if (mode === "semantic" && semanticError) throw new Error(`Semantic knowledge search unavailable: ${semanticError}`);
		const coverage = mode === "semantic" ? undefined : await this.lexical.coverage(this.projectId, this.snapshotId);
		this.diagnostics = { mode, semanticAvailable: !semanticError && mode !== "lexical", semanticError, lexicalCandidates: lexicalHits.length, vectorCandidates: vectorResults.length, note: mode === "lexical" ? `Lexical retrieval uses ${coverage?.chunks ?? 0} indexed document chunks from snapshot ${this.snapshotId}; it is bounded and not exhaustive.` : semanticError && mode === "hybrid" ? `Semantic retrieval degraded to lexical: ${coverage?.chunks ?? 0} indexed document chunks from snapshot ${this.snapshotId}; it is bounded and not exhaustive.` : undefined };
		const vectorsByPath = new Map<
			string,
			Array<{ startLine: number; endLine: number; score: number }>
		>();
		for (const result of vectorResults) {
			if (!allowedPaths.has(result.filePath)) continue;
			const values = vectorsByPath.get(result.filePath) ?? [];
			values.push({
				startLine: result.startLine,
				endLine: result.endLine,
				score: result.score,
			});
			vectorsByPath.set(result.filePath, values);
		}
		const lexicalByPath = new Map<string, Array<{ startLine: number; endLine: number; score: number }>>();
		for (const hit of lexicalHits) {
			if (!allowedPaths.has(hit.filePath)) continue;
			if (options.pathPrefix && !hit.filePath.startsWith(options.pathPrefix.replace(/\/+$/, ""))) continue;
			const values = lexicalByPath.get(hit.filePath) ?? []; values.push(hit); lexicalByPath.set(hit.filePath, values);
		}

		const relationsByPath = new Map<string, KnowledgeRelation[]>();
		for (const relation of relations) {
			const values = relationsByPath.get(relation.sourcePath) ?? [];
			values.push(relation);
			relationsByPath.set(relation.sourcePath, values);
		}

		const scored =
			allowed
				.filter(
					(entry) =>
						!options.pathPrefix ||
						entry.path === options.pathPrefix ||
						entry.path.startsWith(`${options.pathPrefix.replace(/\/+$/, "")}/`),
				)
				.map((entry) => {
					const ranges = (vectorsByPath.get(entry.path) ?? []).sort(
						(left, right) => right.score - left.score,
					);
					const semanticScore = ranges[0]?.score ?? 0;
					// Equality is deliberately abstained: the fixture cutoff is a boundary,
					// not positive relevance evidence for an otherwise unrelated neighbour.
					const acceptedRanges = ranges.filter((range) => range.score > (options.semanticMinScore ?? 0.5));
					const acceptedSemantic = acceptedRanges[0]?.score ?? 0;
					const bodyRanges = (lexicalByPath.get(entry.path) ?? []).sort((a, b) => b.score - a.score || a.startLine - b.startLine);
					const lexical = mode === "semantic" ? { score: 0, reasons: [] as string[] } : lexicalScore(
						query,
						entry,
						relationsByPath.get(entry.path) ?? [],
					);
					const secondaryPenalty = entry.classification === "design-only" ? 1 : 0;
					const bodyScore = bodyRanges[0]?.score ?? 0;
					const score =
						acceptedSemantic * 10 + (mode === "semantic" ? 0 : bodyScore * 6) +
						lexical.score +
						lifecycleBias(entry) -
						secondaryPenalty;
					return {
						path: entry.path,
						title: entry.title,
						classification: entry.classification,
						behaviorType: entry.behaviorType,
						lifecycle: entry.lifecycle,
						status: "unverified" as KnowledgeFreshnessStatus,
						score: Number(score.toFixed(3)),
						semanticScore: Number(acceptedSemantic.toFixed(3)),
						lexicalScore: Number((mode === "semantic" ? 0 : lexical.score + bodyScore * 6).toFixed(3)),
						summary: entry.summary,
						topics: entry.topics,
						reasonCodes: [
							...(acceptedSemantic > 0 ? ["semantic"] : semanticScore > 0 ? ["semantic-abstained"] : []),
							...(bodyScore > 0 ? [`body:${bodyRanges[0]?.score.toFixed(2)}`] : []),
							...lexical.reasons,
						],
						bestRanges: [...acceptedRanges, ...(mode === "semantic" ? [] : bodyRanges)].sort((a, b) => b.score - a.score || a.startLine - b.startLine).slice(0, 3),
					};
				});

		const selected = scored
			.filter((result) => result.semanticScore > 0 || result.lexicalScore > 0)
			.filter((result) => options.minScore === undefined || result.score >= options.minScore)
			.sort(
				(left, right) =>
					right.score - left.score ||
					left.title.localeCompare(right.title) ||
					left.path.localeCompare(right.path),
			)
			.slice(0, limit);
		const selectedEntries = selected.map((result) => allowed.find((entry) => entry.path === result.path)!);
		const batch = this.service as KnowledgeService & { getStatuses?: (values: KnowledgeEntry[]) => Promise<Array<{ path: string; status: KnowledgeFreshnessStatus }>> };
		const statuses = batch.getStatuses ? await batch.getStatuses(selectedEntries) : await Promise.all(selectedEntries.map((entry) => this.service.getStatus(entry)));
		const byPath = new Map(statuses.map((status) => [status.path, status.status]));
		return selected.map((result) => ({ ...result, status: byPath.get(result.path) ?? "unverified" }));
	}
}
