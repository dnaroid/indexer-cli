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

function formatDependencyTree(entries: [string, string[]][]): void {
	if (entries.length === 0) {
		console.log("  none");
		return;
	}

	const groups = new Map<string, [string, string[]][]>();
	for (const entry of entries) {
		const [from] = entry;
		const slashIdx = from.indexOf("/");
		const groupKey = slashIdx >= 0 ? from.slice(0, slashIdx) : "";
		if (!groups.has(groupKey)) groups.set(groupKey, []);
		groups.get(groupKey)!.push(entry);
	}

	for (const [groupKey, groupEntries] of groups) {
		const prefix = groupKey ? groupKey + "/" : "";

		if (prefix) {
			console.log(`  ${groupKey}/`);
		}

		for (const [from, tos] of groupEntries) {
			const localFrom = prefix ? from.slice(prefix.length) : from;
			const localTos = tos.map((t) =>
				prefix && t.startsWith(prefix) ? t.slice(prefix.length) : t,
			);
			const indent = prefix ? "    " : "  ";
			console.log(`${indent}${localFrom} -> ${localTos.join(", ")}`);
		}
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

	console.log("Module dependency graph");
	const internalEntries = Object.entries(
		architecture.dependency_map?.internal ?? {},
	).sort((a, b) => a[0].localeCompare(b[0]));
	formatDependencyTree(internalEntries);

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

	console.log("External dependencies summary");
	const externalSummary = summarizeExternalDependencies(
		architecture.dependency_map?.external ?? {},
	);
	const extEntries = Object.entries(externalSummary).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	if (extEntries.length === 0) {
		console.log("  none");
	} else {
		for (const [key, value] of extEntries) {
			console.log(`  ${key}: ${value} file${value !== 1 ? "s" : ""}`);
		}
	}

	console.log("Unresolved dependencies");
	const unresolvedEntries = Object.entries(
		architecture.dependency_map?.unresolved ?? {},
	).sort((a, b) => a[0].localeCompare(b[0]));
	formatDependencyTree(unresolvedEntries);
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
