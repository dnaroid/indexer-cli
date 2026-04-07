import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { setLogLevel } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SearchEngine } from "../../engine/searcher.js";
import type { Project } from "../../core/types.js";
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

export function registerSearchCommand(program: Command): void {
	program
		.command("search <query>")
		.description("Search indexed code semantically")
		.option("--top-k <number>", "number of results to return", "10")
		.option(
			"--path-prefix <string>",
			"limit search to files under a path prefix",
		)
		.option("--chunk-types <string>", "comma-separated chunk types to include")
		.action(
			async (
				query: string,
				options?: { topK?: string; pathPrefix?: string; chunkTypes?: string },
			) => {
				const chalk = await loadChalk();
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");
				const vectorsPath = path.join(dataDir, "vectors");

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
				const searchEngine = new SearchEngine(
					metadata,
					vectors,
					embedder,
					resolvedProjectPath,
				);

				try {
					await Promise.all([
						metadata.initialize(),
						vectors.initialize(),
						embedder.initialize(),
					]);

					const project = await loadProject(metadata, resolvedProjectPath);
					const snapshot = await metadata.getLatestCompletedSnapshot(
						project.id,
					);
					if (!snapshot) {
						throw new Error(
							"No completed snapshot found. Run `indexer index` first.",
						);
					}

					const topK = Number.parseInt(options?.topK ?? "10", 10);
					const chunkTypes = options?.chunkTypes
						?.split(",")
						.map((value) => value.trim())
						.filter(Boolean);

					const results = await searchEngine.search(
						project.id,
						snapshot.id,
						query,
						{
							topK: Number.isFinite(topK) && topK > 0 ? topK : 10,
							pathPrefix: options?.pathPrefix,
							chunkTypes,
						},
					);

					if (results.length === 0) {
						console.log(chalk.gray("No results found."));
						return;
					}

					for (const result of results) {
						const symbolPart = result.primarySymbol
							? `, function: ${result.primarySymbol}`
							: "";
						console.log(
							`${chalk.green(`${result.filePath}:${result.startLine}-${result.endLine}`)} ${chalk.gray(`(score: ${result.score.toFixed(2)}${symbolPart})`)}`,
						);
						console.log(chalk.gray("─────────────────────────────"));
						console.log(result.content || chalk.gray("(content unavailable)"));
						console.log(chalk.gray("─────────────────────────────"));
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(chalk.red(`Search failed: ${message}`));
					process.exitCode = 1;
				} finally {
					await Promise.allSettled([
						metadata.close(),
						vectors.close(),
						embedder.close(),
					]);
				}
			},
		);
}
