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
import { lexicalTerms } from "./lexical-index.js";
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
	maxWarnings?: number;
	mode?: "hybrid" | "semantic" | "lexical";
}

export interface KnowledgeContextPack {
	query: string;
	specs: KnowledgeSearchResult[];
	/** Indexed document matches without a reviewed knowledge entry. Never authoritative. */
	unreviewed?: KnowledgeSearchResult[];
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
	];
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

		const knowledgeResults = await this.knowledgeSearch.search(query, {
			// Search gets one extra slot so a labeled fallback does not reduce maxSpecs.
			limit: maxSpecs + 1,
			includeSecondary: options.includeSecondary,
			mode: options.mode,
		});
		const specs = knowledgeResults
			.filter((result) => result.authority !== "unreviewed-indexed")
			.slice(0, maxSpecs);
		const unreviewedCandidates = knowledgeResults.filter(
			(result) => result.authority === "unreviewed-indexed",
		);
		const unreviewed = unreviewedCandidates.slice(0, specs.length === 0 ? maxSpecs : 1);
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
					mode: options.mode ?? "hybrid",
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
		// Relations are provenance, not unconditional priority.  A late path with a
		// strong code/query match must outrank unrelated tracked paths.
		const queryTerms = lexicalTerms(query);
		const pathScore = (filePath: string) => [...queryTerms].filter((term) => lexicalTerms(filePath).has(term)).length;
		const implementation = uniqueByPath([
			...seedImplementation,
			...graphNeighbors.sort((left, right) => left.path.localeCompare(right.path)),
		]).sort((left, right) => {
			const leftRank = (left.score ?? 0) * 10 + pathScore(left.path) + (left.reason === "tracked+semantic" ? 2 : left.reason === "tracked" ? 1 : 0);
			const rightRank = (right.score ?? 0) * 10 + pathScore(right.path) + (right.reason === "tracked+semantic" ? 2 : right.reason === "tracked" ? 1 : 0);
			return rightRank - leftRank || left.path.localeCompare(right.path);
		}).slice(0, maxCode);
		const implementationPaths = implementation.map((item) => item.path);
		const nearest = findNearestTests({
			targetPaths: implementationPaths,
			files,
			dependencies,
			maxTests: Math.max(maxTests * 2, maxTests),
		});
		const nearestByPath = new Map(nearest.map((hint) => [hint.testPath, hint]));
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
		]).sort((left, right) => {
			const leftHint = nearestByPath.get(left.path);
			const rightHint = nearestByPath.get(right.path);
			const leftRank = (leftHint?.score ?? 50) + pathScore(left.path) + pathScore("targetPath" in left ? left.targetPath : "");
			const rightRank = (rightHint?.score ?? 50) + pathScore(right.path) + pathScore("targetPath" in right ? right.targetPath : "");
			return rightRank - leftRank || left.path.localeCompare(right.path);
		}).slice(0, maxTests);

		const warnings: string[] = [];
		for (const spec of specs) {
			if (spec.status !== "fresh") {
				warnings.push(
					`${spec.path}: ${spec.status}; ${spec.trust === "explicit" ? "explicitly trusted" : "trusted by default"}, verification may be stale or absent`,
				);
			}
		}
		for (const document of unreviewed) {
			warnings.push(`${document.path}: trusted by default but unreviewed indexed document; content may be stale or incorrect`);
		}
		const warningLimit = Math.max(1, options.maxWarnings ?? 8);
		if (warnings.length > warningLimit) warnings.splice(warningLimit, warnings.length - warningLimit, `… ${warnings.length - warningLimit} additional stale knowledge warnings`);
		if (specs.length === 0) {
			warnings.push(unreviewed.length > 0
				? `No registered primary knowledge matched the query; using ${unreviewed.length} default-trusted unreviewed indexed document${unreviewed.length === 1 ? "" : "s"} as knowledge evidence.`
				: "No primary knowledge matched the query.");
		}

		const readNext = uniqueByPath([
			...specs.map((spec) => {
					const range = spec.bestRanges[0];
					return {
						path: range ? `${spec.path}:${range.startLine}-${range.endLine}` : spec.path,
				};
			}),
			...unreviewed.map((document) => {
				const range = document.bestRanges[0];
				return {
					path: range ? `${document.path}:${range.startLine}-${range.endLine}` : document.path,
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
			unreviewed,
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
	const unreviewed = pack.unreviewed ?? [];
	const lines: string[] = [];
	let used = 0;
	let omitted = 0;
	const footerReserve = estimator.estimate(`TRUNC budget=${budget} omitted=999999 estimated-used=${budget}\n`);
	const clip = (value: string, max = 72): string =>
		value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
	const push = (line: string): boolean => {
		const next = estimator.estimate([...lines, line].join("\n"));
		if (next + footerReserve + 1 > budget) return false;
		lines.push(line);
		used = next;
		return true;
	};

	push(`CONTEXT query=${JSON.stringify(clip(pack.query, 80))} budget=${budget}`);
	// Reserve concise evidence from each nonempty primary source before details.
	// Counts remain visible even when the source path itself must be clipped.
	const compact = (heading: string, total: number, row: string) => {
		omitted += Math.max(0, total - 1);
		return push(`${heading}: (${total}) ${row}${total > 1 ? ` … ${total - 1} omitted` : ""}`);
	};
	if (pack.warnings.length && !compact("Warnings", pack.warnings.length, `! ${clip(pack.warnings[0])}`)) omitted += pack.warnings.length;
	if (pack.specs.length && !compact("Primary knowledge", pack.specs.length, `S ${clip(pack.specs[0].path)} status=${pack.specs[0].status} trust=${pack.specs[0].trust}`)) omitted += pack.specs.length;
	if (unreviewed.length && !compact("Indexed knowledge (unreviewed)", unreviewed.length, `U ${clip(unreviewed[0].path)} status=unreviewed trust=${unreviewed[0].trust}`)) omitted += unreviewed.length;
	if (pack.implementation.length && !compact("Implementation", pack.implementation.length, `C ${clip(pack.implementation[0].path)}${formatRange(pack.implementation[0].startLine, pack.implementation[0].endLine)} reason=${pack.implementation[0].reason}`)) omitted += pack.implementation.length;
	if (pack.tests.length && !compact("Tests", pack.tests.length, `T ${clip(pack.tests[0].path)} reason=${pack.tests[0].reason}`)) omitted += pack.tests.length;

	for (const spec of pack.specs) {
		if (spec.summary && !push(`  S ${clip(spec.path, 48)}: ${clip(spec.summary, 160)}`)) omitted += 1;
		const range = spec.bestRanges[0];
		if (range && !push(`  Read: ${clip(spec.path)}:${range.startLine}-${range.endLine}`)) omitted += 1;
	}
	for (const document of unreviewed) {
		if (document.summary && !push(`  U ${clip(document.path, 48)}: ${clip(document.summary, 160)}`)) omitted += 1;
		const range = document.bestRanges[0];
		if (range && !push(`  Read (unreviewed): ${clip(document.path)}:${range.startLine}-${range.endLine}`)) omitted += 1;
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
				omitted += 1;
				break;
			}
		}
	}

	if (pack.readNext.length > 0) {
		push("Read next:");
		for (const item of pack.readNext) {
			if (!push(`> ${clip(item)}`)) { omitted += 1; break; }
		}
	}

	if (omitted > 0) lines.push(`TRUNC budget=${budget} omitted=${omitted} estimated-used=${used}`);
	return `${lines.join("\n")}\n`;
}
