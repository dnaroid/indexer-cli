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
	verbose = false,
): string {
	const budget = Math.max(200, budgetTokens);
	const estimator = new TokenEstimator();
	const unreviewed = pack.unreviewed ?? [];
	const clip = (value: string, max = 40): string => {
		const characters = Array.from(value);
		return characters.length <= max ? value : `${characters.slice(0, Math.max(1, max - 1)).join("")}…`;
	};
	type Row = { text: string; compact: string };
	type Category = { heading: string; rows: Row[] };
	const row = (text: string, compact = text): Row => ({ text, compact });
	const emittedPaths = new Set<string>();
	const uniqueRows = <T extends { path: string }>(
		values: T[],
		format: (value: T) => Row,
	): Row[] => values.map((value) => {
		emittedPaths.add(value.path);
		return format(value);
	});
	const specs = uniqueRows(pack.specs, (spec) => {
		const range = spec.bestRanges[0];
		const suffix = `${range ? `:${range.startLine}-${range.endLine}` : ""} status=${spec.status} trust=${spec.trust}`;
		return row(`S ${spec.path}${suffix}${spec.summary ? ` — ${clip(spec.summary, 160)}` : ""}`, `S ${clip(spec.path)}${suffix}`);
	});
	const indexed = uniqueRows(unreviewed, (document) => {
		const range = document.bestRanges[0];
		const suffix = `${range ? `:${range.startLine}-${range.endLine}` : ""} status=${document.status} trust=${document.trust}`;
		return row(`U ${document.path}${suffix}${document.summary ? ` — ${clip(document.summary, 160)}` : ""}`, `U ${clip(document.path)}${suffix}`);
	});
	const implementation = uniqueRows(pack.implementation, (item) =>
		row(`C ${item.path}${formatRange(item.startLine, item.endLine)} reason=${item.reason}`, `C ${clip(item.path)}${formatRange(item.startLine, item.endLine)}`),
	);
	const tests = uniqueRows(pack.tests, (test) =>
		row(`T ${test.path} reason=${test.reason} confidence=${test.confidence}`, `T ${clip(test.path)} reason=${test.reason}`),
	);
	const relatedKnowledge = pack.relations.filter((relation) => relation.targetKind === "knowledge");
	const knownEvidencePaths = new Set(emittedPaths);
	for (const item of [...pack.specs, ...unreviewed]) {
		const range = item.bestRanges[0];
		if (range) knownEvidencePaths.add(`${item.path}:${range.startLine}-${range.endLine}`);
	}
	for (const item of pack.implementation) {
		knownEvidencePaths.add(`${item.path}${formatRange(item.startLine, item.endLine)}`);
	}
	for (const relation of relatedKnowledge) knownEvidencePaths.add(relation.targetPath);
	const readNext = [...new Set(pack.readNext)].filter((item) => !knownEvidencePaths.has(item));
	const categories: Category[] = [
		{ heading: "Warnings", rows: pack.warnings.map((warning) => row(`! ${warning}`, `! ${clip(warning, 56)}`)) },
		{ heading: "Primary knowledge", rows: specs },
		{ heading: "Indexed knowledge (unreviewed)", rows: indexed },
		{ heading: "Implementation", rows: implementation },
		{ heading: "Tests", rows: tests },
		{ heading: "Knowledge relations", rows: relatedKnowledge.map((relation) =>
			row(`R ${relation.sourcePath} --${relation.relationKind}/${relation.provenance}--> ${relation.targetPath}`, `R ${clip(relation.sourcePath)} --${relation.relationKind}--> ${clip(relation.targetPath)}`),
		) },
		{ heading: "Read next", rows: readNext.map((item) => row(`> ${item}`, `> ${clip(item)}`)) },
	].filter((category) => category.rows.length > 0);
	const selected = categories.map(() => new Set<number>());
	const expanded = categories.map(() => new Set<number>());
	const render = (): { text: string; omitted: number } => {
		const omitted = categories.reduce((count, category, index) => count + category.rows.length - selected[index].size, 0);
		const lines = [`CONTEXT query=${JSON.stringify(clip(pack.query, 48))} budget=${budget}`];
		let clipped = 0;
		for (const [index, category] of categories.entries()) {
			const visible = [...selected[index]].sort((left, right) => left - right);
			if (visible.length === 0) continue;
			const hidden = category.rows.length - visible.length;
			const text = (rowIndex: number): string => {
				const item = category.rows[rowIndex];
				if (expanded[index].has(rowIndex)) return item.text;
				if (item.compact !== item.text) clipped += 1;
				return item.compact;
			};
			lines.push(`${category.heading}: (${category.rows.length}) ${text(visible[0])}${hidden > 0 ? ` … ${hidden} omitted` : ""}`);
			for (const rowIndex of visible.slice(1)) lines.push(`  ${text(rowIndex)}`);
		}
		if (omitted > 0 || clipped > 0) {
			const used = estimator.estimate(lines.join("\n"));
			lines.push(`TRUNC budget=${budget} omitted=${omitted} clipped=${clipped} estimated-used=${used}`);
		}
		return { text: lines.join("\n"), omitted };
	};
	const fits = (): boolean => estimator.estimate(render().text) <= budget;
	const select = (categoryIndex: number, rowIndex: number): boolean => {
		selected[categoryIndex].add(rowIndex);
		if (fits()) return true;
		selected[categoryIndex].delete(rowIndex);
		return false;
	};

	// Reserve one concise row per source category, then spend the remaining budget
	// on every additional selected source that fits.  Do not stop after one miss:
	// a later, shorter row may still fit.
	for (const [index] of categories.entries()) select(index, 0);
	for (let rowIndex = 1; rowIndex < Math.max(...categories.map((category) => category.rows.length)); rowIndex += 1) {
		for (const [index, category] of categories.entries()) {
			if (rowIndex < category.rows.length) select(index, rowIndex);
		}
	}
	// Expand reserved rows only after preserving source coverage. In normal-sized
	// packs this restores exact paths and complete warnings instead of clipping
	// them unconditionally even when most of the token budget is still unused.
	for (const [index] of categories.entries()) {
		for (const rowIndex of selected[index]) {
			expanded[index].add(rowIndex);
			if (!fits()) expanded[index].delete(rowIndex);
		}
	}
	const output = render();
	if (!verbose) return `${output.text}\n`;
	const details = [
		...pack.specs.map((spec) => `detail S ${clip(spec.title, 72)} — ${clip(spec.summary, 120)} why=${spec.reasonCodes.join(",") || "none"}`),
		...unreviewed.map((document) => `detail U ${clip(document.title, 72)} — ${clip(document.summary, 120)} why=${document.reasonCodes.join(",") || "none"}`),
	];
	const verboseLines = output.text.split("\n");
	for (const detail of details) {
		if (estimator.estimate([...verboseLines, detail].join("\n")) > budget) break;
		verboseLines.push(detail);
	}
	return `${verboseLines.join("\n")}\n`;
}
