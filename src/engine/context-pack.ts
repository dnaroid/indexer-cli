import type {
	ContextPackIntent,
	ContextPackProfile,
	ContextPackResult,
	FileRecord,
	GitOperations,
	MetadataStore,
	ModuleGoal,
	PackMeta,
	ProjectId,
	SnapshotId,
	SymbolRecord,
} from "../core/types.js";
import type { SearchEngine } from "./searcher.js";
import {
	filterArchitectureSnapshot,
	type ArchitectureSnapshot,
} from "./architecture.js";

type ContextPackScope =
	| { kind: "all" }
	| { kind: "changed" }
	| { kind: "relevant-to"; value: string }
	| { kind: "path-prefix"; value: string };

type ContextPackSearch = Pick<SearchEngine, "search">;
type SearchHit = Awaited<ReturnType<ContextPackSearch["search"]>>[number];

export type ContextPackBuildOptions = {
	budget?: number;
	profile?: ContextPackProfile;
	scope?: string;
	maxModules?: number;
	maxFiles?: number;
	maxSnippets?: number;
	minScore?: number;
	explainSymbols?: boolean;
	excludePathPatterns?: string[];
	includeFixtures?: boolean;
};

type ResolvedContextPackOptions = {
	budget: number;
	profile: ContextPackProfile;
	scope: ContextPackScope;
	maxModules: number;
	maxFiles: number;
	maxSnippets: number;
	minScore?: number;
	explainSymbols: boolean;
	excludePathPatterns: string[];
	includeFixtures: boolean;
	evidenceThreshold: number;
	searchTopK: number;
};

type ModuleMetric = {
	module: string;
	maxSemanticScore: number;
	hitCount: number;
	symbolOverlap: number;
	dependencyProximity: number;
	pathPrior: number;
	changedBoost: number;
	fileCount: number;
	reasons: string[];
};

export type ScoredModule = {
	module: string;
	score: number;
	reasons: string[];
	metrics: Omit<ModuleMetric, "module" | "reasons">;
};

const PROFILE_DEFAULTS: Record<
	ContextPackProfile,
	{
		budget: number;
		maxModules: number;
		maxFiles: number;
		maxSnippets: number;
		evidenceThreshold: number;
		searchTopK: number;
	}
> = {
	routing: {
		budget: 800,
		maxModules: 2,
		maxFiles: 4,
		maxSnippets: 1,
		evidenceThreshold: 0.55,
		searchTopK: 6,
	},
	balanced: {
		budget: 1500,
		maxModules: 3,
		maxFiles: 6,
		maxSnippets: 2,
		evidenceThreshold: 0.68,
		searchTopK: 10,
	},
	deep: {
		budget: 2500,
		maxModules: 4,
		maxFiles: 8,
		maxSnippets: 3,
		evidenceThreshold: 0.8,
		searchTopK: 14,
	},
};

const PROFILE_BY_BUDGET: Record<number, ContextPackProfile> = {
	800: "routing",
	1500: "balanced",
	2500: "deep",
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function estimateTokens(data: unknown): number {
	return Math.ceil(JSON.stringify(data).length / 4);
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function tokenizeTask(task: string): string[] {
	return task
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 3);
}

export function normalizeContextPackIntent(task: string): ContextPackIntent {
	const input = task.toLowerCase();

	if (/(fix|bug|broken|error|fail|failing|regress|issue)/.test(input)) {
		return "bugfix";
	}
	if (/(add|implement|feature|support|enable|create|introduce)/.test(input)) {
		return "feature";
	}
	if (/(refactor|cleanup|clean up|rename|restructure|simplify)/.test(input)) {
		return "refactor";
	}
	if (
		/(investigate|investigation|look into|understand|explore|why|how|trace)/.test(
			input,
		)
	) {
		return "investigation";
	}

	return "unknown";
}

function parseScope(scope?: string): ContextPackScope {
	const value = scope?.trim() || "all";
	if (value === "all") {
		return { kind: "all" };
	}
	if (value === "changed") {
		return { kind: "changed" };
	}
	if (value.startsWith("relevant-to:")) {
		const scopeValue = normalizePath(value.slice("relevant-to:".length).trim());
		if (!scopeValue) {
			throw new Error("--scope relevant-to:<path> requires a non-empty path.");
		}
		return {
			kind: "relevant-to",
			value: scopeValue,
		};
	}
	if (value.startsWith("path-prefix:")) {
		const scopeValue = normalizePath(value.slice("path-prefix:".length).trim());
		if (!scopeValue) {
			throw new Error("--scope path-prefix:<path> requires a non-empty path.");
		}
		return {
			kind: "path-prefix",
			value: scopeValue,
		};
	}

	throw new Error(
		"--scope must be one of: all, changed, relevant-to:<path>, path-prefix:<path>.",
	);
}

export function buildContextPackProfile(
	options: ContextPackBuildOptions = {},
): ResolvedContextPackOptions {
	const budgetProfile =
		typeof options.budget === "number"
			? PROFILE_BY_BUDGET[options.budget]
			: undefined;
	if (options.profile && budgetProfile && options.profile !== budgetProfile) {
		throw new Error(
			`--budget ${options.budget} only matches the ${budgetProfile} profile. Remove one of the options or use a matching pair.`,
		);
	}

	const profile = options.profile ?? budgetProfile ?? "balanced";
	const defaults = PROFILE_DEFAULTS[profile];

	return {
		budget: options.budget ?? defaults.budget,
		profile,
		scope: parseScope(options.scope),
		maxModules: Math.max(1, options.maxModules ?? defaults.maxModules),
		maxFiles: Math.max(1, options.maxFiles ?? defaults.maxFiles),
		maxSnippets: Math.max(1, options.maxSnippets ?? defaults.maxSnippets),
		minScore: options.minScore,
		explainSymbols: Boolean(options.explainSymbols),
		excludePathPatterns: options.excludePathPatterns ?? [],
		includeFixtures: Boolean(options.includeFixtures),
		evidenceThreshold: defaults.evidenceThreshold,
		searchTopK: Math.max(
			defaults.searchTopK,
			(options.maxFiles ?? defaults.maxFiles) * 2,
		),
	};
}

function isExplicitScope(scope: ContextPackScope): boolean {
	return scope.kind !== "all";
}

export function inferContextPackConfidenceBand(
	confidence: number,
): PackMeta["confidenceBand"] {
	if (confidence >= 0.75) {
		return "high";
	}
	if (confidence >= 0.45) {
		return "medium";
	}
	return "low";
}

export function scoreContextPackModules(
	metrics: ModuleMetric[],
): ScoredModule[] {
	return metrics
		.map((metric) => {
			const density = clamp(metric.hitCount / 3, 0, 1);
			const score = clamp(
				metric.maxSemanticScore * 0.35 +
					density * 0.15 +
					metric.symbolOverlap * 0.15 +
					metric.dependencyProximity * 0.15 +
					metric.pathPrior * 0.1 +
					metric.changedBoost * 0.1,
				0,
				1,
			);

			return {
				module: metric.module,
				score,
				reasons: metric.reasons,
				metrics: {
					maxSemanticScore: metric.maxSemanticScore,
					hitCount: metric.hitCount,
					symbolOverlap: metric.symbolOverlap,
					dependencyProximity: metric.dependencyProximity,
					pathPrior: metric.pathPrior,
					changedBoost: metric.changedBoost,
					fileCount: metric.fileCount,
				},
			};
		})
		.sort((left, right) => right.score - left.score);
}

function getPathPrior(
	moduleKey: string,
	tokens: string[],
	intent: ContextPackIntent,
): number {
	const lower = moduleKey.toLowerCase();
	let prior = 0;

	if (tokens.some((token) => ["cli", "command", "commands"].includes(token))) {
		prior = Math.max(prior, lower.includes("cli") ? 0.9 : 0);
	}
	if (
		tokens.some((token) =>
			[
				"search",
				"context",
				"architecture",
				"dependency",
				"deps",
				"index",
			].includes(token),
		)
	) {
		prior = Math.max(prior, lower.includes("engine") ? 0.9 : 0);
	}
	if (tokens.some((token) => ["config", "types", "logger"].includes(token))) {
		prior = Math.max(prior, lower.includes("core") ? 0.85 : 0);
	}
	if (
		tokens.some((token) =>
			["storage", "sqlite", "vector", "db"].includes(token),
		)
	) {
		prior = Math.max(prior, lower.includes("storage") ? 0.9 : 0);
	}
	if (intent === "bugfix" && /test|fixture/.test(lower)) {
		prior = Math.max(prior, 0.3);
	}

	return prior;
}

function scoreSymbolOverlap(symbols: SymbolRecord[], tokens: string[]): number {
	if (tokens.length === 0 || symbols.length === 0) {
		return 0;
	}

	const haystack = symbols
		.map((symbol) => `${symbol.name} ${symbol.signature ?? ""}`.toLowerCase())
		.join(" ");
	const overlapCount = tokens.filter((token) =>
		haystack.includes(token),
	).length;
	return clamp(overlapCount / Math.min(tokens.length, 4), 0, 1);
}

function inferModuleGoal(
	moduleKey: string,
	symbols: SymbolRecord[],
	hasSemanticHits: boolean,
): { goal: string; evidenceSources: string[] } {
	const lower = moduleKey.toLowerCase();
	const evidenceSources = ["path layout"];
	if (hasSemanticHits) {
		evidenceSources.push("semantic hits");
	}

	if (lower.includes("cli") && lower.includes("command")) {
		evidenceSources.push("command path heuristic");
		return {
			goal: "CLI command surface and orchestration",
			evidenceSources,
		};
	}
	if (lower.includes("engine")) {
		evidenceSources.push("engine path heuristic");
		return {
			goal: "Engine and discovery orchestration logic",
			evidenceSources,
		};
	}
	if (lower.includes("core")) {
		evidenceSources.push("core path heuristic");
		return {
			goal: "Shared core types, config, and support utilities",
			evidenceSources,
		};
	}
	if (lower.includes("storage")) {
		evidenceSources.push("storage path heuristic");
		return {
			goal: "Storage and persistence layer",
			evidenceSources,
		};
	}

	const exportedSymbol = symbols.find((symbol) => symbol.exported);
	if (exportedSymbol) {
		evidenceSources.push("exported symbols");
		return {
			goal: `Module centered on ${exportedSymbol.name}`,
			evidenceSources,
		};
	}

	return {
		goal: `Implementation area for ${moduleKey}`,
		evidenceSources,
	};
}

function unique<T>(values: T[]): T[] {
	return Array.from(new Set(values));
}

function pickSelectedModules(
	scoredModules: ScoredModule[],
	maxModules: number,
): ScoredModule[] {
	const top = scoredModules.slice(0, Math.max(1, maxModules));
	if (top.length <= 1) {
		return top;
	}

	const bestScore = top[0]?.score ?? 0;
	return top.filter(
		(entry, index) => index === 0 || bestScore - entry.score <= 0.08,
	);
}

function createFallbackScores(
	moduleFiles: Record<string, string[]>,
	tokens: string[],
	intent: ContextPackIntent,
): ScoredModule[] {
	return Object.entries(moduleFiles)
		.map(([module, filePaths]) => ({
			module,
			score: clamp(
				getPathPrior(module, tokens, intent) +
					Math.min(filePaths.length / 10, 0.25),
				0.05,
				0.45,
			),
			reasons: ["weak semantic signal; falling back to broad module coverage"],
			metrics: {
				maxSemanticScore: 0,
				hitCount: 0,
				symbolOverlap: 0,
				dependencyProximity: 0,
				pathPrior: getPathPrior(module, tokens, intent),
				changedBoost: 0,
				fileCount: filePaths.length,
			},
		}))
		.sort((left, right) => right.score - left.score);
}

type ScopeResolution = {
	filePaths: Set<string> | null;
	pathPrefix?: string;
	why: string[];
};

function resolveRelevantScopeFiles(
	value: string,
	architecture: ArchitectureSnapshot,
): ScopeResolution {
	const target = normalizePath(value);
	const moduleFiles = architecture.module_files ?? {};
	const dependencyMap = architecture.dependency_map?.internal ?? {};
	const targetModule = Object.entries(moduleFiles).find(([, filePaths]) =>
		filePaths.some(
			(filePath) => filePath === target || filePath.startsWith(`${target}/`),
		),
	)?.[0];

	if (!targetModule) {
		return {
			filePaths: null,
			why: [`No module matched ${target}; using global routing instead`],
		};
	}

	const relatedModules = new Set<string>([
		targetModule,
		...(dependencyMap[targetModule] ?? []),
		...Object.entries(dependencyMap)
			.filter(([, dependencies]) => dependencies.includes(targetModule))
			.map(([fromModule]) => fromModule),
	]);

	return {
		filePaths: new Set(
			Array.from(relatedModules).flatMap(
				(moduleKey) => moduleFiles[moduleKey] ?? [],
			),
		),
		why: [
			`Expanded relevant-to scope around ${targetModule}`,
			"Included immediate dependency neighborhood for better routing",
		],
	};
}

function buildArchitectureSlice(
	selectedModuleKeys: string[],
	architecture: ArchitectureSnapshot,
	fileToModuleKey: Map<string, string>,
	maxModules: number,
): ContextPackResult["architecture_slice"] {
	const internalMap = architecture.dependency_map?.internal ?? {};
	const related = new Set<string>(selectedModuleKeys);

	for (const moduleKey of selectedModuleKeys) {
		for (const toModule of internalMap[moduleKey] ?? []) {
			if (related.size >= maxModules + 2) {
				break;
			}
			related.add(toModule);
		}
		for (const [fromModule, toModules] of Object.entries(internalMap)) {
			if (toModules.includes(moduleKey) && related.size < maxModules + 2) {
				related.add(fromModule);
			}
		}
	}

	const relatedModules = Array.from(related).sort();
	return {
		entrypoints: (architecture.entrypoints ?? [])
			.filter((filePath) => related.has(fileToModuleKey.get(filePath) ?? ""))
			.slice(0, 5),
		relatedModules,
		dependencies: relatedModules
			.flatMap((from) =>
				(internalMap[from] ?? [])
					.filter((to) => related.has(to))
					.map((to) => ({ from, to })),
			)
			.slice(0, maxModules * 3),
	};
}

function buildStructureSlice(args: {
	selectedModuleKeys: string[];
	fileToModuleKey: Map<string, string>;
	visibleFiles: FileRecord[];
	visibleSymbols: SymbolRecord[];
	hitFilePaths: string[];
	maxFiles: number;
	explainSymbols: boolean;
	tokens: string[];
}): ContextPackResult["structure_slice"] {
	const selectedModules = new Set(args.selectedModuleKeys);
	const fileByPath = new Map(
		args.visibleFiles.map((file) => [file.path, file]),
	);
	const selectedFiles = args.visibleFiles.filter((file) =>
		selectedModules.has(args.fileToModuleKey.get(file.path) ?? ""),
	);
	const exportedFiles = new Set(
		args.visibleSymbols
			.filter((symbol) => symbol.exported)
			.map((symbol) => symbol.filePath),
	);
	const filePaths = unique([
		...args.hitFilePaths,
		...selectedFiles
			.filter((file) => exportedFiles.has(file.path))
			.map((file) => file.path),
		...selectedFiles.map((file) => file.path),
	]);

	const files = filePaths
		.slice(0, args.maxFiles)
		.map((filePath) => {
			const file = fileByPath.get(filePath);
			if (!file) {
				return null;
			}
			return {
				path: file.path,
				module: args.fileToModuleKey.get(file.path) ?? file.path,
				language: file.languageId,
			};
		})
		.filter((file): file is NonNullable<typeof file> => file !== null);
	const returnedFilePaths = new Set(files.map((file) => file.path));

	const tokenizedSymbols = args.visibleSymbols
		.filter((symbol) => returnedFilePaths.has(symbol.filePath))
		.map((symbol) => {
			const text = `${symbol.name} ${symbol.signature ?? ""}`.toLowerCase();
			const overlap = args.tokens.filter((token) =>
				text.includes(token),
			).length;
			return {
				symbol,
				score: overlap + (symbol.exported ? 1 : 0),
			};
		})
		.sort(
			(left, right) =>
				right.score - left.score ||
				left.symbol.filePath.localeCompare(right.symbol.filePath),
		)
		.slice(0, args.maxFiles * 3)
		.map(({ symbol }) => ({
			file: symbol.filePath,
			name: symbol.name,
			kind: symbol.kind,
			...(args.explainSymbols && symbol.signature
				? { signature: symbol.signature }
				: {}),
		}));

	return {
		files,
		keySymbols: tokenizedSymbols,
	};
}

function buildSemanticHits(
	hits: SearchHit[],
	maxSnippets: number,
	includeSnippets: boolean,
): ContextPackResult["semantic_hits"] {
	return hits.slice(0, maxSnippets).map((hit, index) => ({
		filePath: hit.filePath,
		score: hit.score,
		...(hit.primarySymbol ? { primarySymbol: hit.primarySymbol } : {}),
		reason:
			index === 0
				? "best semantic match in the selected scope"
				: "supporting semantic evidence for the selected area",
		...(includeSnippets && hit.content ? { snippet: hit.content } : {}),
	}));
}

function createEmptyPack(args: {
	task: string;
	intent: ContextPackIntent;
	profile: ContextPackProfile;
	budget: number;
	why: string[];
}): ContextPackResult {
	const result: ContextPackResult = {
		task: args.task,
		intent: args.intent,
		selected_scope: {
			pathPrefixes: [],
			confidence: 0.1,
			why: args.why,
		},
		module_goals: [],
		architecture_slice: {
			entrypoints: [],
			relatedModules: [],
			dependencies: [],
		},
		structure_slice: {
			files: [],
			keySymbols: [],
		},
		semantic_hits: [],
		next_reads: [],
		_meta: {
			estimatedTokens: 0,
			budget: args.budget,
			profile: args.profile,
			confidenceBand: "low",
			omitted: [
				"full-file content",
				"long dependency traces",
				"evidence snippets",
				"symbol signatures",
			],
		},
	};

	result._meta.estimatedTokens = estimateTokens(result);
	return result;
}

function buildNextReads(args: {
	structureFiles: ContextPackResult["structure_slice"]["files"];
	semanticHits: ContextPackResult["semantic_hits"];
	entrypoints: string[];
}): ContextPackResult["next_reads"] {
	const nextReads = new Map<string, ContextPackResult["next_reads"][number]>();

	for (const hit of args.semanticHits) {
		if (!nextReads.has(hit.filePath)) {
			nextReads.set(hit.filePath, {
				file: hit.filePath,
				reason: "highest-ranked semantic hit for the task",
			});
		}
	}
	for (const file of args.structureFiles) {
		if (!nextReads.has(file.path)) {
			nextReads.set(file.path, {
				file: file.path,
				reason: `representative file in selected module ${file.module}`,
			});
		}
	}
	for (const file of args.entrypoints) {
		if (!nextReads.has(file)) {
			nextReads.set(file, {
				file,
				reason: "entrypoint touching the selected dependency neighborhood",
			});
		}
	}

	return Array.from(nextReads.values()).slice(0, 4);
}

function buildMeta(
	selectedScope: ContextPackResult["selected_scope"],
	options: ResolvedContextPackOptions,
	includeEvidence: boolean,
): PackMeta {
	const omitted = ["full-file content", "long dependency traces"];
	if (!includeEvidence) {
		omitted.push("evidence snippets");
	}
	if (!options.explainSymbols) {
		omitted.push("symbol signatures");
	}

	return {
		estimatedTokens: 0,
		budget: options.budget,
		profile: options.profile,
		confidenceBand: inferContextPackConfidenceBand(selectedScope.confidence),
		omitted,
	};
}

function buildModuleMetrics(args: {
	moduleFiles: Record<string, string[]>;
	fileToModuleKey: Map<string, string>;
	visibleSymbols: SymbolRecord[];
	hits: SearchHit[];
	architecture: ArchitectureSnapshot;
	changedFiles: Set<string>;
	tokens: string[];
	intent: ContextPackIntent;
	allowedModuleKeys?: Set<string>;
}): ModuleMetric[] {
	const symbolsByModule = new Map<string, SymbolRecord[]>();
	for (const symbol of args.visibleSymbols) {
		const moduleKey = args.fileToModuleKey.get(symbol.filePath);
		if (!moduleKey) {
			continue;
		}
		const current = symbolsByModule.get(moduleKey) ?? [];
		current.push(symbol);
		symbolsByModule.set(moduleKey, current);
	}

	const hitModules = new Set<string>();
	const hitStats = new Map<
		string,
		{ maxSemanticScore: number; hitCount: number }
	>();
	for (const hit of args.hits) {
		const moduleKey = args.fileToModuleKey.get(hit.filePath);
		if (!moduleKey) {
			continue;
		}
		hitModules.add(moduleKey);
		const current = hitStats.get(moduleKey) ?? {
			maxSemanticScore: 0,
			hitCount: 0,
		};
		current.maxSemanticScore = Math.max(current.maxSemanticScore, hit.score);
		current.hitCount += 1;
		hitStats.set(moduleKey, current);
	}

	const dependencyMap = args.architecture.dependency_map?.internal ?? {};

	return Object.entries(args.moduleFiles)
		.filter(
			([moduleKey]) =>
				args.allowedModuleKeys === undefined ||
				args.allowedModuleKeys.has(moduleKey),
		)
		.map(([moduleKey, filePaths]) => {
			const stats = hitStats.get(moduleKey) ?? {
				maxSemanticScore: 0,
				hitCount: 0,
			};
			const changedBoost = filePaths.some((filePath) =>
				args.changedFiles.has(filePath),
			)
				? 1
				: 0;
			const dependencyProximity = hitModules.has(moduleKey)
				? 1
				: (dependencyMap[moduleKey] ?? []).some((neighbor) =>
							hitModules.has(neighbor),
						) ||
						Object.entries(dependencyMap).some(
							([fromModule, neighbors]) =>
								hitModules.has(fromModule) && neighbors.includes(moduleKey),
						)
					? 0.6
					: 0;
			const reasons: string[] = [];
			if (stats.hitCount > 0) {
				reasons.push(`semantic hits clustered in ${moduleKey}`);
			}
			if (changedBoost > 0) {
				reasons.push("working tree changes intersect this module");
			}
			if (dependencyProximity > 0 && stats.hitCount === 0) {
				reasons.push("dependency neighborhood touches top semantic matches");
			}

			return {
				module: moduleKey,
				maxSemanticScore: stats.maxSemanticScore,
				hitCount: stats.hitCount,
				symbolOverlap: scoreSymbolOverlap(
					symbolsByModule.get(moduleKey) ?? [],
					args.tokens,
				),
				dependencyProximity,
				pathPrior: getPathPrior(moduleKey, args.tokens, args.intent),
				changedBoost,
				fileCount: filePaths.length,
				reasons,
			};
		});
}

export class ContextPackBuilder {
	constructor(
		private readonly metadata: MetadataStore,
		private readonly search: ContextPackSearch,
		private readonly git: GitOperations,
		private readonly repoRoot: string,
	) {}

	async build(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		task: string,
		options: ContextPackBuildOptions = {},
	): Promise<ContextPackResult> {
		const resolved = buildContextPackProfile(options);
		const intent = normalizeContextPackIntent(task);
		const tokens = tokenizeTask(task);

		const [files, symbols, artifact, gitDiff] = await Promise.all([
			this.metadata.listFiles(projectId, snapshotId),
			this.metadata.listSymbols(projectId, snapshotId),
			this.metadata.getArtifact(
				projectId,
				snapshotId,
				"architecture_snapshot",
				"project",
			),
			this.git.getWorkingTreeChanges(this.repoRoot),
		]);

		if (!artifact) {
			throw new Error("Architecture snapshot unavailable after indexing.");
		}

		const rawArchitecture = JSON.parse(
			artifact.dataJson,
		) as ArchitectureSnapshot;
		const architecture = resolved.includeFixtures
			? rawArchitecture
			: filterArchitectureSnapshot(
					rawArchitecture,
					resolved.excludePathPatterns,
				);
		const visibleFilePathSet = new Set(
			(architecture.files ?? []).map((file) => file.path),
		);
		const visibleFiles = files.filter((file) =>
			visibleFilePathSet.has(file.path),
		);
		const visibleSymbols = symbols.filter((symbol) =>
			visibleFilePathSet.has(symbol.filePath),
		);
		const moduleFiles = architecture.module_files ?? {};
		const fileToModuleKey = new Map<string, string>();
		for (const [moduleKey, filePaths] of Object.entries(moduleFiles)) {
			for (const filePath of filePaths) {
				fileToModuleKey.set(filePath, moduleKey);
			}
		}

		let scopeResolution: ScopeResolution;
		if (resolved.scope.kind === "changed") {
			scopeResolution = {
				filePaths: new Set([...gitDiff.added, ...gitDiff.modified]),
				why: ["Scoped to current uncommitted changes"],
			};
		} else if (resolved.scope.kind === "relevant-to") {
			scopeResolution = resolveRelevantScopeFiles(
				resolved.scope.value,
				architecture,
			);
		} else if (resolved.scope.kind === "path-prefix") {
			const scopeValue = resolved.scope.value;
			scopeResolution = {
				filePaths: new Set(
					visibleFiles
						.filter((file) => file.path.startsWith(scopeValue))
						.map((file) => file.path),
				),
				pathPrefix: scopeValue,
				why: [`Scoped search to path prefix ${scopeValue}`],
			};
		} else {
			scopeResolution = {
				filePaths: null,
				why: ["Used full-repo routing to infer the best area"],
			};
		}

		const scopedFilePaths =
			scopeResolution.filePaths === null
				? null
				: new Set(
						Array.from(scopeResolution.filePaths).filter((filePath) =>
							visibleFilePathSet.has(filePath),
						),
					);

		if (isExplicitScope(resolved.scope) && (scopedFilePaths?.size ?? 0) === 0) {
			return createEmptyPack({
				task,
				intent,
				profile: resolved.profile,
				budget: resolved.budget,
				why: [
					...scopeResolution.why,
					"No indexed files matched the requested explicit scope.",
				],
			});
		}

		const effectiveModuleFiles =
			scopedFilePaths === null
				? moduleFiles
				: (Object.fromEntries(
						Object.entries(moduleFiles)
							.map(([moduleKey, filePaths]) => [
								moduleKey,
								filePaths.filter((filePath) => scopedFilePaths.has(filePath)),
							])
							.filter(([, filePaths]) => filePaths.length > 0),
					) as Record<string, string[]>);
		const effectiveModuleKeys = new Set(Object.keys(effectiveModuleFiles));
		const effectiveVisibleFiles =
			scopedFilePaths === null
				? visibleFiles
				: visibleFiles.filter((file) => scopedFilePaths.has(file.path));
		const effectiveVisibleSymbols =
			scopedFilePaths === null
				? visibleSymbols
				: visibleSymbols.filter((symbol) =>
						scopedFilePaths.has(symbol.filePath),
					);

		const lightweightHits = await this.search.search(
			projectId,
			snapshotId,
			task,
			{
				topK: resolved.searchTopK,
				pathPrefix: scopeResolution.pathPrefix,
				includeContent: false,
				minScore: resolved.minScore,
			},
		);
		const scopedHits = lightweightHits.filter(
			(hit) =>
				visibleFilePathSet.has(hit.filePath) &&
				(scopedFilePaths === null || scopedFilePaths.has(hit.filePath)),
		);
		const changedFiles = new Set([...gitDiff.added, ...gitDiff.modified]);
		const effectiveChangedFiles =
			scopedFilePaths === null
				? changedFiles
				: new Set(
						Array.from(changedFiles).filter((filePath) =>
							scopedFilePaths.has(filePath),
						),
					);

		const scoredModules = scoreContextPackModules(
			buildModuleMetrics({
				moduleFiles: effectiveModuleFiles,
				fileToModuleKey,
				visibleSymbols: effectiveVisibleSymbols,
				hits: scopedHits,
				architecture,
				changedFiles: effectiveChangedFiles,
				tokens,
				intent,
				allowedModuleKeys: effectiveModuleKeys,
			}),
		);
		const selectedModules = pickSelectedModules(
			scoredModules.length > 0 && (scoredModules[0]?.score ?? 0) > 0
				? scoredModules
				: createFallbackScores(effectiveModuleFiles, tokens, intent),
			resolved.maxModules,
		);
		const selectedScope: ContextPackResult["selected_scope"] = {
			pathPrefixes: unique(selectedModules.map((entry) => entry.module)),
			confidence: clamp(selectedModules[0]?.score ?? 0.2, 0.05, 0.99),
			why: unique([
				...scopeResolution.why,
				...selectedModules.flatMap((entry) => entry.reasons),
			]).slice(0, 4),
		};

		const includeEvidence =
			resolved.profile === "deep" ||
			selectedScope.confidence < resolved.evidenceThreshold;
		const evidenceHits = includeEvidence
			? (
					await this.search.search(projectId, snapshotId, task, {
						topK: Math.max(resolved.maxSnippets * 2, 3),
						pathPrefix: scopeResolution.pathPrefix,
						includeContent: true,
						minScore: resolved.minScore,
					})
				).filter(
					(hit) =>
						visibleFilePathSet.has(hit.filePath) &&
						(scopedFilePaths === null || scopedFilePaths.has(hit.filePath)),
				)
			: scopedHits;

		const architectureSlice = buildArchitectureSlice(
			selectedModules.map((entry) => entry.module),
			architecture,
			fileToModuleKey,
			resolved.maxModules,
		);
		const structureSlice =
			resolved.profile === "routing"
				? { files: [], keySymbols: [] }
				: buildStructureSlice({
						selectedModuleKeys: selectedModules.map((entry) => entry.module),
						fileToModuleKey,
						visibleFiles: effectiveVisibleFiles,
						visibleSymbols: effectiveVisibleSymbols,
						hitFilePaths: scopedHits.map((hit) => hit.filePath),
						maxFiles: resolved.maxFiles,
						explainSymbols: resolved.explainSymbols,
						tokens,
					});
		const moduleGoals: ModuleGoal[] = selectedModules.map((entry) => {
			const goal = inferModuleGoal(
				entry.module,
				effectiveVisibleSymbols.filter(
					(symbol) => fileToModuleKey.get(symbol.filePath) === entry.module,
				),
				entry.metrics.hitCount > 0,
			);
			return {
				module: entry.module,
				goal: goal.goal,
				confidence: clamp(entry.score, 0.1, 0.99),
				evidenceSources: unique(goal.evidenceSources),
			};
		});
		const semanticHits = buildSemanticHits(
			resolved.profile === "routing" ? [] : includeEvidence ? evidenceHits : [],
			resolved.maxSnippets,
			includeEvidence,
		);
		const nextReads = buildNextReads({
			structureFiles: structureSlice.files,
			semanticHits,
			entrypoints: architectureSlice.entrypoints,
		});
		const meta = buildMeta(selectedScope, resolved, includeEvidence);

		const result: ContextPackResult = {
			task,
			intent,
			selected_scope: selectedScope,
			module_goals: moduleGoals,
			architecture_slice:
				resolved.profile === "routing"
					? { entrypoints: [], relatedModules: [], dependencies: [] }
					: architectureSlice,
			structure_slice: structureSlice,
			semantic_hits: semanticHits,
			next_reads: nextReads,
			_meta: meta,
		};

		meta.estimatedTokens = estimateTokens(result);
		return result;
	}
}
