import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { initLogger } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SearchEngine } from "../../engine/searcher.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { LanceDbVectorStore } from "../../storage/vectors.js";
import { ensureIndexed } from "./ensure-indexed.js";

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
		.option("--json", "output results as JSON")
		.action(
			async (
				query: string,
				options?: {
					topK?: string;
					pathPrefix?: string;
					chunkTypes?: string;
					json?: boolean;
				},
			) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");
				const vectorsPath = path.join(dataDir, "vectors");

				initLogger(dataDir);

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
					await metadata.initialize();
					await ensureIndexed(metadata, resolvedProjectPath);
					await Promise.all([vectors.initialize(), embedder.initialize()]);

					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error(
							"Auto-indexing did not produce a completed snapshot.",
						);
					}

					const topK = Number.parseInt(options?.topK ?? "10", 10);
					const chunkTypes = options?.chunkTypes
						?.split(",")
						.map((value) => value.trim())
						.filter(Boolean);

					const results = await searchEngine.search(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						query,
						{
							topK: Number.isFinite(topK) && topK > 0 ? topK : 10,
							pathPrefix: options?.pathPrefix,
							chunkTypes,
						},
					);

					if (results.length === 0) {
						if (options?.json) {
							console.log("[]");
						} else {
							console.log("No results found.");
						}
						return;
					}

					if (options?.json) {
						console.log(
							JSON.stringify(
								results.map((r) => ({
									filePath: r.filePath,
									startLine: r.startLine,
									endLine: r.endLine,
									score: r.score,
									primarySymbol: r.primarySymbol ?? null,
									content: r.content ?? null,
								})),
								null,
								2,
							),
						);
						return;
					}

					for (let i = 0; i < results.length; i++) {
						if (i > 0) console.log("---");
						const result = results[i];
						const symbolPart = result.primarySymbol
							? `, function: ${result.primarySymbol}`
							: "";
						console.log(
							`${result.filePath}:${result.startLine}-${result.endLine} (score: ${result.score.toFixed(2)}${symbolPart})`,
						);
						console.log(result.content || "(content unavailable)");
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
