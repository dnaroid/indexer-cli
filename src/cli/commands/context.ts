import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { initLogger } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SearchEngine } from "../../engine/searcher.js";
import {
	KnowledgeContextEngine,
	formatKnowledgeContext,
} from "../../knowledge/context.js";
import { KnowledgeSearchEngine } from "../../knowledge/search.js";
import {
	KnowledgeService,
} from "../../knowledge/service.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import { formatAutoIndexResult } from "../format/compact.js";
import { resolveInitializedProjectRoot } from "../project-root.js";
import { ensureIndexed } from "./ensure-indexed.js";
import { withSnapshotReadLease } from "../../core/snapshot-retention.js";

function parsePositiveInteger(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Expected a positive integer, got ${JSON.stringify(value)}.`);
	}
	return parsed;
}

export function registerContextCommand(program: Command): void {
	program
		.command("context <query>")
		.description("Build a compact knowledge + implementation context pack")
		.option("--budget <tokens>", "approximate output token budget", "1400")
		.option("--max-specs <number>", "maximum knowledge entries", "4")
		.option("--max-code <number>", "maximum implementation files/ranges", "6")
		.option("--max-tests <number>", "maximum test hints", "4")
		.option("--path-prefix <path>", "limit implementation discovery to a code area")
		.option("--include-secondary", "allow design-only knowledge in retrieval")
		.option("--mode <mode>", "retrieval mode: hybrid, semantic, or lexical", "hybrid")
		.option("--verbose", "include titles and retrieval reason-code details")
		.action(
			async (
				query: string,
				options: {
					budget?: string;
					maxSpecs?: string;
					maxCode?: string;
					maxTests?: string;
					pathPrefix?: string;
					includeSecondary?: boolean;
					mode?: "hybrid" | "semantic" | "lexical";
					verbose?: boolean;
				},
			) => {
				if (options.mode && !["hybrid", "semantic", "lexical"].includes(options.mode)) throw new Error("--mode must be hybrid, semantic, or lexical.");
				const offline = options.mode === "lexical";
				let repoRoot: string;
				try {
					const resolved = resolveInitializedProjectRoot();
					repoRoot = resolved.projectRoot;
					if (resolved.notice) console.log(resolved.notice);
				} catch (error) {
					console.error(
						`Context failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					process.exitCode = 1;
					return;
				}

				const dataDir = path.join(repoRoot, ".indexer-cli");
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
				const knowledgeEmbedder = new OllamaEmbeddingProvider(
					config.get("ollamaBaseUrl"),
					config.get("knowledgeEmbeddingModel"),
					config.get("indexBatchSize"),
					config.get("indexConcurrency"),
					config.get("ollamaNumCtx"),
				);

				try {
					await metadata.initialize();
					const indexResult = offline ? undefined : await ensureIndexed(metadata, repoRoot, { silent: !process.stderr.isTTY });
					if (indexResult) console.log(formatAutoIndexResult(indexResult));
					await withSnapshotReadLease(repoRoot, async () => {
						const snapshot = await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
						if (!snapshot) throw new Error("No completed index snapshot is available.");
						if (indexResult?.status === "failed") {
							console.error(`Auto-index failed: ${indexResult.message ?? indexResult.reason}; using the existing completed snapshot (it may be stale).`);
						}
						let embeddingsAvailable = !offline;
						try {
							if (!offline) {
								await vectors.initialize();
								await Promise.all([embedder.initialize(), knowledgeEmbedder.initialize()]);
							}
						} catch (error) {
							embeddingsAvailable = false;
							console.error(`Embedding provider unavailable; context uses bounded lexical knowledge retrieval only: ${error instanceof Error ? error.message : String(error)}`);
						}

						const service = new KnowledgeService(
							DEFAULT_PROJECT_ID,
							repoRoot,
							metadata,
							metadata,
						);
						const knowledgeSearch = new KnowledgeSearchEngine(
							DEFAULT_PROJECT_ID,
							snapshot.id,
							metadata,
							metadata,
							vectors,
							embeddingsAvailable ? knowledgeEmbedder : null,
							service,
						);
						const rawCodeSearch = new SearchEngine(metadata, vectors, embedder, repoRoot);
						const codeSearch = {
							search: async (...args: Parameters<SearchEngine["search"]>) => {
								try {
									return await rawCodeSearch.search(...args);
								} catch (error) {
									// A provider can fail after initialization. Hybrid context must
									// remain useful, but do not relabel lexical results as semantic.
									if (args[3]?.mode !== "hybrid") throw error;
									console.error(`Code semantic retrieval degraded to lexical: ${error instanceof Error ? error.message : String(error)}`);
									return rawCodeSearch.search(args[0], args[1], args[2], { ...args[3], mode: "lexical" });
								}
							},
						};
						const engine = new KnowledgeContextEngine(
							DEFAULT_PROJECT_ID,
							snapshot.id,
							metadata,
							metadata,
							knowledgeSearch,
							codeSearch,
						);
						const pack = await engine.build(query, {
							maxSpecs: parsePositiveInteger(options.maxSpecs, 4),
							maxCode: parsePositiveInteger(options.maxCode, 6),
							maxTests: parsePositiveInteger(options.maxTests, 4),
							includeSecondary: options.includeSecondary,
							pathPrefix: options.pathPrefix?.replace(/\\/g, "/").replace(/^\.\//, ""),
							mode: options.mode,
						});
						process.stdout.write(
							formatKnowledgeContext(
								pack,
								parsePositiveInteger(options.budget, 1400),
								options.verbose,
							),
						);
					});
				} catch (error) {
					console.error(
						`Context failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					process.exitCode = 1;
				} finally {
					await Promise.allSettled([
						vectors.close(),
						embedder.close(),
						knowledgeEmbedder.close(),
						metadata.close(),
					]);
				}
			},
		);
}
