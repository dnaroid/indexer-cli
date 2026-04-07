import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
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
import type { GitDiff, Project } from "../../core/types.js";

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

async function loadProject(
	metadata: SqliteMetadataStore,
	repoRoot: string,
): Promise<Project> {
	const project = (await metadata.listProjects()).find(
		(entry) =>
			path.resolve(entry.workdir) === repoRoot ||
			path.resolve(entry.repoRoot) === repoRoot,
	);

	if (!project) {
		throw new Error("Project not initialized. Run `indexer init` first.");
	}

	return project;
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
		.action(async (options?: { full?: boolean; dryRun?: boolean }) => {
			const chalk = await loadChalk();
			const ora = await loadOra();
			const resolvedProjectPath = process.cwd();
			const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
			const dbPath = path.join(dataDir, "db.sqlite");
			const vectorsPath = path.join(dataDir, "vectors");
			const spinner = ora("Preparing indexer...").start();
			const startedAt = Date.now();

			setLogLevel("error");

			const metadata = new SqliteMetadataStore(dbPath);
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
				await metadata.initialize();
				const project = await loadProject(metadata, resolvedProjectPath);
				engine = new IndexerEngine({
					projectId: project.id,
					repoRoot: resolvedProjectPath,
					metadata,
					vectors,
					embedder,
					git,
					languagePlugins: createDefaultLanguagePlugins(),
				});
				const latestSnapshot = await metadata.getLatestCompletedSnapshot(
					project.id,
				);
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
						const plannedFiles = await scanProjectFiles(resolvedProjectPath, [
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
						]);
						console.log(chalk.green("Dry run complete."));
						console.log(chalk.gray(`Mode: full reindex`));
						console.log(chalk.gray(`Files to index: ${plannedFiles.length}`));
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
					projectId: project.id,
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
						`Chunks created: ${await vectors.countVectors({ projectId: project.id, snapshotId: result.snapshotId })}`,
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
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(message));
				process.exitCode = 1;
			} finally {
				if (engine) {
					await engine.close().catch(() => undefined);
				} else {
					await Promise.allSettled([
						metadata.close(),
						vectors.close(),
						embedder.close(),
					]);
				}
			}
		});
}
