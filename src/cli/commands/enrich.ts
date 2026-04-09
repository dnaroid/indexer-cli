import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { EnricherEngine } from "../../engine/enricher.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { ensureIndexed } from "./ensure-indexed.js";

export function registerEnrichCommand(program: Command): void {
	program
		.command("enrich")
		.description(
			"Generate Ollama-powered summaries and symbol descriptions for indexed files",
		)
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option("--module <path>", "enrich a specific module or path prefix")
		.option("--force", "re-enrich even if content is unchanged")
		.option("--dry-run", "preview what would be enriched without generating")
		.option(
			"--model <model>",
			"Ollama model to use (overrides config enrichModel)",
		)
		.action(
			async (options?: {
				module?: string;
				force?: boolean;
				dryRun?: boolean;
				model?: string;
			}) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");

				initLogger(dataDir);
				config.load(dataDir);

				const metadata = new SqliteMetadataStore(dbPath);

				try {
					await metadata.initialize();
					await ensureIndexed(metadata, resolvedProjectPath, {
						silent: Boolean(options?.dryRun),
					});

					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error("No completed snapshot found.");
					}

					const model = options?.model ?? config.get("enrichModel");
					const concurrency = config.get("enrichConcurrency");

					const enricher = new EnricherEngine(
						config.get("ollamaBaseUrl"),
						model,
						resolvedProjectPath,
						metadata,
					);

					if (options?.dryRun) {
						console.log("Dry run: scanning files to enrich...");
					} else {
						console.log(`Enriching with model: ${model}`);
						if (options?.module) {
							console.log(`Scope: ${options.module}`);
						}
					}

					const result = await enricher.enrichProject(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						{
							pathPrefix: options?.module,
							force: options?.force,
							dryRun: options?.dryRun,
							concurrency,
							onProgress: (done, total) => {
								console.log(`  ${done}/${total} files...`);
							},
						},
					);

					if (options?.dryRun) {
						console.log("\nDry run complete.");
						console.log(`  Files to enrich: ${result.filesEnriched}`);
						console.log(`  Files up-to-date: ${result.filesSkipped}`);
					} else {
						console.log("\nEnrichment complete.");
						console.log(`  Files enriched: ${result.filesEnriched}`);
						console.log(`  Symbols enriched: ${result.symbolsEnriched}`);
						console.log(`  Files skipped (up-to-date): ${result.filesSkipped}`);
						console.log(`  Errors: ${result.errors.length}`);
						for (const error of result.errors) {
							console.error(`  - ${error}`);
						}
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`Enrich failed: ${message}`);
					process.exitCode = 1;
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
