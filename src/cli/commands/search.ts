import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { initLogger } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SearchEngine } from "../../engine/searcher.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { LanceDbVectorStore } from "../../storage/vectors.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { ensureIndexed } from "./ensure-indexed.js";

const SEARCH_FIELDS = [
	"filePath",
	"startLine",
	"endLine",
	"score",
	"primarySymbol",
	"content",
] as const;

type SearchField = (typeof SEARCH_FIELDS)[number];
type SearchResult = Awaited<ReturnType<SearchEngine["search"]>>[number];

function parseSearchFields(input?: string): SearchField[] {
	if (!input) {
		return [...SEARCH_FIELDS];
	}

	const requested = new Set(
		input
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
	);
	const invalid = Array.from(requested).filter(
		(field) => !(SEARCH_FIELDS as readonly string[]).includes(field),
	);

	if (invalid.length > 0) {
		throw new Error(
			`Invalid --fields value: ${invalid.join(", ")}. Allowed fields: ${SEARCH_FIELDS.join(", ")}.`,
		);
	}

	return SEARCH_FIELDS.filter((field) => requested.has(field));
}

function parseMinScore(input?: string): number | undefined {
	if (!input) {
		return undefined;
	}

	const minScore = Number.parseFloat(input);
	if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
		throw new Error("--min-score must be a number between 0 and 1.");
	}

	return minScore;
}

function isDefaultFieldSelection(fields: SearchField[]): boolean {
	return (
		fields.length === SEARCH_FIELDS.length &&
		fields.every((field, index) => field === SEARCH_FIELDS[index])
	);
}

function projectSearchResult(
	result: SearchResult,
	fields: SearchField[],
): Record<string, number | string | null> {
	const projected: Record<string, number | string | null> = {};

	for (const field of fields) {
		switch (field) {
			case "filePath":
				projected.filePath = result.filePath;
				break;
			case "startLine":
				projected.startLine = result.startLine;
				break;
			case "endLine":
				projected.endLine = result.endLine;
				break;
			case "score":
				projected.score = result.score;
				break;
			case "primarySymbol":
				projected.primarySymbol = result.primarySymbol ?? null;
				break;
			case "content":
				projected.content = result.content ?? null;
				break;
		}
	}

	return projected;
}

function formatCustomPlainSummary(
	result: SearchResult,
	fields: SearchField[],
): string {
	const parts: string[] = [];

	for (const field of fields) {
		if (field === "content") {
			continue;
		}

		switch (field) {
			case "filePath":
				parts.push(`filePath: ${result.filePath}`);
				break;
			case "startLine":
				parts.push(`startLine: ${result.startLine}`);
				break;
			case "endLine":
				parts.push(`endLine: ${result.endLine}`);
				break;
			case "score":
				parts.push(`score: ${result.score.toFixed(2)}`);
				break;
			case "primarySymbol":
				parts.push(`primarySymbol: ${result.primarySymbol ?? "(none)"}`);
				break;
		}
	}

	return parts.join(", ") || "(content only)";
}

export function registerSearchCommand(program: Command): void {
	program
		.command("search <query>")
		.description("Search indexed code semantically")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option("--top-k <number>", "number of results to return", "10")
		.option(
			"--path-prefix <string>",
			"limit search to files under a path prefix",
		)
		.option("--chunk-types <string>", "comma-separated chunk types to include")
		.option(
			"--fields <list>",
			`comma-separated output fields: ${SEARCH_FIELDS.join(", ")}`,
		)
		.option(
			"--min-score <number>",
			"filter out results with score below the given value (0..1)",
		)
		.option("--json", "output results as JSON")
		.action(
			async (
				query: string,
				options?: {
					topK?: string;
					pathPrefix?: string;
					chunkTypes?: string;
					fields?: string;
					minScore?: string;
					json?: boolean;
				},
			) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");
				const vectorsPath = path.join(dataDir, "vectors");

				initLogger(dataDir);
				config.load(dataDir);

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
					await ensureIndexed(metadata, resolvedProjectPath, {
						silent: Boolean(options?.json),
					});
					await Promise.all([vectors.initialize(), embedder.initialize()]);

					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error(
							"Auto-indexing did not produce a completed snapshot.",
						);
					}

					const topK = Number.parseInt(options?.topK ?? "10", 10);
					const fields = parseSearchFields(options?.fields);
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
							topK: Number.isFinite(topK) && topK > 0 ? topK : 10,
							pathPrefix: options?.pathPrefix,
							chunkTypes,
							includeContent: fields.includes("content"),
							minScore,
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
								results.map((result) => projectSearchResult(result, fields)),
								null,
								2,
							),
						);
						return;
					}

					for (let i = 0; i < results.length; i++) {
						if (i > 0) console.log("---");
						const result = results[i];

						if (isDefaultFieldSelection(fields)) {
							const symbolPart = result.primarySymbol
								? `, function: ${result.primarySymbol}`
								: "";
							console.log(
								`${result.filePath}:${result.startLine}-${result.endLine} (score: ${result.score.toFixed(2)}${symbolPart})`,
							);
						} else {
							console.log(formatCustomPlainSummary(result, fields));
						}

						if (fields.includes("content")) {
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
