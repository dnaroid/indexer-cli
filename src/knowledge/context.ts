import type {
	KnowledgeRelation,
	KnowledgeStore,
	MetadataStore,
	ProjectId,
	SnapshotId,
} from "../core/types.js";
import type { SearchResult } from "../engine/searcher.js";
import { isTestFile } from "../engine/searcher.js";
import { findNearestTests, type TestHint } from "../cli/test-hints.js";
import { TokenEstimator } from "../utils/token-estimator.js";
import type {
	KnowledgeSearchOptions,
	KnowledgeSearchResult,
} from "./search.js";

export interface KnowledgeContextSearch {
	search(
		query: string,
		options?: KnowledgeSearchOptions,
	): Promise<KnowledgeSearchResult[]>;
}

export interface CodeContextSearch {
	search(
		projectId: ProjectId,
		snapshotId: string,
		query: string,
		options?: {
			topK?: number;
			mode?: "hybrid" | "semantic" | "lexical" | "symbol";
			pathPrefix?: string;
			includeContent?: boolean;
			includeReasonCodes?: boolean;
			dedupeFile?: boolean;
			excludeTests?: boolean;
		},
	): Promise<SearchResult[]>;
}

export interface KnowledgeContextOptions {
	maxSpecs?: number;
	maxCode?: number;
	maxTests?: number;
	includeSecondary?: boolean;
	pathPrefix?: string;
}

export interface KnowledgeContextPack {
	query: string;
	specs: KnowledgeSearchResult[];
	implementation: Array<{
		path: string;
		startLine?: number;
		endLine?: number;
		score?: number;
		reason: "tracked" | "semantic" | "tracked+semantic" | "graph";
	}>;
	tests: Array<{
		path: string;
		targetPath?: string;
		reason: "explicit" | TestHint["reason"];
		confidence: "high" | "medium" | "low";
	}>;
	relations: KnowledgeRelation[];
	warnings: string[];
	readNext: string[];
}

function uniqueByPath<T extends { path: string }>(values: T[]): T[] {
	const result: T[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value.path)) continue;
		seen.add(value.path);
		result.push(value);
	}
	return result;
}

function relationTargets(
	relations: KnowledgeRelation[],
	relationKind: "implements" | "tests",
): string[] {
	return [
		...new Set(
			relations
				.filter(
					(relation) =>
						relation.targetKind === "code" &&
						relation.relationKind === relationKind,
				)
				.map((relation) => relation.targetPath),
		),
	].sort((left, right) => left.localeCompare(right));
}

function matchesPrefix(filePath: string, prefix?: string): boolean {
	if (!prefix) return true;
	const normalized = prefix.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	return filePath === normalized || filePath.startsWith(`${normalized}/`);
}

export class KnowledgeContextEngine {
	constructor(
		private readonly projectId: ProjectId,
		private readonly snapshotId: SnapshotId,
		private readonly metadata: MetadataStore,
		private readonly knowledge: KnowledgeStore,
		private readonly knowledgeSearch: KnowledgeContextSearch,
		private readonly codeSearch: CodeContextSearch,
	) {}

	async build(
		query: string,
		options: KnowledgeContextOptions = {},
	): Promise<KnowledgeContextPack> {
		if (!query.trim()) throw new Error("Context query must not be empty.");
		const maxSpecs = Math.max(1, options.maxSpecs ?? 4);
		const maxCode = Math.max(1, options.maxCode ?? 6);
		const maxTests = Math.max(0, options.maxTests ?? 4);

		const specs = await this.knowledgeSearch.search(query, {
			limit: maxSpecs,
			includeSecondary: options.includeSecondary,
		});
		const specPaths = new Set(specs.map((spec) => spec.path));
		const allRelations = await this.knowledge.listKnowledgeRelations(this.projectId);
		const relations = allRelations.filter((relation) => specPaths.has(relation.sourcePath));
		const [semanticCode, files, dependencies] = await Promise.all([
			this.codeSearch.search(
				this.projectId,
				this.snapshotId,
				query,
				{
					topK: Math.max(maxCode * 2, 8),
					mode: "hybrid",
					pathPrefix: options.pathPrefix,
					includeContent: false,
					includeReasonCodes: true,
					dedupeFile: true,
					excludeTests: true,
				},
			),
			this.metadata.listFiles(this.projectId, this.snapshotId, { domain: "code" }),
			this.metadata.listDependencies(this.projectId, this.snapshotId),
		]);
		const indexedPaths = new Set(files.map((file) => file.path));
		const trackedImplementation = relationTargets(relations, "implements").filter(
			(filePath) =>
				indexedPaths.has(filePath) && matchesPrefix(filePath, options.pathPrefix),
		);
		const explicitTests = relationTargets(relations, "tests").filter((filePath) =>
			indexedPaths.has(filePath),
		);

		const semanticByPath = new Map(semanticCode.map((result) => [result.filePath, result]));
		const seedImplementation = uniqueByPath([
			...trackedImplementation.map((filePath) => {
				const semantic = semanticByPath.get(filePath);
				return {
					path: filePath,
					startLine: semantic?.startLine,
					endLine: semantic?.endLine,
					score: semantic?.score,
					reason: semantic ? ("tracked+semantic" as const) : ("tracked" as const),
				};
			}),
			...semanticCode.map((result) => ({
				path: result.filePath,
				startLine: result.startLine,
				endLine: result.endLine,
				score: result.score,
				reason: trackedImplementation.includes(result.filePath)
					? ("tracked+semantic" as const)
					: ("semantic" as const),
			})),
		]);

		const graphNeighbors: Array<{
			path: string;
			startLine?: number;
			endLine?: number;
			score?: number;
			reason: "graph";
		}> = [];
		const seedPaths = new Set(seedImplementation.map((item) => item.path));
		for (const dependency of dependencies) {
			if (dependency.toPath && seedPaths.has(dependency.fromPath)) {
				if (
					!seedPaths.has(dependency.toPath) &&
					!isTestFile(dependency.toPath) &&
					matchesPrefix(dependency.toPath, options.pathPrefix)
				) {
					graphNeighbors.push({ path: dependency.toPath, reason: "graph" });
				}
			}
			if (dependency.toPath && seedPaths.has(dependency.toPath)) {
				if (
					!seedPaths.has(dependency.fromPath) &&
					!isTestFile(dependency.fromPath) &&
					matchesPrefix(dependency.fromPath, options.pathPrefix)
				) {
					graphNeighbors.push({ path: dependency.fromPath, reason: "graph" });
				}
			}
		}
		const implementation = uniqueByPath([
			...seedImplementation,
			...graphNeighbors.sort((left, right) => left.path.localeCompare(right.path)),
		]).slice(0, maxCode);
		const implementationPaths = implementation.map((item) => item.path);
		const nearest = findNearestTests({
			targetPaths: implementationPaths,
			files,
			dependencies,
			maxTests: Math.max(maxTests * 2, maxTests),
		});
		const tests = uniqueByPath([
			...explicitTests.map((filePath) => ({
				path: filePath,
				reason: "explicit" as const,
				confidence: "high" as const,
			})),
			...nearest.map((hint) => ({
				path: hint.testPath,
				targetPath: hint.targetPath,
				reason: hint.reason,
				confidence: hint.confidence,
			})),
		]).slice(0, maxTests);

		const warnings: string[] = [];
		for (const spec of specs) {
			if (spec.status !== "fresh") {
				warnings.push(`${spec.path}: ${spec.status}`);
			}
		}
		if (specs.length === 0) warnings.push("No primary knowledge matched the query.");

		const readNext = uniqueByPath([
			...specs
				.filter((spec) => spec.bestRanges[0])
				.map((spec) => {
					const range = spec.bestRanges[0];
					return {
						path: `${spec.path}:${range?.startLine}-${range?.endLine}`,
					};
				}),
			...implementation.map((item) => ({
				path: item.startLine && item.endLine
					? `${item.path}:${item.startLine}-${item.endLine}`
					: item.path,
			})),
			...tests.map((test) => ({ path: test.path })),
		]).map((item) => item.path);

		return {
			query,
			specs,
			implementation,
			tests,
			relations,
			warnings,
			readNext,
		};
	}
}

function formatRange(startLine?: number, endLine?: number): string {
	if (!startLine || !endLine) return "";
	return `:${startLine}-${endLine}`;
}

export function formatKnowledgeContext(
	pack: KnowledgeContextPack,
	budgetTokens = 1400,
): string {
	const budget = Math.max(200, budgetTokens);
	const estimator = new TokenEstimator();
	const lines: string[] = [];
	let used = 0;
	let truncated = false;
	const truncationReserve = estimator.estimate(
		`TRUNC budget=${budget} estimated-used=${budget}\n`,
	);

	const push = (line: string, required = false): boolean => {
		const cost = estimator.estimate(`${line}\n`);
		if (!required && used + cost + truncationReserve > budget) {
			truncated = true;
			return false;
		}
		lines.push(line);
		used += cost;
		return true;
	};

	push(`CONTEXT query=${JSON.stringify(pack.query)} budget=${budget}`, true);
	if (pack.warnings.length > 0) {
		push("Warnings:", true);
		for (const warning of pack.warnings) push(`! ${warning}`, true);
	}

	if (pack.specs.length > 0) {
		push("Primary knowledge:", true);
		for (const spec of pack.specs) {
			if (
				!push(
					`S ${spec.path} status=${spec.status} lifecycle=${spec.lifecycle} score=${spec.score.toFixed(2)}`,
				)
			) {
				break;
			}
			if (spec.summary) push(`  ${spec.summary}`);
			const range = spec.bestRanges[0];
			if (range) push(`  Read: ${spec.path}:${range.startLine}-${range.endLine}`);
		}
	}

	if (pack.implementation.length > 0) {
		push("Implementation:");
		for (const item of pack.implementation) {
			if (
				!push(
					`C ${item.path}${formatRange(item.startLine, item.endLine)} reason=${item.reason}${typeof item.score === "number" ? ` score=${item.score.toFixed(2)}` : ""}`,
				)
			) {
				break;
			}
		}
	}

	if (pack.tests.length > 0) {
		push("Tests:");
		for (const test of pack.tests) {
			if (
				!push(
					`T ${test.path}${test.targetPath ? ` -> ${test.targetPath}` : ""} reason=${test.reason} conf=${test.confidence}`,
				)
			) {
				break;
			}
		}
	}

	const relatedKnowledge = pack.relations.filter(
		(relation) => relation.targetKind === "knowledge",
	);
	if (relatedKnowledge.length > 0) {
		push("Related knowledge:");
		for (const relation of relatedKnowledge) {
			if (
				!push(
					`R ${relation.sourcePath} -[${relation.relationKind}/${relation.provenance}]-> ${relation.targetPath}`,
				)
			) {
				break;
			}
		}
	}

	if (pack.readNext.length > 0) {
		push("Read next:");
		for (const item of pack.readNext) {
			if (!push(`> ${item}`)) break;
		}
	}

	if (truncated) push(`TRUNC budget=${budget} estimated-used=${used}`, true);
	return `${lines.join("\n")}\n`;
}
