import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { initLogger } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SearchEngine } from "../../engine/searcher.js";
import { UnifiedSearchEngine, type UnifiedSearchDomain } from "../../engine/unified-search.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import { ensureIndexed } from "./ensure-indexed.js";
import { formatAutoIndexResult } from "../format/compact.js";
import { normalizePathPrefix } from "./path-prefix.js";
import { resolveInitializedProjectRoot } from "../project-root.js";
import { withSnapshotReadLease } from "../../core/snapshot-retention.js";

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
		.description("Search indexed code and documents")
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
			"filter out results below the calibrated final relevance score (0..1; default: from config)",
		)
		.option(
			"--include-content",
			"include matched content in output (omitted by default to save tokens)",
		)
		.option("--dedupe-file", "return at most one result per file")
		.option("--dedupe-symbol", "return at most one result per file/symbol pair")
		.option("--cluster", "group nearby similar chunks and show one representative")
		.option("--exclude-tests", "exclude test files from results")
		.option("--domain <domain>", "search domain: all, code, or document", "all")
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
					domain?: string;
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
				const mode = parseSearchMode(options?.mode);
				const domain = options?.domain ?? "all";
				if (!["all", "code", "document"].includes(domain)) throw new Error("--domain must be all, code, or document.");

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
				const documentEmbedder = new OllamaEmbeddingProvider(
					config.get("ollamaBaseUrl"), config.get("knowledgeEmbeddingModel"),
					config.get("indexBatchSize"), config.get("indexConcurrency"), config.get("ollamaNumCtx"),
				);

				try {
					await metadata.initialize();
					const indexResult = mode === "lexical" || mode === "symbol" ? undefined : await ensureIndexed(metadata, resolvedProjectPath, {
						silent: !process.stderr.isTTY,
					});
					if (indexResult) console.log(formatAutoIndexResult(indexResult));
					let effectiveMode = mode;
					if (mode === "semantic" || mode === "hybrid") {
						try { await vectors.initialize(); }
						catch (error) {
							if (mode === "semantic") throw error;
							console.log("WARN vector storage unavailable; using lexical results.");
							effectiveMode = "lexical";
						}
					}

					await withSnapshotReadLease(resolvedProjectPath, async () => {
					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error(
							"Auto-indexing did not produce a completed snapshot.",
						);
					}
					if (indexResult?.status === "failed") console.log("WARN auto-index failed; using the existing completed snapshot (it may be stale).");

					const maxFiles = Number.parseInt(options?.maxFiles ?? "3", 10);
					const minScore = parseMinScore(
						options?.minScore,
						config.get("searchMinScore"),
					);
					const chunkTypes = parseChunkTypes(options?.chunkTypes);

					let effectivePathPrefix = normalizePathPrefix(options?.pathPrefix);
					if (effectivePathPrefix) {
						const prefixFiles = await metadata.listFiles(
							DEFAULT_PROJECT_ID,
							snapshot.id,
							{ pathPrefix: effectivePathPrefix },
						);
						const documentChunks = domain === "code" ? [] : await metadata.listKnowledgeChunks(DEFAULT_PROJECT_ID, snapshot.id);
						const hasDocuments = documentChunks.some(chunk => chunk.filePath === effectivePathPrefix || chunk.filePath.startsWith(`${effectivePathPrefix}/`));
						if (prefixFiles.length === 0 && !hasDocuments) {
							console.log(
								`WARN path-prefix-missing prefix=${effectivePathPrefix} fallback=project`,
							);
							effectivePathPrefix = undefined;
						}
					}

					const unified = new UnifiedSearchEngine(searchEngine, DEFAULT_PROJECT_ID, snapshot.id, metadata, vectors, documentEmbedder, metadata);
					const results = await unified.search(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						query,
						{
							topK: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 3,
							mode: effectiveMode,
							domain: domain as UnifiedSearchDomain,
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
					for (const warning of unified.getWarnings()) console.log(`WARN ${warning}`);

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
						const document = result.domain === "document";
						const resultPath = document ? result.path : result.filePath;
						const range = document ? result.bestRanges[0] ?? { startLine: 1, endLine: 1 } : result;
						const symbolPart = !document && result.primarySymbol
							? `, function: ${result.primarySymbol}`
							: "";
						const reasonPart = `, why=${document ? result.reasonCodes.join("+") || mode : result.reasonCode ?? mode}`;
						console.log(
							`${resultPath}:${range.startLine}-${range.endLine} (score: ${result.score.toFixed(2)}, rank=${mode}, domain=${result.domain}${symbolPart}${reasonPart})`,
						);
						if (document) console.log(`  kind=${result.kind} status=${result.status} provenance=${result.provenance.kind}/${result.provenance.status}`);
						// Count the physical lines printed next so consumers can distinguish
						// formatter headers from header-shaped text inside raw content.
						const content = result.content || (document ? result.summary : "(content unavailable)");
						console.log(`Content: ${options?.includeContent ? content.split("\n").length : 0} lines`);
						if (options?.includeContent) {
							console.log(content);
						}
					}
					const nextReads = results
						.slice(0, 3)
						.map((result) => result.domain === "document" ? `${result.path}:${result.bestRanges[0]?.startLine ?? 1}-${result.bestRanges[0]?.endLine ?? 1}` : `${result.filePath}:${result.startLine}-${result.endLine}`);
					if (nextReads.length > 0) {
						console.log(`Read next: ${nextReads.join(", ")}`);
					}
					});
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
						documentEmbedder.close(),
					]);
				}
			},
		);
}
