import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import {
	filterArchitectureSnapshot,
	type ArchitectureSnapshot,
} from "../../engine/architecture.js";
import type { DependencyRecord } from "../../core/types.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { ensureIndexed } from "./ensure-indexed.js";
import { formatAutoIndexResult } from "../format/compact.js";
import { normalizePathPrefix } from "./path-prefix.js";
import { resolveInitializedProjectRoot } from "../project-root.js";

type Severity = "low" | "med" | "high";

interface UnresolvedClassification {
	kind: string;
	severity: Severity;
}

interface CycleDetail {
	from: string;
	to: string;
	severity: Severity;
	forward?: DependencyRecord;
	backward?: DependencyRecord;
	fix: string;
}

function summarizeExternalDependencies(
	values: Record<string, string[]>,
): Record<string, number> {
	const counts = new Map<string, number>();
	for (const dependencies of Object.values(values)) {
		for (const dependency of dependencies) {
			counts.set(dependency, (counts.get(dependency) ?? 0) + 1);
		}
	}
	return Object.fromEntries(
		Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0])),
	);
}

// Prefix-trie grouping with DP: finds the set of group headings that
// minimises total rendered output length. No hardcoded path heuristics.

interface TrieNode {
	segment: string;
	fullPrefix: string;
	children: TrieNode[];
	childMap: Map<string, TrieNode>;
	entry?: { key: string; values: unknown[] };
	descendantEntryCount: number;
	firstSeen: number;
}

type LeafRenderer = (
	key: string,
	values: unknown[],
	localPrefix: string,
) => string;

interface PlanPart {
	kind: "heading" | "leaf";
	text: string;
	depth: number;
}

interface Plan {
	cost: number;
	headingCount: number;
	parts: PlanPart[];
}

function relativePath(full: string, base: string): string {
	if (!base) return full;
	if (full === base) return ".";
	const prefix = base + "/";
	return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

function buildTrie(entries: [string, unknown[]][]): TrieNode {
	const root: TrieNode = {
		segment: "",
		fullPrefix: "",
		children: [],
		childMap: new Map(),
		descendantEntryCount: 0,
		firstSeen: Number.MAX_SAFE_INTEGER,
	};

	for (let i = 0; i < entries.length; i++) {
		const [key, values] = entries[i];
		let node = root;
		const parts = key.split("/").filter(Boolean);

		for (let p = 0; p < parts.length; p++) {
			const seg = parts[p];
			let child = node.childMap.get(seg);
			if (!child) {
				child = {
					segment: seg,
					fullPrefix: parts.slice(0, p + 1).join("/"),
					children: [],
					childMap: new Map(),
					descendantEntryCount: 0,
					firstSeen: i,
				};
				node.childMap.set(seg, child);
				node.children.push(child);
			}
			node = child;
			node.firstSeen = Math.min(node.firstSeen, i);
		}

		node.entry = { key, values };
	}

	const countDescendants = (node: TrieNode): number => {
		let n = node.entry ? 1 : 0;
		for (const child of node.children) n += countDescendants(child);
		node.descendantEntryCount = n;
		node.children.sort((a, b) => a.firstSeen - b.firstSeen);
		return n;
	};

	countDescendants(root);
	return root;
}

function formatGrouped(
	entries: [string, unknown[]][],
	renderLeaf: LeafRenderer,
	indent = "  ",
): string {
	if (entries.length === 0) return "  none";

	const root = buildTrie(entries);
	const memo = new Map<string, Plan>();

	const lineCost = (text: string, depth: number) =>
		depth * indent.length + text.length + 1;

	function solve(node: TrieNode, basePrefix: string, depth: number): Plan {
		const memoKey = `${node.fullPrefix}|${basePrefix}|${depth}`;
		const hit = memo.get(memoKey);
		if (hit) return hit;

		let inline: Plan = { cost: 0, headingCount: 0, parts: [] };

		if (node.entry) {
			const text = renderLeaf(node.entry.key, node.entry.values, basePrefix);
			inline.cost += lineCost(text, depth);
			inline.parts.push({ kind: "leaf", text, depth });
		}

		for (const child of node.children) {
			const childPlan = solve(child, basePrefix, depth);
			inline.cost += childPlan.cost;
			inline.headingCount += childPlan.headingCount;
			inline.parts.push(...childPlan.parts);
		}

		let best = inline;

		if (node.fullPrefix && node.descendantEntryCount >= 2) {
			const headingText = relativePath(node.fullPrefix, basePrefix) + "/";
			let grouped: Plan = {
				cost: lineCost(headingText, depth),
				headingCount: 1,
				parts: [{ kind: "heading", text: headingText, depth }],
			};

			if (node.entry) {
				const text = renderLeaf(
					node.entry.key,
					node.entry.values,
					node.fullPrefix,
				);
				grouped.cost += lineCost(text, depth + 1);
				grouped.parts.push({ kind: "leaf", text, depth: depth + 1 });
			}

			for (const child of node.children) {
				const childPlan = solve(child, node.fullPrefix, depth + 1);
				grouped.cost += childPlan.cost;
				grouped.headingCount += childPlan.headingCount;
				grouped.parts.push(...childPlan.parts);
			}

			if (
				grouped.cost < best.cost ||
				(grouped.cost === best.cost && grouped.headingCount < best.headingCount)
			) {
				best = grouped;
			}
		}

		memo.set(memoKey, best);
		return best;
	}

	const plan = solve(root, "", 0);

	return plan.parts
		.map((part) => indent.repeat(part.depth + 1) + part.text)
		.join("\n");
}

function renderDependencyEdge(
	key: string,
	values: unknown[],
	localPrefix: string,
): string {
	const rhs = (values as string[]).map((v) => relativePath(v, localPrefix));
	return `${relativePath(key, localPrefix)} -> ${rhs.join(", ")}`;
}

function normalizeFilePath(value: string): string {
	return value.replace(/\\/g, "/");
}

function getModuleKey(filePath: string): string {
	const parts = normalizeFilePath(filePath).split("/");
	if (parts.length === 1) return "root";

	const rootGroup = parts[0];
	if (
		["packages", "services", "apps", "libs", "modules"].includes(rootGroup) &&
		parts[1]
	) {
		return `${rootGroup}/${parts[1]}`;
	}

	if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
	return rootGroup;
}

function classifyUnresolvedDependency(specifier: string): UnresolvedClassification {
	const spec = specifier.trim();
	const normalized = normalizeFilePath(spec);
	const lower = normalized.toLowerCase();

	if (/\b(dist|build|out|target|bin)\b/.test(lower)) {
		return { kind: "build-output", severity: "low" };
	}
	if (/\b(generated|gen|proto)\b/.test(lower)) {
		return { kind: "generated-file", severity: "low" };
	}
	if (/^[@a-zA-Z0-9_-]+(?:\/[^./][^/]*)?$/.test(spec)) {
		return { kind: "external-package", severity: "low" };
	}
	if (spec.startsWith("@") || spec.startsWith("~") || spec.startsWith("#")) {
		return { kind: "path-alias", severity: "med" };
	}
	if (/^\.\.?\//.test(spec) && /\.(js|jsx|mjs|cjs)$/.test(lower)) {
		return { kind: "generated-output-missing", severity: "med" };
	}
	if (/^\.\.?\//.test(spec)) {
		return { kind: "missing-source", severity: "med" };
	}
	return { kind: "false-positive-possible", severity: "low" };
}

function buildInternalEdgeIndex(
	dependencies: DependencyRecord[],
): Map<string, DependencyRecord> {
	const edges = new Map<string, DependencyRecord>();
	for (const dependency of dependencies) {
		if (dependency.dependencyType !== "internal" || !dependency.toPath) continue;
		const fromModule = getModuleKey(dependency.fromPath);
		const toModule = getModuleKey(dependency.toPath);
		const key = `${fromModule}\0${toModule}`;
		if (!edges.has(key)) edges.set(key, dependency);
	}
	return edges;
}

function severityForCycle(from: string, to: string): Severity {
	const pair = `${from} ${to}`;
	if (/src\/core|src\/storage|core|storage/.test(pair)) return "high";
	return "med";
}

function suggestedCycleFix(from: string, to: string): string {
	return `move shared helpers/types between ${from} and ${to} into a lower-level module`;
}

function findCycleDetails(
	architecture: ArchitectureSnapshot,
	dependencies: DependencyRecord[] = [],
): CycleDetail[] {
	const internalDependencies = architecture.dependency_map?.internal ?? {};
	const edgeIndex = buildInternalEdgeIndex(dependencies);
	const cycles: CycleDetail[] = [];
	const seenCycles = new Set<string>();

	for (const [from, tos] of Object.entries(internalDependencies)) {
		for (const to of tos) {
			const pair = [from, to].sort().join(" <-> ");
			if (seenCycles.has(pair)) continue;
			if (!internalDependencies[to]?.includes(from)) continue;

			cycles.push({
				from,
				to,
				severity: severityForCycle(from, to),
				forward: edgeIndex.get(`${from}\0${to}`),
				backward: edgeIndex.get(`${to}\0${from}`),
				fix: suggestedCycleFix(from, to),
			});
			seenCycles.add(pair);
		}
	}

	return cycles.sort((a, b) => `${a.from} ${a.to}`.localeCompare(`${b.from} ${b.to}`));
}

function formatCycleEdge(edge: DependencyRecord | undefined, from: string, to: string): string {
	if (!edge?.toPath) return `  ${from} -> ${to}`;
	return `  ${edge.fromPath} -> ${edge.toPath} via=${edge.toSpecifier}`;
}

function collectArchitectureActions(
	cycles: CycleDetail[],
	unresolvedEntries: [string, string[]][],
): string[] {
	const actions: string[] = [];
	const highCycle = cycles.find((cycle) => cycle.severity === "high") ?? cycles[0];
	if (highCycle) {
		actions.push(`Break ${highCycle.from} <-> ${highCycle.to}: ${highCycle.fix}.`);
	}

	const firstUnresolved = unresolvedEntries.find(([, values]) => values.length > 0);
	if (firstUnresolved) {
		const [from, values] = firstUnresolved;
		const first = values[0];
		const classified = classifyUnresolvedDependency(first);
		actions.push(`Verify unresolved ${from} -> ${first} kind=${classified.kind}.`);
	}

	if (cycles.length > 0) {
		actions.push("Add architecture rules for intended one-way module boundaries.");
	}

	return actions.slice(0, 3);
}

function renderExternalCount(
	key: string,
	values: unknown[],
	localPrefix: string,
): string {
	const count = values[0] as number;
	const label = relativePath(key, localPrefix);
	if (count <= 1) return label;
	return `${label} (${count} modules)`;
}

function printDependencySection(
	label: string,
	entries: [string, string[]][],
): void {
	console.log(label);
	for (const line of formatGrouped(
		entries as [string, unknown[]][],
		renderDependencyEdge,
	).split("\n")) {
		console.log(line);
	}
}

function printExternalSection(
	label: string,
	entries: [string, number][],
): void {
	console.log(label);
	for (const line of formatGrouped(
		entries.map(([k, v]) => [k, [v]] as [string, unknown[]]),
		renderExternalCount,
	).split("\n")) {
		console.log(line);
	}
}

function formatPlain(
	architecture: ArchitectureSnapshot,
	dependencies: DependencyRecord[] = [],
): void {
	console.log("File stats by language");
	const fileEntries = Object.entries(architecture.file_stats ?? {}).sort(
		(a, b) => a[0].localeCompare(b[0]),
	);
	if (fileEntries.length === 0) {
		console.log("  none");
	} else {
		for (const [key, value] of fileEntries) {
			console.log(`  ${key}: ${value}`);
		}
	}

	console.log("Entrypoints");
	const entrypoints = architecture.entrypoints ?? [];
	if (entrypoints.length === 0) {
		console.log("  none");
	} else {
		for (const value of entrypoints) {
			console.log(`  ${value}`);
		}
	}

	const internalEntries = Object.entries(
		architecture.dependency_map?.internal ?? {},
	).sort((a, b) => a[0].localeCompare(b[0]));
	printDependencySection("Module dependency graph", internalEntries);

	const cycles = findCycleDetails(architecture, dependencies);
	if (cycles.length > 0) {
		console.log("\n⚠ Cyclic dependencies detected:");
		for (const cycle of cycles) {
			console.log(`CYCLE sev=${cycle.severity} ${cycle.from} <-> ${cycle.to}`);
			console.log(formatCycleEdge(cycle.forward, cycle.from, cycle.to));
			console.log(formatCycleEdge(cycle.backward, cycle.to, cycle.from));
			console.log(`  fix=${cycle.fix}`);
		}
	}

	const externalSummary = summarizeExternalDependencies(
		architecture.dependency_map?.external ?? {},
	);
	const extEntries = Object.entries(externalSummary).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	printExternalSection("External dependencies summary", extEntries);

	const unresolvedEntries = Object.entries(
		architecture.dependency_map?.unresolved ?? {},
	).sort((a, b) => a[0].localeCompare(b[0]));
	console.log("Unresolved dependencies");
	if (unresolvedEntries.length === 0) {
		console.log("  none");
	} else {
		for (const [from, values] of unresolvedEntries) {
			for (const value of values) {
				const classified = classifyUnresolvedDependency(value);
				console.log(
					`UNRESOLVED sev=${classified.severity} ${from} -> ${value} kind=${classified.kind}`,
				);
			}
		}
	}

	const actions = collectArchitectureActions(cycles, unresolvedEntries);
	if (actions.length > 0) {
		console.log("\nActions:");
		actions.forEach((action, index) => console.log(`${index + 1}. ${action}`));
	}
}

export function registerArchitectureCommand(program: Command): void {
	program
		.command("architecture")
		.description("Print the latest architecture snapshot")
		.option(
			"--path-prefix <string>",
			"limit output to files under a path prefix",
		)
		.action(
			async (options?: { pathPrefix?: string }) => {
				let resolvedProjectPath: string;
				try {
					const resolved = resolveInitializedProjectRoot();
					resolvedProjectPath = resolved.projectRoot;
					if (resolved.notice) {
						console.log(resolved.notice);
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`Architecture command failed: ${message}`);
					process.exitCode = 1;
					return;
				}
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");

				initLogger(dataDir);
				config.load(dataDir);

				const metadata = new SqliteMetadataStore(dbPath);

				try {
					await metadata.initialize();
					const indexResult = await ensureIndexed(metadata, resolvedProjectPath, {
						silent: !process.stderr.isTTY,
					});
					console.log(formatAutoIndexResult(indexResult));
					if (indexResult.status === "failed") {
						process.exitCode = 1;
						return;
					}
					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error(
							"Auto-indexing did not produce a completed snapshot.",
						);
					}

					const artifact = await metadata.getArtifact(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						"architecture_snapshot",
						"project",
					);

					if (!artifact) {
						throw new Error(
							"Architecture snapshot unavailable after indexing.",
						);
					}

					const architecture = JSON.parse(
						artifact.dataJson,
					) as ArchitectureSnapshot;
					let visibleArchitecture = filterArchitectureSnapshot(
						architecture,
						config.get("visibilityExcludePaths"),
					);

					const pathPrefix = normalizePathPrefix(options?.pathPrefix);
					if (pathPrefix) {
						const prefix = pathPrefix;
						const allFiles = visibleArchitecture.files ?? [];
						const matchingFiles = allFiles.filter((f) =>
							f.path.startsWith(prefix),
						);

						if (matchingFiles.length === 0) {
							console.log(
								`Path '${prefix}' not found in indexed files. Showing results for the entire project instead.`,
							);
						} else {
							const matchingPaths = new Set(matchingFiles.map((f) => f.path));
							const matchingModules = Object.fromEntries(
								Object.entries(visibleArchitecture.module_files ?? {})
									.map(([key, paths]) => [
										key,
										paths.filter((p) => matchingPaths.has(p)),
									])
									.filter(([, paths]) => paths.length > 0),
							);
							const matchingModuleKeys = new Set(Object.keys(matchingModules));
							const filteredDeps = (
								bucket: Record<string, string[]>,
							): Record<string, string[]> =>
								Object.fromEntries(
									Object.entries(bucket)
										.filter(([from]) => matchingModuleKeys.has(from))
										.map(([from, to]) => [
											from,
											to.filter((t) => matchingModuleKeys.has(t)),
										]),
								);

							visibleArchitecture = {
								...visibleArchitecture,
								files: matchingFiles,
								module_files: matchingModules,
								entrypoints: (visibleArchitecture.entrypoints ?? []).filter(
									(ep) => matchingPaths.has(ep),
								),
								dependency_map: {
									internal: filteredDeps(
										visibleArchitecture.dependency_map?.internal ?? {},
									),
									external: Object.fromEntries(
										Object.entries(
											visibleArchitecture.dependency_map?.external ?? {},
										).filter(([from]) => matchingModuleKeys.has(from)),
									),
									builtin: Object.fromEntries(
										Object.entries(
											visibleArchitecture.dependency_map?.builtin ?? {},
										).filter(([from]) => matchingModuleKeys.has(from)),
									),
									unresolved: Object.fromEntries(
										Object.entries(
											visibleArchitecture.dependency_map?.unresolved ?? {},
										).filter(([from]) => matchingModuleKeys.has(from)),
									),
								},
								file_stats: Object.fromEntries(
									Object.entries(
										matchingFiles.reduce(
											(acc, f) => {
												const lang = f.language || "unknown";
												acc[lang] = (acc[lang] || 0) + 1;
												return acc;
											},
											{} as Record<string, number>,
										),
									).sort((a, b) => a[0].localeCompare(b[0])),
								),
							};
						}
					}

					const dependencies = await metadata.listDependencies(
						DEFAULT_PROJECT_ID,
						snapshot.id,
					);
					formatPlain(visibleArchitecture, dependencies);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`Architecture command failed: ${message}`);
					process.exitCode = 1;
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
