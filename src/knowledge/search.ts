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
	KnowledgeTrustState,
	KnowledgeService,
} from "./service.js";
import { knowledgeQueryEmbeddingText } from "./embedding.js";
import { KnowledgeLexicalIndex, lexicalTerms } from "./lexical-index.js";

export interface KnowledgeSearchResult {
	path: string;
	title: string;
	/** Registered entries are reviewed routing metadata; unreviewed-indexed is fallback evidence only. */
	authority: "registered" | "unreviewed-indexed";
	classification: KnowledgeEntry["classification"] | "unclassified";
	behaviorType: KnowledgeEntry["behaviorType"];
	lifecycle: KnowledgeEntry["lifecycle"];
	status: KnowledgeFreshnessStatus | "unreviewed";
	trust: KnowledgeTrustState | "unreviewed";
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
	/** Fill remaining result slots with indexed documents that have no knowledge entry. */
	includeUnreviewedFallback?: boolean;
	/** Maximum labeled fallback documents to reserve when reviewed results also match. */
	unreviewedFallbackLimit?: number;
}

export interface KnowledgeSearchDiagnostics {
	mode: "hybrid" | "semantic" | "lexical";
	semanticAvailable: boolean;
	semanticError?: string;
	lexicalCandidates: number;
	vectorCandidates: number;
	unreviewedCandidates: number;
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

function pathMatchesPrefix(filePath: string, prefix?: string): boolean {
	if (!prefix) return true;
	const normalized = prefix.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	return filePath === normalized || filePath.startsWith(`${normalized}/`);
}

function fallbackTitle(filePath: string, heading?: string): string {
	if (heading?.trim()) return heading.trim();
	const name = path.basename(filePath, path.extname(filePath));
	return name.replace(/[-_]+/g, " ").trim() || filePath;
}

function fallbackSummary(value: unknown): string {
	if (typeof value !== "string") {
		return "Indexed document content has not been classified or reviewed as project knowledge.";
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return "Indexed document content has not been classified or reviewed as project knowledge.";
	}
	return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239).trimEnd()}…`;
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
		const includeUnreviewedFallback = options.includeUnreviewedFallback ?? true;
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
		const registeredPaths = new Set(entries.map((entry) => entry.path));
		let vectorResults: Awaited<ReturnType<VectorStore["search"]>> = [];
		let unreviewedVectorResults: Awaited<ReturnType<VectorStore["search"]>> = [];
		let semanticError: string | undefined;
		if (mode !== "lexical") {
			try {
				if (!this.embedder || !this.vectors) throw new Error("semantic vector retrieval is unavailable");
				const embedding = await this.embedder.embed([knowledgeQueryEmbeddingText(query)]);
				if (!embedding[0]) throw new Error("failed to generate query embedding");
				vectorResults = await this.vectors.search(embedding[0], Math.max(limit * 8, 40), { projectId: this.projectId, snapshotId: this.snapshotId, filePaths: [...allowedPaths], pathPrefix: options.pathPrefix, domain: "document" });
				if (includeUnreviewedFallback) {
					unreviewedVectorResults = await this.vectors.search(
						embedding[0],
						Math.max(limit * 12, 60),
						{ projectId: this.projectId, snapshotId: this.snapshotId, pathPrefix: options.pathPrefix, domain: "document" },
					);
				}
			} catch (error) { semanticError = error instanceof Error ? error.message : String(error); }
		}
		if (mode === "semantic" && semanticError) throw new Error(`Semantic knowledge search unavailable: ${semanticError}`);
		const coverage = mode === "semantic" ? undefined : await this.lexical.coverage(this.projectId, this.snapshotId);
		this.diagnostics = { mode, semanticAvailable: !semanticError && mode !== "lexical", semanticError, lexicalCandidates: lexicalHits.length, vectorCandidates: vectorResults.length, unreviewedCandidates: 0, note: mode === "lexical" ? `Lexical retrieval uses ${coverage?.chunks ?? 0} indexed document chunks from snapshot ${this.snapshotId}; it is bounded and not exhaustive.` : semanticError && mode === "hybrid" ? `Semantic retrieval degraded to lexical: ${coverage?.chunks ?? 0} indexed document chunks from snapshot ${this.snapshotId}; it is bounded and not exhaustive.` : undefined };
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
						authority: "registered" as const,
						classification: entry.classification,
						behaviorType: entry.behaviorType,
						lifecycle: entry.lifecycle,
						status: "unverified" as KnowledgeFreshnessStatus,
						trust: "default" as KnowledgeTrustState,
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

		const rankedRegistered = scored
			.filter((result) => result.semanticScore > 0 || result.lexicalScore > 0)
			.filter((result) => options.minScore === undefined || result.score >= options.minScore)
			.sort(
				(left, right) =>
					right.score - left.score ||
					left.title.localeCompare(right.title) ||
					left.path.localeCompare(right.path),
			);
		if (!includeUnreviewedFallback) {
			const selected = rankedRegistered.slice(0, limit);
			const selectedEntries = selected.map((result) => allowed.find((entry) => entry.path === result.path)!);
			const batch = this.service as KnowledgeService & { getStatuses?: (values: KnowledgeEntry[]) => Promise<Array<{ path: string; status: KnowledgeFreshnessStatus; trust: KnowledgeTrustState }>> };
			const statuses = batch.getStatuses ? await batch.getStatuses(selectedEntries) : await Promise.all(selectedEntries.map((entry) => this.service.getStatus(entry)));
			const byPath = new Map(statuses.map((status) => [status.path, status]));
			return selected.map((result) => ({
				...result,
				status: byPath.get(result.path)?.status ?? "unverified",
				trust: byPath.get(result.path)?.trust ?? "default",
			}));
		}

		const fallbackVectorsByPath = new Map<string, Array<{ startLine: number; endLine: number; score: number; heading?: string }>>();
		for (const result of unreviewedVectorResults) {
			if (registeredPaths.has(result.filePath) || !pathMatchesPrefix(result.filePath, options.pathPrefix)) continue;
			const values = fallbackVectorsByPath.get(result.filePath) ?? [];
			values.push({ startLine: result.startLine, endLine: result.endLine, score: result.score, heading: result.primarySymbol });
			fallbackVectorsByPath.set(result.filePath, values);
		}
		const fallbackLexicalByPath = new Map<string, Array<{ startLine: number; endLine: number; score: number }>>();
		for (const hit of lexicalHits) {
			if (registeredPaths.has(hit.filePath) || !pathMatchesPrefix(hit.filePath, options.pathPrefix)) continue;
			const values = fallbackLexicalByPath.get(hit.filePath) ?? [];
			values.push(hit);
			fallbackLexicalByPath.set(hit.filePath, values);
		}
		const fallbackPaths = new Set([...fallbackVectorsByPath.keys(), ...fallbackLexicalByPath.keys()]);
		const fallbackScored = [...fallbackPaths].map((filePath) => {
			const ranges = (fallbackVectorsByPath.get(filePath) ?? []).sort((a, b) => b.score - a.score || a.startLine - b.startLine);
			const semanticScore = ranges[0]?.score ?? 0;
			const acceptedRanges = ranges.filter((range) => range.score > (options.semanticMinScore ?? 0.5));
			const acceptedSemantic = acceptedRanges[0]?.score ?? 0;
			const bodyRanges = (fallbackLexicalByPath.get(filePath) ?? []).sort((a, b) => b.score - a.score || a.startLine - b.startLine);
			const bodyScore = mode === "semantic" ? 0 : (bodyRanges[0]?.score ?? 0);
			const score = acceptedSemantic * 10 + bodyScore * 6;
			return {
				filePath,
				score: Number(score.toFixed(3)),
				semanticScore: Number(acceptedSemantic.toFixed(3)),
				lexicalScore: Number((bodyScore * 6).toFixed(3)),
				reasonCodes: [
					"unreviewed-indexed",
					...(acceptedSemantic > 0 ? ["semantic"] : semanticScore > 0 ? ["semantic-abstained"] : []),
					...(bodyScore > 0 ? [`body:${bodyScore.toFixed(2)}`] : []),
				],
				bestRanges: [...acceptedRanges, ...(mode === "semantic" ? [] : bodyRanges)]
					.sort((a, b) => b.score - a.score || a.startLine - b.startLine)
					.slice(0, 3),
				heading: acceptedRanges[0]?.heading ?? ranges[0]?.heading,
			};
		}).filter((result) => result.semanticScore > 0 || result.lexicalScore > 0)
			.filter((result) => options.minScore === undefined || result.score >= options.minScore)
			.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
		this.diagnostics.unreviewedCandidates = fallbackScored.length;
		const defaultFallbackLimit = rankedRegistered.length === 0 ? limit : 1;
		const requestedFallbackLimit = Math.max(
			0,
			Math.floor(options.unreviewedFallbackLimit ?? defaultFallbackLimit),
		);
		const fallbackLimit = fallbackScored.length === 0 || requestedFallbackLimit === 0
			? 0
			: rankedRegistered.length === 0
				? Math.min(limit, requestedFallbackLimit, fallbackScored.length)
				: limit <= 1
					? 0
					: Math.min(limit - 1, requestedFallbackLimit, fallbackScored.length);
		const selected = rankedRegistered.slice(0, limit - fallbackLimit);
		const selectedEntries = selected.map((result) => allowed.find((entry) => entry.path === result.path)!);
		const batch = this.service as KnowledgeService & { getStatuses?: (values: KnowledgeEntry[]) => Promise<Array<{ path: string; status: KnowledgeFreshnessStatus; trust: KnowledgeTrustState }>> };
		const statuses = batch.getStatuses ? await batch.getStatuses(selectedEntries) : await Promise.all(selectedEntries.map((entry) => this.service.getStatus(entry)));
		const byPath = new Map(statuses.map((status) => [status.path, status]));
		const registeredResults = selected.map((result) => ({
			...result,
			status: byPath.get(result.path)?.status ?? "unverified",
			trust: byPath.get(result.path)?.trust ?? "default",
		}));
		if (fallbackLimit === 0) return registeredResults;

		const unreviewedResults = await Promise.all(fallbackScored.slice(0, fallbackLimit).map(async (result): Promise<KnowledgeSearchResult> => {
			const chunks = await this.knowledge.listKnowledgeChunks(this.projectId, this.snapshotId, result.filePath);
			const bestRange = result.bestRanges[0];
			const bestChunk = bestRange
				? chunks.find((chunk) => chunk.startLine === bestRange.startLine && chunk.endLine === bestRange.endLine)
				: undefined;
			const representative = bestChunk ?? chunks.find((chunk) => chunk.heading) ?? chunks[0];
			return {
				path: result.filePath,
				title: fallbackTitle(result.filePath, representative?.heading ?? result.heading),
				authority: "unreviewed-indexed",
				classification: "unclassified",
				behaviorType: "unknown",
				lifecycle: "unknown",
				status: "unreviewed",
				trust: "default",
				score: result.score,
				semanticScore: result.semanticScore,
				lexicalScore: result.lexicalScore,
				summary: fallbackSummary(representative?.metadata?.searchText),
				topics: [],
				reasonCodes: result.reasonCodes,
				bestRanges: result.bestRanges,
			};
		}));
		return [...registeredResults, ...unreviewedResults];
	}
}
