import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import {
	filterArchitectureSnapshot,
	type ArchitectureSnapshot,
} from "../../engine/architecture.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { ensureIndexed } from "./ensure-indexed.js";

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

function renderExternalCount(
	key: string,
	values: unknown[],
	localPrefix: string,
): string {
	const count = values[0] as number;
	return `${relativePath(key, localPrefix)}: ${count} file${count !== 1 ? "s" : ""}`;
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

function formatPlain(architecture: ArchitectureSnapshot): void {
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

	const internalDependencies = architecture.dependency_map?.internal ?? {};
	const cycles: string[] = [];
	const seenCycles = new Set<string>();
	for (const [from, tos] of Object.entries(internalDependencies)) {
		for (const to of tos) {
			const pair = [from, to].sort().join(" <-> ");
			if (seenCycles.has(pair)) {
				continue;
			}
			if (internalDependencies[to]?.includes(from)) {
				cycles.push(pair);
				seenCycles.add(pair);
			}
		}
	}
	if (cycles.length > 0) {
		console.log("\n⚠ Cyclic dependencies detected:");
		for (const cycle of cycles.sort((a, b) => a.localeCompare(b))) {
			console.log(`  ${cycle}`);
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
	printDependencySection("Unresolved dependencies", unresolvedEntries);
}

export function registerArchitectureCommand(program: Command): void {
	program
		.command("architecture")
		.description("Print the latest architecture snapshot")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option(
			"--path-prefix <string>",
			"limit output to files under a path prefix",
		)
		.option("--include-fixtures", "include fixture/vendor paths in output")
		.action(
			async (options?: { includeFixtures?: boolean; pathPrefix?: string }) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");

				initLogger(dataDir);
				config.load(dataDir);

				const metadata = new SqliteMetadataStore(dbPath);

				try {
					await metadata.initialize();
					await ensureIndexed(metadata, resolvedProjectPath, {
						silent: false,
					});
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
					let visibleArchitecture = options?.includeFixtures
						? architecture
						: filterArchitectureSnapshot(
								architecture,
								config.get("excludePaths"),
							);

					if (options?.pathPrefix) {
						const prefix = options.pathPrefix;
						const allFiles = visibleArchitecture.files ?? [];
						const matchingFiles = allFiles.filter((f) =>
							f.path.startsWith(prefix),
						);
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

					formatPlain(visibleArchitecture);
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
