import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { initLogger } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SearchEngine } from "../../engine/searcher.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import { ensureIndexed } from "./ensure-indexed.js";
import { formatAutoIndexResult } from "../format/compact.js";
import { normalizePathPrefix } from "./path-prefix.js";
import { resolveInitializedProjectRoot } from "../project-root.js";

function parseMinScore(
	input?: string,
	fallback: number = 0.55,
): number | undefined {
	if (!input) {
		return fallback;
	}

	const minScore = Number.parseFloat(input);
	if (!Number.isFinite(minScore) || minScore < 0) {
		throw new Error("--min-score must be a non-negative number.");
	}

	return minScore;
}

function parseSearchMode(
	input?: string,
): "hybrid" | "semantic" | "lexical" | "symbol" {
	if (!input) return "hybrid";
	if (
		input === "hybrid" ||
		input === "semantic" ||
		input === "lexical" ||
		input === "symbol"
	) {
		return input;
	}
	throw new Error("--mode must be one of: hybrid, semantic, lexical, symbol.");
}

const CHUNK_TYPE_ALIASES: Record<string, string[]> = {
	api: ["types", "declaration", "module_section"],
	impl: ["impl"],
	imports: ["imports", "preamble"],
	tests: ["impl", "types", "full_file"],
};

function parseChunkTypes(input?: string): string[] | undefined {
	const rawValues = input
		?.split(",")
		.map((value) => value.trim())
		.filter(Boolean);

	if (!rawValues || rawValues.length === 0) {
		return undefined;
	}

	const chunkTypes = new Set<string>();
	for (const value of rawValues) {
		const aliasValues = CHUNK_TYPE_ALIASES[value];
		if (aliasValues) {
			for (const aliasValue of aliasValues) {
				chunkTypes.add(aliasValue);
			}
			continue;
		}
		chunkTypes.add(value);
	}

	return Array.from(chunkTypes);
}

function isLikelyBroadQuery(query: string): boolean {
	return query
		.trim()
		.split(/\s+/)
		.filter(Boolean).length <= 2;
}

function formatNoResultsWarning(minScore: number | undefined): string {
	if (typeof minScore === "number" && minScore > 0.55) {
		const suggestedMinScore = Math.max(0.1, Math.min(0.55, minScore - 0.2));
		return `WARN no-results min-score=${minScore.toFixed(2)} suggestion='try --min-score ${suggestedMinScore.toFixed(2)}'`;
	}
	return "WARN no-results suggestion='try broader query or lower --min-score'";
}

export function registerSearchCommand(program: Command): void {
	program
		.command("search <query>")
		.description("Search indexed code semantically")
		.option("--max-files <number>", "number of results to return", "3")
		.option(
			"--path-prefix <string>",
			"limit search to files under a path prefix",
		)
		.option("--chunk-types <string>", "comma-separated chunk types to include")
		.option(
			"--mode <mode>",
			"ranking mode: hybrid, semantic, lexical, or symbol",
			"hybrid",
		)
		.option(
			"--include-imports",
			"include imports/preamble chunks (excluded by default)",
		)
		.option(
			"--min-score <number>",
			"filter out results below the final ranking score (semantic is usually 0..1; hybrid may exceed 1; default: from config)",
		)
		.option(
			"--include-content",
			"include matched code content in output (omitted by default to save tokens)",
		)
		.option("--dedupe-file", "return at most one result per file")
		.option("--dedupe-symbol", "return at most one result per file/symbol pair")
		.option("--cluster", "group nearby similar chunks and show one representative")
		.option("--exclude-tests", "exclude test files from results")
		.option("--include-tests", "include test files without the default test penalty")
		.action(
			async (
				query: string,
				options?: {
					maxFiles?: string;
					pathPrefix?: string;
					chunkTypes?: string;
					mode?: string;
					includeImports?: boolean;
					minScore?: string;
					includeContent?: boolean;
					dedupeFile?: boolean;
					dedupeSymbol?: boolean;
					cluster?: boolean;
					excludeTests?: boolean;
					includeTests?: boolean;
				},
			) => {
				let resolvedProjectPath: string;
				try {
					const resolved = resolveInitializedProjectRoot();
					resolvedProjectPath = resolved.projectRoot;
					if (resolved.notice) {
						console.log(resolved.notice);
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`Search failed: ${message}`);
					process.exitCode = 1;
					return;
				}
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
					const indexResult = await ensureIndexed(metadata, resolvedProjectPath, {
						silent: !process.stderr.isTTY,
					});
					console.log(formatAutoIndexResult(indexResult));
					if (indexResult.status === "failed") {
						process.exitCode = 1;
						return;
					}
					await Promise.all([vectors.initialize(), embedder.initialize()]);

					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error(
							"Auto-indexing did not produce a completed snapshot.",
						);
					}

					const maxFiles = Number.parseInt(options?.maxFiles ?? "3", 10);
					const minScore = parseMinScore(
						options?.minScore,
						config.get("searchMinScore"),
					);
					const mode = parseSearchMode(options?.mode);
					const chunkTypes = parseChunkTypes(options?.chunkTypes);

					let effectivePathPrefix = normalizePathPrefix(options?.pathPrefix);
					if (effectivePathPrefix) {
						const prefixFiles = await metadata.listFiles(
							DEFAULT_PROJECT_ID,
							snapshot.id,
							{ pathPrefix: effectivePathPrefix },
						);
						if (prefixFiles.length === 0) {
							console.log(
								`WARN path-prefix-missing prefix=${effectivePathPrefix} fallback=project`,
							);
							effectivePathPrefix = undefined;
						}
					}

					const results = await searchEngine.search(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						query,
						{
							topK: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 3,
							mode,
							pathPrefix: effectivePathPrefix,
							chunkTypes,
							includeContent: options?.includeContent ?? false,
							includeReasonCodes: true,
							minScore,
							includeImportChunks: options?.includeImports,
							dedupeFile: options?.dedupeFile,
							dedupeSymbol: options?.dedupeSymbol,
							cluster: options?.cluster,
							excludeTests: options?.excludeTests,
							includeTests: options?.includeTests,
						},
					);

					if (results.length === 0) {
						console.log(formatNoResultsWarning(minScore));
						return;
					}
					if (isLikelyBroadQuery(query)) {
						const lowConfidenceCount = results.filter(
							(result) => result.score < 0.6,
						).length;
						if (lowConfidenceCount === results.length) {
							console.log(
								`WARN broad-query terms=${query.trim().split(/\s+/).filter(Boolean).length} results-low-confidence suggestion='add symbol or path-prefix'`,
							);
						}
					}

					for (let i = 0; i < results.length; i++) {
						const result = results[i];
						const symbolPart = result.primarySymbol
							? `, function: ${result.primarySymbol}`
							: "";
						const reasonPart = `, why=${result.reasonCode ?? mode}`;
						console.log(
							`${result.filePath}:${result.startLine}-${result.endLine} (score: ${result.score.toFixed(2)}, rank=${mode}${symbolPart}${reasonPart})`,
						);
						if (options?.includeContent) {
							console.log(result.content || "(content unavailable)");
						}
					}
					const nextReads = results
						.slice(0, 3)
						.map((result) => `${result.filePath}:${result.startLine}-${result.endLine}`);
					if (nextReads.length > 0) {
						console.log(`Read next: ${nextReads.join(", ")}`);
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
