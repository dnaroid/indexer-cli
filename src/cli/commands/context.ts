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
	architecture: {
		fileStats: Record<string, number>;
		entrypoints: string[];
	};
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

function estimateTokens(data: ContextData): number {
	let charCount = 0;
	charCount += Object.entries(data.architecture.fileStats)
		.map(([k, v]) => `${k}: ${v}`)
		.join(", ").length;
	charCount += data.architecture.entrypoints.join(", ").length;
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

function normalizeScopePath(
	inputPath: string,
	resolvedProjectPath: string,
): string {
	const projectRelativePath = path.isAbsolute(inputPath)
		? path.relative(resolvedProjectPath, inputPath)
		: inputPath;

	return projectRelativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function formatPlain(data: ContextData): void {
	console.log("## Architecture\n");
	const stats = Object.entries(data.architecture.fileStats)
		.sort((a, b) => b[1] - a[1])
		.map(([lang, count]) => `${lang}: ${count}`)
		.join(", ");
	if (stats) console.log(`Files: ${stats}`);

	if (data.architecture.entrypoints.length > 0) {
		console.log(
			`Entry points: ${data.architecture.entrypoints.slice(0, 5).join(", ")}`,
		);
	}

	if (data.modules.length > 0) {
		console.log("\n## Modules\n");
		for (const mod of data.modules) {
			console.log(mod.path);
		}
	}

	if (data.symbols.length > 0) {
		console.log("\n## Key Symbols\n");
		for (const sym of data.symbols) {
			const sig = sym.signature ? ` — ${sym.signature}` : "";
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
		.action(
			async (options?: {
				scope?: string;
				maxDeps?: string;
				includeFixtures?: boolean;
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
						const moduleFiles = architecture?.module_files ?? {};
						const dependencyMap = architecture?.dependency_map?.internal ?? {};
						const targetModuleKey = Object.entries(moduleFiles).find(
							([, moduleFilePaths]) =>
								moduleFilePaths.some(
									(filePath) =>
										normalizeScopePath(filePath, resolvedProjectPath) ===
										targetPath,
								),
						)?.[0];

						if (targetModuleKey) {
							const relatedModuleKeys = new Set<string>([
								targetModuleKey,
								...(dependencyMap[targetModuleKey] ?? []),
								...Object.entries(dependencyMap)
									.filter(([, toModules]) =>
										toModules.includes(targetModuleKey),
									)
									.map(([fromModule]) => fromModule),
							]);

							scopeFilePaths = new Set(
								Array.from(relatedModuleKeys).flatMap(
									(moduleKey) => moduleFiles[moduleKey] ?? [],
								),
							);
						} else {
							scopeFilePaths = null;
							scopeWarning = `No module found for path \"${targetPath}\"; falling back to full context.`;
						}
					}

					const scopedFiles =
						scopeFilePaths !== null
							? files.filter((file) => scopeFilePaths.has(file.path))
							: files;
					const visibleFiles = options?.includeFixtures
						? scopedFiles
						: scopedFiles.filter(
								(file) =>
									!matchesPathPatterns(file.path, config.get("excludePaths")),
							);
					const filePathSet = new Set(visibleFiles.map((file) => file.path));

					const visibleSymbols = allSymbols.filter((symbol) =>
						filePathSet.has(symbol.filePath),
					);
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
					const scopedDependencies =
						scopedModuleKeys === null
							? dependencyCandidates
							: Object.fromEntries(
									Object.entries(dependencyCandidates).filter(([fromModule]) =>
										scopedModuleKeys.has(fromModule),
									),
								);
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

					const contextData: ContextData = {
						architecture: {
							fileStats: architecture?.file_stats ?? {},
							entrypoints: architecture?.entrypoints ?? [],
						},
						modules: visibleFiles
							.filter((file) => filesWithExports.has(file.path))
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

					const estimatedTokens = estimateTokens(contextData);

					formatPlain(contextData);
					if (estimatedTokens > 0) {
						const estimatedChars = (estimatedTokens * 4) / 1000;
						console.log(
							`\nEstimated tokens: ${estimatedTokens} (~${estimatedChars.toFixed(1)}k chars)`,
						);
					}
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
