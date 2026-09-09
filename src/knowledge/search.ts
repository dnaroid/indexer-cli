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

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"for",
	"how",
	"in",
	"is",
	"of",
	"on",
	"or",
	"the",
	"to",
	"what",
	"where",
	"why",
]);

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
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function terms(value: string): Set<string> {
	const result = new Set<string>();
	for (const token of normalize(value).match(/[\p{L}\p{N}][\p{L}\p{N}._+@:/-]*/gu) ?? []) {
		if (token.length > 1 && !STOP_WORDS.has(token)) result.add(token);
		for (const part of token.split(/[\/_-]+/)) {
			if (part.length > 1 && !STOP_WORDS.has(part)) result.add(part);
		}
	}
	return result;
}

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
		private readonly vectors: VectorStore,
		private readonly embedder: EmbeddingProvider,
		private readonly service: KnowledgeService,
	) {}

	async search(
		query: string,
		options: KnowledgeSearchOptions = {},
	): Promise<KnowledgeSearchResult[]> {
		if (!query.trim()) throw new Error("Knowledge search query must not be empty.");
		const limit = Math.max(1, options.limit ?? 8);
		const [entries, relations, embedding] = await Promise.all([
			this.knowledge.listKnowledgeEntries(this.projectId),
			this.knowledge.listKnowledgeRelations(this.projectId),
			this.embedder.embed([knowledgeQueryEmbeddingText(query)]),
		]);
		const queryEmbedding = embedding[0];
		if (!queryEmbedding) throw new Error("Failed to generate knowledge query embedding.");

		const allowed = entries.filter((entry) => {
			if (entry.classification === "spec" || entry.classification === "spec-like") {
				return true;
			}
			return options.includeSecondary && entry.classification === "design-only";
		});
		const allowedPaths = new Set(allowed.map((entry) => entry.path));
		const vectorResults = await this.vectors.search(
			queryEmbedding,
			Math.max(limit * 8, 40),
			{
				projectId: this.projectId,
				snapshotId: this.snapshotId,
				filePaths: [...allowedPaths],
				pathPrefix: options.pathPrefix,
				domain: "document",
			},
		);
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

		const relationsByPath = new Map<string, KnowledgeRelation[]>();
		for (const relation of relations) {
			const values = relationsByPath.get(relation.sourcePath) ?? [];
			values.push(relation);
			relationsByPath.set(relation.sourcePath, values);
		}

		const scored = await Promise.all(
			allowed
				.filter(
					(entry) =>
						!options.pathPrefix ||
						entry.path === options.pathPrefix ||
						entry.path.startsWith(`${options.pathPrefix.replace(/\/+$/, "")}/`),
				)
				.map(async (entry) => {
					const ranges = (vectorsByPath.get(entry.path) ?? []).sort(
						(left, right) => right.score - left.score,
					);
					const semanticScore = ranges[0]?.score ?? 0;
					const lexical = lexicalScore(
						query,
						entry,
						relationsByPath.get(entry.path) ?? [],
					);
					const status = await this.service.getStatus(entry);
					const secondaryPenalty = entry.classification === "design-only" ? 1 : 0;
					const score =
						semanticScore * 10 +
						lexical.score +
						lifecycleBias(entry) -
						secondaryPenalty;
					return {
						path: entry.path,
						title: entry.title,
						classification: entry.classification,
						behaviorType: entry.behaviorType,
						lifecycle: entry.lifecycle,
						status: status.status,
						score: Number(score.toFixed(3)),
						semanticScore: Number(semanticScore.toFixed(3)),
						lexicalScore: Number(lexical.score.toFixed(3)),
						summary: entry.summary,
						topics: entry.topics,
						reasonCodes: [
							...(semanticScore > 0 ? ["semantic"] : []),
							...lexical.reasons,
						],
						bestRanges: ranges.slice(0, 3),
					};
				}),
		);

		return scored
			.filter((result) => result.semanticScore > 0 || result.lexicalScore > 0)
			.filter((result) => options.minScore === undefined || result.score >= options.minScore)
			.sort(
				(left, right) =>
					right.score - left.score ||
					left.title.localeCompare(right.title) ||
					left.path.localeCompare(right.path),
			)
			.slice(0, limit);
	}
}

