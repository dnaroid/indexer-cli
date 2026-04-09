import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { ensureIndexed } from "./ensure-indexed.js";

export function registerExplainCommand(program: Command): void {
	program
		.command("explain <symbol>")
		.description(
			"Show context for a symbol: signature, description, callers, and module",
		)
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option("--json", "output as JSON")
		.action(async (symbolArg: string, options?: { json?: boolean }) => {
			const resolvedProjectPath = process.cwd();
			const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
			const dbPath = path.join(dataDir, "db.sqlite");
			const isJson = Boolean(options?.json);

			initLogger(dataDir);
			config.load(dataDir);

			const metadata = new SqliteMetadataStore(dbPath);

			try {
				await metadata.initialize();
				await ensureIndexed(metadata, resolvedProjectPath, { silent: isJson });

				const snapshot =
					await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
				if (!snapshot) {
					throw new Error("No completed snapshot found.");
				}

				// Parse "file::symbol" or just "symbol"
				let symbolName: string;
				let filterFilePath: string | undefined;

				if (symbolArg.includes("::")) {
					const parts = symbolArg.split("::");
					filterFilePath = parts[0];
					symbolName = parts[1] ?? symbolArg;
				} else {
					symbolName = symbolArg;
				}

				// Search symbols by name
				const symbols = await metadata.searchSymbols(
					DEFAULT_PROJECT_ID,
					snapshot.id,
					symbolName,
				);

				const matches = filterFilePath
					? symbols.filter((s) => s.filePath === filterFilePath)
					: symbols.filter(
							(s) => s.name.toLowerCase() === symbolName.toLowerCase(),
						);

				if (matches.length === 0) {
					const fuzzy = symbols.slice(0, 5);
					if (isJson) {
						console.log(
							JSON.stringify({ error: "Symbol not found", suggestions: fuzzy }),
						);
					} else {
						console.error(`Symbol "${symbolName}" not found.`);
						if (fuzzy.length > 0) {
							console.error(
								`Did you mean: ${fuzzy.map((s) => s.name).join(", ")}?`,
							);
						}
					}
					process.exitCode = 1;
					return;
				}

				const results = await Promise.all(
					matches.map(async (sym) => {
						const [enrichment, deps, dependents] = await Promise.all([
							metadata.getSymbolEnrichment(
								DEFAULT_PROJECT_ID,
								sym.filePath,
								sym.name,
							),
							metadata.listDependencies(
								DEFAULT_PROJECT_ID,
								snapshot.id,
								sym.filePath,
							),
							metadata.getDependents(
								DEFAULT_PROJECT_ID,
								snapshot.id,
								sym.filePath,
							),
						]);

						return {
							name: sym.name,
							kind: sym.kind,
							file: sym.filePath,
							lines: {
								start: sym.range.start.line,
								end: sym.range.end.line,
							},
							exported: sym.exported,
							signature: sym.signature,
							description: enrichment?.description ?? null,
							callers: dependents
								.map((d) => d.fromPath)
								.filter((v, i, arr) => arr.indexOf(v) === i),
							callees: deps
								.filter((d) => d.dependencyType === "internal" && d.toPath)
								.map((d) => d.toPath as string)
								.filter((v, i, arr) => arr.indexOf(v) === i),
						};
					}),
				);

				if (isJson) {
					console.log(
						JSON.stringify(results.length === 1 ? results[0] : results, null, 2),
					);
					return;
				}

				for (const result of results) {
					console.log(`Symbol: ${result.name}`);
					console.log(`File:   ${result.file} (lines ${result.lines.start}-${result.lines.end})`);
					console.log(`Kind:   ${result.kind}${result.exported ? " (exported)" : ""}`);
					if (result.signature) {
						console.log(`Signature: ${result.signature}`);
					}
					if (result.description) {
						console.log(`\nDescription: ${result.description}`);
					} else {
						console.log(
							"\n(No description yet. Run `indexer-cli enrich` to generate.)",
						);
					}
					if (result.callers.length > 0) {
						console.log(`\nCallers (${result.callers.length}):`);
						for (const caller of result.callers) {
							console.log(`  ${caller}`);
						}
					}
					if (result.callees.length > 0) {
						console.log(`\nCallees (${result.callees.length}):`);
						for (const callee of result.callees) {
							console.log(`  ${callee}`);
						}
					}
					if (results.length > 1) console.log("");
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				console.error(`Explain failed: ${message}`);
				process.exitCode = 1;
			} finally {
				await metadata.close().catch(() => undefined);
			}
		});
}
