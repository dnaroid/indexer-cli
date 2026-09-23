import type { MetadataStore, ProjectId, SnapshotId } from "../core/types.js";
import type { SearchResult } from "../engine/searcher.js";
import { isTestFile } from "../engine/searcher.js";
import { findNearestTests, type TestHint } from "../cli/test-hints.js";
import { TokenEstimator } from "../utils/token-estimator.js";
import { lexicalTerms } from "./lexical-index.js";
import type { DocumentSearchDiagnostics, DocumentSearchOptions, DocumentSearchResult } from "./search.js";

export interface KnowledgeContextSearch {
	search(query: string, options?: DocumentSearchOptions): Promise<DocumentSearchResult[]>;
	getDiagnostics?(): DocumentSearchDiagnostics | undefined;
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
	pathPrefix?: string;
	maxWarnings?: number;
	mode?: "hybrid" | "semantic" | "lexical";
}

export interface KnowledgeContextPack {
	query: string;
	specs: DocumentSearchResult[];
	/** Other indexed documents remain useful but are not treated as specs. */
	documents?: DocumentSearchResult[];
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
			limit: maxSpecs * 2,
			mode: options.mode,
			pathPrefix: options.pathPrefix,
		});
		const isExplicitActiveSpec = (result: DocumentSearchResult): boolean => result.kind === "spec" && result.status === "active" && result.provenance.kind === "explicit" && result.provenance.status === "explicit";
		const specs = knowledgeResults.filter(isExplicitActiveSpec).slice(0, maxSpecs);
		const documents = knowledgeResults.filter((result) => !isExplicitActiveSpec(result)).slice(0, maxSpecs);
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
		const explicitImplementation = knowledgeResults.flatMap((document) => document.metadata?.references.filter((reference) => reference.role === "implementation").map((reference) => reference.path) ?? []);
		const explicitDocumentTests = knowledgeResults.flatMap((document) => document.metadata?.references.filter((reference) => reference.role === "test").map((reference) => reference.path) ?? []);
		const trackedImplementation = explicitImplementation.filter(
			(filePath) =>
				indexedPaths.has(filePath) && matchesPrefix(filePath, options.pathPrefix),
		);
		const explicitTests = explicitDocumentTests.filter((filePath) =>
			indexedPaths.has(filePath) && matchesPrefix(filePath, options.pathPrefix),
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
					indexedPaths.has(dependency.toPath) &&
					!isTestFile(dependency.toPath) &&
					matchesPrefix(dependency.toPath, options.pathPrefix)
				) {
					graphNeighbors.push({ path: dependency.toPath, reason: "graph" });
				}
			}
			if (dependency.toPath && seedPaths.has(dependency.toPath)) {
				if (
					!seedPaths.has(dependency.fromPath) &&
					indexedPaths.has(dependency.fromPath) &&
					!isTestFile(dependency.fromPath) &&
					matchesPrefix(dependency.fromPath, options.pathPrefix)
				) {
					graphNeighbors.push({ path: dependency.fromPath, reason: "graph" });
				}
			}
		}
		// Declarations are hints, not unconditional priority over query-relevant code.
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
			...nearest.filter((hint) => matchesPrefix(hint.testPath, options.pathPrefix)).map((hint) => ({
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
		const retrievalNote = this.knowledgeSearch.getDiagnostics?.()?.note;
		if (retrievalNote) warnings.push(retrievalNote);
		for (const document of [...specs, ...documents]) warnings.push(...(document.metadata?.warnings ?? []).map((warning) => `${document.path}: ${warning}`));
		const warningLimit = Math.max(1, options.maxWarnings ?? 8);
		if (warnings.length > warningLimit) warnings.splice(warningLimit, warnings.length - warningLimit, `… ${warnings.length - warningLimit} additional warnings`);
		if (specs.length === 0) {
			warnings.push(documents.length > 0 ? `No explicit active spec matched; using ${documents.length} indexed document${documents.length === 1 ? "" : "s"} as context.` : "No indexed document matched the query.");
		}

		const readNext = uniqueByPath([
			...specs.map((spec) => {
					const range = spec.bestRanges[0];
					return {
						path: range ? `${spec.path}:${range.startLine}-${range.endLine}` : spec.path,
				};
			}),
			...documents.map((document) => {
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
			documents,
			implementation,
			tests,
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
	const documents = pack.documents ?? [];
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
		const suffix = `${range ? `:${range.startLine}-${range.endLine}` : ""}${verbose ? ` kind=${spec.kind} status=${spec.status}` : ""}`;
		return row(`S ${spec.path}${suffix}${spec.summary ? ` — ${clip(spec.summary, 160)}` : ""}`, `S ${clip(spec.path)}${suffix}`);
	});
	const indexed = uniqueRows(documents, (document) => {
		const range = document.bestRanges[0];
		const suffix = `${range ? `:${range.startLine}-${range.endLine}` : ""}${verbose ? ` kind=${document.kind} status=${document.status}` : ""}`;
		return row(`D ${document.path}${suffix}${document.summary ? ` — ${clip(document.summary, 160)}` : ""}`, `D ${clip(document.path)}${suffix}`);
	});
	const implementation = uniqueRows(pack.implementation, (item) =>
		row(`C ${item.path}${formatRange(item.startLine, item.endLine)} reason=${item.reason}`, `C ${clip(item.path)}${formatRange(item.startLine, item.endLine)}`),
	);
	const tests = uniqueRows(pack.tests, (test) =>
		row(`T ${test.path} reason=${test.reason} confidence=${test.confidence}`, `T ${clip(test.path)} reason=${test.reason}`),
	);
	const knownEvidencePaths = new Set(emittedPaths);
	for (const item of [...pack.specs, ...documents]) {
		const range = item.bestRanges[0];
		if (range) knownEvidencePaths.add(`${item.path}:${range.startLine}-${range.endLine}`);
	}
	for (const item of pack.implementation) {
		knownEvidencePaths.add(`${item.path}${formatRange(item.startLine, item.endLine)}`);
	}
	const readNext = [...new Set(pack.readNext)].filter((item) => !knownEvidencePaths.has(item));
	const categories: Category[] = [
		{ heading: "Warnings", rows: pack.warnings.map((warning) => row(`! ${warning}`, `! ${clip(warning, 56)}`)) },
		{ heading: "Specifications", rows: specs },
		{ heading: "Documents", rows: indexed },
		{ heading: "Implementation", rows: implementation },
		{ heading: "Tests", rows: tests },
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
		...documents.map((document) => `detail D ${clip(document.title, 72)} — ${clip(document.summary, 120)} provenance=${document.provenance.kind}/${document.provenance.status} why=${document.reasonCodes.join(",") || "none"}`),
	];
	const verboseLines = output.text.split("\n");
	for (const detail of details) {
		if (estimator.estimate([...verboseLines, detail].join("\n")) > budget) break;
		verboseLines.push(detail);
	}
	return `${verboseLines.join("\n")}\n`;
}
