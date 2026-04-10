import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import {
	DEFAULT_PROJECT_ID,
	type ContextPackProfile,
	type ContextPackResult,
} from "../../core/types.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { ContextPackBuilder } from "../../engine/context-pack.js";
import { SimpleGitOperations } from "../../engine/git.js";
import { SearchEngine } from "../../engine/searcher.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { isJsonOutput } from "../output-mode.js";
import { ensureIndexed } from "./ensure-indexed.js";

function parseBudget(input?: string): number | undefined {
	if (!input) {
		return undefined;
	}

	const budget = Number.parseInt(input, 10);
	if (![800, 1500, 2500].includes(budget)) {
		throw new Error("--budget must be one of: 800, 1500, 2500.");
	}

	return budget;
}

function parseProfile(input?: string): ContextPackProfile | undefined {
	if (!input) {
		return undefined;
	}

	if (input === "routing" || input === "balanced" || input === "deep") {
		return input;
	}

	throw new Error("--profile must be one of: routing, balanced, deep.");
}

function parsePositiveInt(
	optionName: string,
	input?: string,
): number | undefined {
	if (!input) {
		return undefined;
	}

	const parsed = Number.parseInt(input, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${optionName} must be a positive integer.`);
	}

	return parsed;
}

function parseMinScore(input?: string): number | undefined {
	if (!input) {
		return undefined;
	}

	const parsed = Number.parseFloat(input);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		throw new Error("--min-score must be a number between 0 and 1.");
	}

	return parsed;
}

function formatText(result: ContextPackResult): void {
	console.log("## Selected Scope\n");
	console.log(
		`Modules: ${result.selected_scope.pathPrefixes.length > 0 ? result.selected_scope.pathPrefixes.join(", ") : "(none)"}`,
	);
	console.log(
		`Confidence: ${(result.selected_scope.confidence * 100).toFixed(0)}% (${result._meta.confidenceBand})`,
	);
	for (const reason of result.selected_scope.why) {
		console.log(`- ${reason}`);
	}

	if (result.module_goals.length > 0) {
		console.log("\n## Module Goals\n");
		for (const goal of result.module_goals) {
			console.log(
				`${goal.module} — ${goal.goal} (${(goal.confidence * 100).toFixed(0)}%)`,
			);
		}
	}

	if (result.structure_slice.files.length > 0) {
		console.log("\n## Structure Slice\n");
		for (const file of result.structure_slice.files) {
			console.log(`${file.path} [${file.module}]`);
		}
	}

	if (result.structure_slice.keySymbols.length > 0) {
		console.log("\n## Key Symbols\n");
		for (const symbol of result.structure_slice.keySymbols) {
			const signature = symbol.signature ? ` — ${symbol.signature}` : "";
			console.log(
				`${symbol.file}::${symbol.name} (${symbol.kind})${signature}`,
			);
		}
	}

	if (result.semantic_hits.length > 0) {
		console.log("\n## Semantic Hits\n");
		for (const hit of result.semantic_hits) {
			const symbol = hit.primarySymbol ? `, symbol: ${hit.primarySymbol}` : "";
			console.log(
				`${hit.filePath} (score: ${hit.score.toFixed(2)}${symbol}) — ${hit.reason}`,
			);
			if (hit.snippet) {
				console.log(hit.snippet);
			}
		}
	}

	if (result.next_reads.length > 0) {
		console.log("\n## Next Reads\n");
		for (const nextRead of result.next_reads) {
			console.log(`${nextRead.file} — ${nextRead.reason}`);
		}
	}

	console.log("\n## Meta\n");
	console.log(`Budget: ${result._meta.budget} (${result._meta.profile})`);
	console.log(`Estimated tokens: ${result._meta.estimatedTokens}`);
	console.log(`Omitted: ${result._meta.omitted.join(", ")}`);
}

export function registerContextPackCommand(program: Command): void {
	program
		.command("context-pack <task>")
		.description("Build a token-aware routing pack for an agent task")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option("--budget <number>", "token budget: 800, 1500, or 2500")
		.option("--profile <profile>", "routing, balanced, or deep")
		.option(
			"--scope <scope>",
			"all, changed, relevant-to:<path>, or path-prefix:<path>",
		)
		.option("--max-modules <number>", "maximum number of modules in the pack")
		.option(
			"--max-files <number>",
			"maximum number of files in the structure slice",
		)
		.option(
			"--max-snippets <number>",
			"maximum number of semantic evidence snippets",
		)
		.option(
			"--min-score <number>",
			"filter out semantic hits below the given score (0..1)",
		)
		.option("--explain-symbols", "include symbol signatures in the pack output")
		.option("--txt", "output results as human-readable text")
		.action(
			async (
				task: string,
				options?: {
					budget?: string;
					profile?: string;
					scope?: string;
					maxModules?: string;
					maxFiles?: string;
					maxSnippets?: string;
					minScore?: string;
					explainSymbols?: boolean;
					txt?: boolean;
				},
			) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");
				const isJson = isJsonOutput(options);

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
				const builder = new ContextPackBuilder(
					metadata,
					searchEngine,
					new SimpleGitOperations(),
					resolvedProjectPath,
				);

				try {
					await metadata.initialize();
					await ensureIndexed(metadata, resolvedProjectPath, {
						silent: isJson,
					});
					await Promise.all([vectors.initialize(), embedder.initialize()]);

					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error(
							"Auto-indexing did not produce a completed snapshot.",
						);
					}

					const result = await builder.build(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						task,
						{
							budget: parseBudget(options?.budget),
							profile: parseProfile(options?.profile),
							scope: options?.scope,
							maxModules: parsePositiveInt(
								"--max-modules",
								options?.maxModules,
							),
							maxFiles: parsePositiveInt("--max-files", options?.maxFiles),
							maxSnippets: parsePositiveInt(
								"--max-snippets",
								options?.maxSnippets,
							),
							minScore: parseMinScore(options?.minScore),
							explainSymbols: options?.explainSymbols,
							excludePathPatterns: config.get("excludePaths"),
						},
					);

					if (isJson) {
						console.log(JSON.stringify(result, null, 2));
					} else {
						formatText(result);
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (isJson) {
						console.error(JSON.stringify({ error: message }, null, 2));
					} else {
						console.error(`Context-pack command failed: ${message}`);
					}
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
