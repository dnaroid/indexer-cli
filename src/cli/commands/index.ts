import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { setLogLevel } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SimpleGitOperations } from "../../engine/git.js";
import {
	IndexerEngine,
	createDefaultLanguagePlugins,
} from "../../engine/indexer.js";
import { scanProjectFiles } from "../../engine/scanner.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { LanceDbVectorStore } from "../../storage/vectors.js";
import type { GitDiff } from "../../core/types.js";

type CliColors = {
	green(text: string): string;
	red(text: string): string;
	gray(text: string): string;
};

async function loadChalk(): Promise<CliColors> {
	return (await import("chalk")).default as unknown as CliColors;
}

async function loadOra() {
	return (await import("ora")).default;
}

function countChangedFiles(diff: GitDiff): number {
	return diff.added.length + diff.modified.length + diff.deleted.length;
}

export function registerIndexCommand(program: Command): void {
	program
		.command("index")
		.description("Index project files for semantic search")
		.option("--full", "force a full reindex")
		.option("--dry-run", "show what would change without indexing")
		.option("--status", "show indexing status for the current project")
		.action(
			async (options?: {
				full?: boolean;
				dryRun?: boolean;
				status?: boolean;
			}) => {
				const chalk = await loadChalk();
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");
				const vectorsPath = path.join(dataDir, "vectors");

				setLogLevel("error");

				const metadata = new SqliteMetadataStore(dbPath);

				try {
					await metadata.initialize();

					if (options?.status) {
						const snapshot =
							await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);

						if (!snapshot) {
							console.log(
								chalk.gray(
									"No completed snapshot found. Run `indexer index` first.",
								),
							);
							return;
						}

						const [files, symbols, dependencies] = await Promise.all([
							metadata.listFiles(DEFAULT_PROJECT_ID, snapshot.id, {}),
							metadata.listSymbols(DEFAULT_PROJECT_ID, snapshot.id),
							metadata.listDependencies(DEFAULT_PROJECT_ID, snapshot.id),
						]);

						const vectors = new LanceDbVectorStore({
							dbPath: vectorsPath,
							vectorSize: config.get("vectorSize"),
						});
						let vectorCount = 0;
						try {
							await vectors.initialize();
							vectorCount = await vectors.countVectors({
								projectId: DEFAULT_PROJECT_ID,
								snapshotId: snapshot.id,
							});
						} finally {
							await vectors.close().catch(() => undefined);
						}

						const languages = new Map<string, number>();
						for (const file of files) {
							const lang = file.languageId || "unknown";
							languages.set(lang, (languages.get(lang) ?? 0) + 1);
						}

						const symbolKinds = new Map<string, number>();
						for (const symbol of symbols) {
							symbolKinds.set(
								symbol.kind,
								(symbolKinds.get(symbol.kind) ?? 0) + 1,
							);
						}

						console.log(
							chalk.green(`Snapshot: ${snapshot.id} (${snapshot.status})`),
						);
						console.log(
							chalk.gray(
								`Created: ${snapshot.createdAt}  |  Git ref: ${snapshot.meta.headCommit ?? "unknown"}`,
							),
						);
						console.log(
							chalk.gray(
								`Files: ${files.length}  |  Symbols: ${symbols.length}  |  Chunks: ${vectorCount}  |  Dependencies: ${dependencies.length}`,
							),
						);

						if (languages.size > 0) {
							const langEntries = Array.from(languages.entries())
								.sort((a, b) => b[1] - a[1])
								.map(([lang, count]) => `${lang}: ${count}`)
								.join(", ");
							console.log(chalk.gray(`Languages: ${langEntries}`));
						}

						if (symbolKinds.size > 0) {
							const kindEntries = Array.from(symbolKinds.entries())
								.sort((a, b) => b[1] - a[1])
								.map(([kind, count]) => `${kind}: ${count}`)
								.join(", ");
							console.log(chalk.gray(`Symbol kinds: ${kindEntries}`));
						}

						return;
					}

					const ora = await loadOra();
					const spinner = ora("Preparing indexer...").start();
					const startedAt = Date.now();

					const vectors = new LanceDbVectorStore({
						dbPath: vectorsPath,
						vectorSize: config.get("vectorSize"),
					});
					const embedder = new OllamaEmbeddingProvider(
						config.get("ollamaBaseUrl"),
						config.get("embeddingModel"),
						config.get("indexBatchSize"),
						config.get("indexConcurrency"),
						config.get("ollamaNumCtx"),
					);
					const git = new SimpleGitOperations();
					let engine: IndexerEngine | null = null;

					try {
						engine = new IndexerEngine({
							projectId: DEFAULT_PROJECT_ID,
							repoRoot: resolvedProjectPath,
							metadata,
							vectors,
							embedder,
							git,
							languagePlugins: createDefaultLanguagePlugins(),
						});
						const latestSnapshot =
							await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
						const headCommit = await git.getHeadCommit(resolvedProjectPath);
						const changedFiles =
							!options?.full && latestSnapshot?.meta.headCommit
								? await git.getChangedFiles(
										resolvedProjectPath,
										latestSnapshot.meta.headCommit,
									)
								: undefined;

						if (options?.dryRun) {
							spinner.stop();

							if (options.full || !latestSnapshot) {
								const plannedFiles = await scanProjectFiles(
									resolvedProjectPath,
									[
										".ts",
										".tsx",
										".mts",
										".cts",
										".js",
										".jsx",
										".mjs",
										".cjs",
										".py",
										".pyi",
										".cs",
										".gd",
									],
								);
								console.log(chalk.green("Dry run complete."));
								console.log(chalk.gray(`Mode: full reindex`));
								console.log(
									chalk.gray(`Files to index: ${plannedFiles.length}`),
								);
							} else {
								const diff = changedFiles ?? {
									added: [],
									modified: [],
									deleted: [],
								};
								console.log(chalk.green("Dry run complete."));
								console.log(chalk.gray("Mode: incremental"));
								console.log(chalk.gray(`Added: ${diff.added.length}`));
								console.log(chalk.gray(`Modified: ${diff.modified.length}`));
								console.log(chalk.gray(`Deleted: ${diff.deleted.length}`));
								console.log(
									chalk.gray(`Changed total: ${countChangedFiles(diff)}`),
								);
							}

							return;
						}

						await engine.initialize();
						spinner.text = options?.full
							? "Running full reindex..."
							: "Running incremental index...";

						const result = await engine.indexProject({
							projectId: DEFAULT_PROJECT_ID,
							repoRoot: resolvedProjectPath,
							gitRef: headCommit ?? "unknown",
							isFullReindex: Boolean(options?.full),
							changedFiles,
							onProgress: (processed, total) => {
								spinner.text = `Indexing files ${processed}/${total}`;
							},
						});

						const snapshot = await metadata.getSnapshot(result.snapshotId);
						const elapsedMs = Date.now() - startedAt;

						spinner.succeed(chalk.green("Index completed successfully."));
						console.log(chalk.gray(`Snapshot: ${result.snapshotId}`));
						console.log(
							chalk.gray(
								`Files indexed: ${result.filesIndexed}${snapshot?.totalFiles ? ` / ${snapshot.totalFiles}` : ""}`,
							),
						);
						console.log(
							chalk.gray(
								`Chunks created: ${await vectors.countVectors({ projectId: DEFAULT_PROJECT_ID, snapshotId: result.snapshotId })}`,
							),
						);
						console.log(
							chalk.gray(`Time elapsed: ${(elapsedMs / 1000).toFixed(2)}s`),
						);
						console.log(chalk.gray(`Errors: ${result.errors.length}`));

						if (result.errors.length > 0) {
							for (const error of result.errors) {
								console.log(chalk.red(`- ${error}`));
							}
						}
					} catch (error) {
						spinner.fail(chalk.red("Indexing failed."));
						const message =
							error instanceof Error ? error.message : String(error);
						console.error(chalk.red(message));
						process.exitCode = 1;
					} finally {
						if (engine) {
							await engine.close().catch(() => undefined);
						} else {
							await Promise.allSettled([vectors.close(), embedder.close()]);
						}
					}
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
