import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import {
	filterArchitectureSnapshot,
	matchesPathPatterns,
	type ArchitectureSnapshot,
} from "../../engine/architecture.js";
import { SimpleGitOperations } from "../../engine/git.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { ensureIndexed } from "./ensure-indexed.js";

type ContextData = {
	modules: Array<{
		path: string;
	}>;
	symbols: Array<{
		file: string;
		name: string;
		kind: string;
		signature?: string;
	}>;
	dependencies: Record<string, string[]>;
};

const DEFAULT_TEST_EXCLUDE_PATH_PATTERNS = ["tests/**", "**/tests/**"];

function estimateTokens(data: {
	architecture?: { fileStats: Record<string, number>; entrypoints: string[] };
	modules: Array<{ path: string }>;
	symbols: Array<{
		file: string;
		name: string;
		kind: string;
		signature?: string;
	}>;
	dependencies: Record<string, string[]>;
}): number {
	let charCount = 0;
	if (data.architecture) {
		charCount += Object.entries(data.architecture.fileStats)
			.map(([k, v]) => `${k}: ${v}`)
			.join(", ").length;
		charCount += data.architecture.entrypoints.join(", ").length;
	}
	for (const mod of data.modules) charCount += mod.path.length + 1;
	for (const sym of data.symbols) {
		charCount +=
			`${sym.file}::${sym.name} (${sym.kind})${sym.signature ? ` — ${sym.signature}` : ""}`
				.length + 1;
	}
	for (const [from, to] of Object.entries(data.dependencies)) {
		charCount += `${from} -> ${to.join(", ")}`.length + 1;
	}
	return Math.ceil(charCount / 4);
}

function parseMaxDeps(input?: string): number | undefined {
	if (!input) {
		return undefined;
	}

	const parsed = Number.parseInt(input, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error("--max-deps must be a positive integer.");
	}

	return parsed;
}

function limitDependencies(
	dependencies: Record<string, string[]>,
	maxDeps: number | undefined,
): {
	dependencies: Record<string, string[]>;
	shown: number;
	total: number;
	truncated: boolean;
} {
	const entries = Object.entries(dependencies).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	if (maxDeps === undefined || entries.length <= maxDeps) {
		return {
			dependencies: Object.fromEntries(entries),
			shown: entries.length,
			total: entries.length,
			truncated: false,
		};
	}

	return {
		dependencies: Object.fromEntries(entries.slice(0, maxDeps)),
		shown: maxDeps,
		total: entries.length,
		truncated: true,
	};
}

function normalizeScopePath(
	inputPath: string,
	resolvedProjectPath: string,
): string {
	const projectRelativePath = path.isAbsolute(inputPath)
		? path.relative(resolvedProjectPath, inputPath)
		: inputPath;

	return projectRelativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function formatPlain(data: ContextData, options?: { compact?: boolean }): void {
	if (data.modules.length > 0) {
		console.log("## Modules\n");
		for (const mod of data.modules) {
			console.log(mod.path);
		}
	}

	if (data.symbols.length > 0) {
		console.log("\n## Key Symbols\n");
		for (const sym of data.symbols) {
			const sig = options?.compact
				? ""
				: sym.signature
					? ` — ${sym.signature}`
					: "";
			console.log(`${sym.file}::${sym.name} (${sym.kind})${sig}`);
		}
	}

	const depEntries = Object.entries(data.dependencies).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	if (depEntries.length > 0) {
		console.log("\n## Module Dependencies\n");
		for (const [from, to] of depEntries) {
			console.log(`${from} -> ${to.join(", ")}`);
		}
	}
}

export function registerContextCommand(program: Command): void {
	program
		.command("context")
		.description("Output dense project context aggregated from the index")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option(
			"--scope <scope>",
			"scope: all, changed (uncommitted changes), or relevant-to:<path>",
			"all",
		)
		.option(
			"--max-deps <number>",
			"maximum number of dependency edges to output",
			"30",
		)
		.option("--include-fixtures", "include fixture/vendor paths in output")
		.option("--include-tests", "include test paths in output")
		.option("--compact", "use compact one-line-per-symbol output")
		.action(
			async (options?: {
				scope?: string;
				maxDeps?: string;
				includeFixtures?: boolean;
				includeTests?: boolean;
				compact?: boolean;
			}) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");
				const maxDeps = parseMaxDeps(options?.maxDeps);
				const scope = options?.scope ?? "all";
				const relevantToPrefix = "relevant-to:";

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
						throw new Error("No completed snapshot found.");
					}

					let scopeFilePaths: Set<string> | null = null;
					let scopeWarning: string | undefined;
					let normalizedTargetPath: string | undefined;
					if (scope === "changed") {
						const git = new SimpleGitOperations();
						const changes =
							await git.getWorkingTreeChanges(resolvedProjectPath);
						scopeFilePaths = new Set([...changes.added, ...changes.modified]);
					}

					const [files, allSymbols, archArtifact] = await Promise.all([
						metadata.listFiles(DEFAULT_PROJECT_ID, snapshot.id),
						metadata.listSymbols(DEFAULT_PROJECT_ID, snapshot.id),
						metadata.getArtifact(
							DEFAULT_PROJECT_ID,
							snapshot.id,
							"architecture_snapshot",
							"project",
						),
					]);

					const rawArchitecture = archArtifact
						? (JSON.parse(archArtifact.dataJson) as ArchitectureSnapshot)
						: null;
					const architecture = rawArchitecture
						? options?.includeFixtures
							? rawArchitecture
							: filterArchitectureSnapshot(
									rawArchitecture,
									config.get("excludePaths"),
								)
						: null;

					if (scope.startsWith(relevantToPrefix)) {
						const targetPath = normalizeScopePath(
							scope.slice(relevantToPrefix.length),
							resolvedProjectPath,
						);
						normalizedTargetPath = targetPath.replace(/\/+$/, "");

						// Strategy 1: exact file match → file-level 1-hop neighborhood
						const targetFile = await metadata.getFile(
							DEFAULT_PROJECT_ID,
							snapshot.id,
							normalizedTargetPath,
						);

						if (targetFile) {
							const [callees, callers] = await Promise.all([
								metadata.listDependencies(
									DEFAULT_PROJECT_ID,
									snapshot.id,
									normalizedTargetPath,
								),
								metadata.getDependents(
									DEFAULT_PROJECT_ID,
									snapshot.id,
									normalizedTargetPath,
								),
							]);

							const neighborhood = new Set<string>([normalizedTargetPath]);
							for (const dep of callees) {
								if (dep.dependencyType === "internal" && dep.toPath) {
									neighborhood.add(dep.toPath);
								}
							}
							for (const dep of callers) {
								if (dep.dependencyType === "internal") {
									neighborhood.add(dep.fromPath);
								}
							}

							if (neighborhood.size > 1) {
								scopeFilePaths = neighborhood;
							} else {
								scopeFilePaths = neighborhood;
							}
						} else {
							// Strategy 2: directory/module path → module-level expansion
							const targetDirectoryPrefix = `${normalizedTargetPath}/`;
							const moduleFiles = architecture?.module_files ?? {};
							const dependencyMap =
								architecture?.dependency_map?.internal ?? {};
							const targetModuleKey = Object.entries(moduleFiles).find(
								([, moduleFilePaths]) =>
									moduleFilePaths.some(
										(filePath) =>
											normalizeScopePath(filePath, resolvedProjectPath) ===
											normalizedTargetPath,
									),
							)?.[0];
							const targetModuleKeys = targetModuleKey
								? new Set([targetModuleKey])
								: new Set(
										Object.entries(moduleFiles)
											.filter(([, moduleFilePaths]) =>
												moduleFilePaths.some((filePath) =>
													normalizeScopePath(
														filePath,
														resolvedProjectPath,
													).startsWith(targetDirectoryPrefix),
												),
											)
											.map(([moduleKey]) => moduleKey),
									);

							if (targetModuleKeys.size > 0) {
								const relatedModuleKeys = new Set<string>(targetModuleKeys);
								for (const moduleKey of targetModuleKeys) {
									for (const dependencyModule of dependencyMap[moduleKey] ??
										[]) {
										relatedModuleKeys.add(dependencyModule);
									}
								}
								for (const [fromModule, toModules] of Object.entries(
									dependencyMap,
								)) {
									if (
										toModules.some((toModule) => targetModuleKeys.has(toModule))
									) {
										relatedModuleKeys.add(fromModule);
									}
								}

								scopeFilePaths = new Set(
									Array.from(relatedModuleKeys).flatMap(
										(moduleKey) => moduleFiles[moduleKey] ?? [],
									),
								);
							} else {
								scopeWarning = `No indexed file or module found for path \"${normalizedTargetPath}\". Returning empty context.`;
								scopeFilePaths = new Set();
							}
						}
					}

					const scopedFiles =
						scopeFilePaths !== null
							? files.filter((file) => scopeFilePaths.has(file.path))
							: files;
					const excludePatterns = [
						...(options?.includeFixtures ? [] : config.get("excludePaths")),
						...(options?.includeTests
							? []
							: DEFAULT_TEST_EXCLUDE_PATH_PATTERNS),
					];
					const visibleFiles =
						excludePatterns.length === 0
							? scopedFiles
							: scopedFiles.filter(
									(file) => !matchesPathPatterns(file.path, excludePatterns),
								);
					const filePathSet = new Set(visibleFiles.map((file) => file.path));

					const visibleSymbols = allSymbols.filter((symbol) =>
						filePathSet.has(symbol.filePath),
					);
					let scopedDependencies: Record<string, string[]>;
					const isFileLevelScope =
						scopeFilePaths !== null &&
						scopeFilePaths.size > 0 &&
						normalizedTargetPath !== undefined &&
						scopeFilePaths.has(normalizedTargetPath);

					if (isFileLevelScope) {
						const allDeps = await metadata.listDependencies(
							DEFAULT_PROJECT_ID,
							snapshot.id,
						);
						const fileDepMap: Record<string, Set<string>> = {};
						for (const dep of allDeps) {
							if (
								dep.dependencyType !== "internal" ||
								!dep.toPath ||
								!filePathSet.has(dep.fromPath) ||
								!filePathSet.has(dep.toPath)
							) {
								continue;
							}
							if (!fileDepMap[dep.fromPath]) {
								fileDepMap[dep.fromPath] = new Set();
							}
							fileDepMap[dep.fromPath].add(dep.toPath);
						}
						scopedDependencies = Object.fromEntries(
							Object.entries(fileDepMap).map(([k, v]) => [
								k,
								Array.from(v).sort(),
							]),
						);
					} else {
						const dependencyCandidates =
							architecture?.dependency_map?.internal ?? {};
						const moduleFiles = architecture?.module_files ?? {};
						const scopedModuleKeys =
							scopeFilePaths === null
								? null
								: new Set(
										Object.entries(moduleFiles)
											.filter(([, moduleFilePaths]) =>
												moduleFilePaths.some((filePath) =>
													filePathSet.has(filePath),
												),
											)
											.map(([moduleKey]) => moduleKey),
									);
						scopedDependencies =
							scopedModuleKeys === null
								? dependencyCandidates
								: Object.fromEntries(
										Object.entries(dependencyCandidates).filter(
											([fromModule]) => scopedModuleKeys.has(fromModule),
										),
									);
					}
					const limitedDependencies = limitDependencies(
						scopedDependencies,
						maxDeps,
					);

					if (limitedDependencies.truncated) {
						console.error(
							`Showing ${limitedDependencies.shown} of ${limitedDependencies.total} dependencies. Use --max-deps to see more.`,
						);
					}

					const filesWithExports = new Set(
						visibleSymbols
							.filter((symbol) => symbol.exported)
							.map((symbol) => symbol.filePath),
					);

					const seedFilePath = isFileLevelScope
						? normalizedTargetPath
						: undefined;
					const contextData: ContextData = {
						modules: visibleFiles
							.filter(
								(file) =>
									filesWithExports.has(file.path) || file.path === seedFilePath,
							)
							.map((file) => ({ path: file.path })),
						symbols: visibleSymbols
							.filter((symbol) => symbol.exported)
							.map((symbol) => ({
								file: symbol.filePath,
								name: symbol.name,
								kind: symbol.kind,
								signature: symbol.signature,
							})),
						dependencies: limitedDependencies.dependencies,
					};

					if (scopeWarning) {
						console.warn(`Warning: ${scopeWarning}`);
					}

					formatPlain(contextData, { compact: options?.compact });
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`Context command failed: ${message}`);
					process.exitCode = 1;
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
