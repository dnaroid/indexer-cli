import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { LanceDbVectorStore } from "../../storage/vectors.js";

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

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function ensureGitignoreEntry(projectRoot: string): Promise<void> {
	const gitignorePath = path.join(projectRoot, ".gitignore");
	const entry = ".indexer-cli/";

	if (!(await pathExists(gitignorePath))) {
		await writeFile(gitignorePath, `${entry}\n`, "utf8");
		return;
	}

	const current = await readFile(gitignorePath, "utf8");
	const lines = current.split(/\r?\n/).map((line) => line.trim());
	if (lines.includes(entry)) {
		return;
	}

	const nextContent = current.endsWith("\n")
		? `${current}${entry}\n`
		: `${current}\n${entry}\n`;
	await writeFile(gitignorePath, nextContent, "utf8");
}

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize indexer storage for a project")
		.action(async () => {
			const chalk = await loadChalk();
			const resolvedProjectPath = process.cwd();
			const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
			const dbPath = path.join(dataDir, "db.sqlite");
			const vectorsPath = path.join(dataDir, "vectors");
			const configPath = path.join(dataDir, "config.json");

			setLogLevel("error");

			let metadata: SqliteMetadataStore | null = null;
			let vectors: LanceDbVectorStore | null = null;

			try {
				await mkdir(dataDir, { recursive: true });
				await mkdir(vectorsPath, { recursive: true });

				metadata = new SqliteMetadataStore(dbPath);
				await metadata.initialize();

				vectors = new LanceDbVectorStore({
					dbPath: vectorsPath,
					vectorSize: config.get("vectorSize"),
				});
				await vectors.initialize();

				await writeFile(
					configPath,
					`${JSON.stringify(config.getAll(), null, 2)}\n`,
					"utf8",
				);
				await ensureGitignoreEntry(resolvedProjectPath);

				const existingProject = (await metadata.listProjects()).find(
					(project) =>
						path.resolve(project.workdir) === resolvedProjectPath ||
						path.resolve(project.repoRoot) === resolvedProjectPath,
				);

				const sourceType = (await pathExists(
					path.join(resolvedProjectPath, ".git"),
				))
					? "local"
					: "local-nogit";

				const project =
					existingProject ??
					(await metadata.createProject({
						name: path.basename(resolvedProjectPath),
						sourceType,
						repoRoot: resolvedProjectPath,
						workdir: resolvedProjectPath,
					}));

				console.log(
					chalk.green(`Initialized indexer-cli in ${resolvedProjectPath}`),
				);
				console.log(chalk.gray(`Project ID: ${project.id}`));
				console.log(chalk.gray(`SQLite: ${dbPath}`));
				console.log(chalk.gray(`Vectors: ${vectorsPath}`));
				console.log(chalk.gray(`Config: ${configPath}`));

				const ora = await loadOra();
				const spinner = ora("Preparing indexer...").start();
				const startedAt = Date.now();

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
						projectId: project.id,
						repoRoot: resolvedProjectPath,
						metadata,
						vectors,
						embedder,
						git,
						languagePlugins: createDefaultLanguagePlugins(),
					});
					const headCommit = await git.getHeadCommit(resolvedProjectPath);

					await engine.initialize();
					spinner.text = "Running initial index...";

					const result = await engine.indexProject({
						projectId: project.id,
						repoRoot: resolvedProjectPath,
						gitRef: headCommit ?? "unknown",
						isFullReindex: true,
						changedFiles: undefined,
						onProgress: (processed, total) => {
							spinner.text = `Indexing files ${processed}/${total}`;
						},
					});

					const elapsedMs = Date.now() - startedAt;

					spinner.succeed(chalk.green("Index completed successfully."));
					console.log(chalk.gray(`Snapshot: ${result.snapshotId}`));
					console.log(chalk.gray(`Files indexed: ${result.filesIndexed}`));
					console.log(
						chalk.gray(
							`Chunks created: ${await vectors.countVectors({ projectId: project.id, snapshotId: result.snapshotId })}`,
						),
					);
					console.log(
						chalk.gray(`Time elapsed: ${(elapsedMs / 1000).toFixed(2)}s`),
					);

					if (result.errors.length > 0) {
						for (const error of result.errors) {
							console.log(chalk.red(`- ${error}`));
						}
					}
				} catch (indexError) {
					spinner.fail(chalk.red("Indexing failed."));
					const message =
						indexError instanceof Error
							? indexError.message
							: String(indexError);
					console.error(chalk.red(message));
					process.exitCode = 1;
				} finally {
					if (engine) {
						await engine.close().catch(() => undefined);
					} else {
						await embedder.close().catch(() => undefined);
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Failed to initialize project: ${message}`));
				process.exitCode = 1;
			} finally {
				if (metadata) {
					await metadata.close().catch(() => undefined);
				}
				if (vectors) {
					await vectors.close().catch(() => undefined);
				}
			}
		});
}
