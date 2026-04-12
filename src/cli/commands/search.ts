import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { initLogger } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SearchEngine } from "../../engine/searcher.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { ensureIndexed } from "./ensure-indexed.js";

type SearchResult = Awaited<ReturnType<SearchEngine["search"]>>[number];

function parseMinScore(input?: string): number | undefined {
	if (!input) {
		return 0.45;
	}

	const minScore = Number.parseFloat(input);
	if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
		throw new Error("--min-score must be a number between 0 and 1.");
	}

	return minScore;
}

export function registerSearchCommand(program: Command): void {
	program
		.command("search <query>")
		.description("Search indexed code semantically")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option("--max-files <number>", "number of results to return", "3")
		.option(
			"--path-prefix <string>",
			"limit search to files under a path prefix",
		)
		.option("--chunk-types <string>", "comma-separated chunk types to include")
		.option(
			"--include-imports",
			"include imports/preamble chunks (excluded by default)",
		)
		.option(
			"--min-score <number>",
			"filter out results with score below the given value (0..1, default: 0.45)",
		)
		.option(
			"--include-content",
			"include matched code content in output (omitted by default to save tokens)",
		)
		.action(
			async (
				query: string,
				options?: {
					maxFiles?: string;
					pathPrefix?: string;
					chunkTypes?: string;
					includeImports?: boolean;
					minScore?: string;
					includeContent?: boolean;
				},
			) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");

				initLogger(dataDir);
				config.load(dataDir);

				const metadata = new SqliteMetadataStore(dbPath);
				const vectors = new SqliteVecVectorStore({
					dbPath,
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
					await metadata.initialize();
					await ensureIndexed(metadata, resolvedProjectPath, {
						silent: false,
					});
					await Promise.all([vectors.initialize(), embedder.initialize()]);

					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error(
							"Auto-indexing did not produce a completed snapshot.",
						);
					}

					const maxFiles = Number.parseInt(options?.maxFiles ?? "3", 10);
					const minScore = parseMinScore(options?.minScore);
					const chunkTypes = options?.chunkTypes
						?.split(",")
						.map((value) => value.trim())
						.filter(Boolean);

					const results = await searchEngine.search(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						query,
						{
							topK: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 3,
							pathPrefix: options?.pathPrefix,
							chunkTypes,
							includeContent: options?.includeContent ?? false,
							minScore,
							includeImportChunks: options?.includeImports,
						},
					);

					if (results.length === 0) {
						console.log("No results found.");
						return;
					}

					for (let i = 0; i < results.length; i++) {
						const result = results[i];
						const symbolPart = result.primarySymbol
							? `, function: ${result.primarySymbol}`
							: "";
						console.log(
							`${result.filePath}:${result.startLine}-${result.endLine} (score: ${result.score.toFixed(2)}${symbolPart})`,
						);
						if (options?.includeContent) {
							console.log(result.content || "(content unavailable)");
						}
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`Search failed: ${message}`);
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
