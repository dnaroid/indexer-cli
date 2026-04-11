import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { isJsonOutput } from "../output-mode.js";
import { ensureIndexed } from "./ensure-indexed.js";

export function registerExplainCommand(program: Command): void {
	program
		.command("explain <symbol>")
		.description("Show context for a symbol: signature, callers, and module")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option("--txt", "output results as human-readable text")
		.action(async (symbolArg: string, options?: { txt?: boolean }) => {
			const resolvedProjectPath = process.cwd();
			const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
			const dbPath = path.join(dataDir, "db.sqlite");
			const isJson = isJsonOutput(options);

			const rankSymbolMatch = (
				candidateName: string,
				query: string,
			): number => {
				if (candidateName === query) {
					return 0;
				}

				const candidateNameLower = candidateName.toLowerCase();
				const queryLower = query.toLowerCase();

				if (candidateNameLower === queryLower) {
					return 1;
				}
				if (candidateNameLower.startsWith(queryLower)) {
					return 2;
				}

				return 3;
			};

			const rankSymbolKind = (kind: string): number => {
				switch (kind) {
					case "class":
						return 0;
					case "function":
						return 1;
					case "method":
						return 2;
					case "interface":
						return 3;
					case "type":
						return 4;
					default:
						return 5;
				}
			};

			const sortSymbolMatches = <T extends { name: string; kind: string }>(
				left: T,
				right: T,
				query: string,
			): number => {
				const nameRankDiff =
					rankSymbolMatch(left.name, query) -
					rankSymbolMatch(right.name, query);

				if (nameRankDiff !== 0) {
					return nameRankDiff;
				}

				const kindRankDiff =
					rankSymbolKind(left.kind) - rankSymbolKind(right.kind);
				if (kindRankDiff !== 0) {
					return kindRankDiff;
				}

				return left.name.localeCompare(right.name);
			};

			const collapseMatchesByFile = <
				T extends { filePath: string; name: string; kind: string },
			>(
				items: T[],
				query: string,
			): T[] => {
				const bestByFile = new Map<string, T>();

				for (const item of items) {
					const current = bestByFile.get(item.filePath);
					if (!current || sortSymbolMatches(item, current, query) < 0) {
						bestByFile.set(item.filePath, item);
					}
				}

				return Array.from(bestByFile.values()).sort((a, b) =>
					sortSymbolMatches(a, b, query),
				);
			};

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
				let symbols = await metadata.searchSymbols(
					DEFAULT_PROJECT_ID,
					snapshot.id,
					symbolName,
				);

				if (symbols.length === 0) {
					const camelCaseParts = symbolName
						.replace(/([a-z])([A-Z])/g, "$1 $2")
						.split(/\s+/)
						.filter(Boolean);
					const fallbackQuery = camelCaseParts[0];

					if (fallbackQuery && fallbackQuery !== symbolName) {
						symbols = await metadata.searchSymbols(
							DEFAULT_PROJECT_ID,
							snapshot.id,
							fallbackQuery,
						);
					}
				}

				const rawMatches = filterFilePath
					? symbols.filter((s) => s.filePath === filterFilePath)
					: [...symbols].sort((a, b) => sortSymbolMatches(a, b, symbolName));
				const matches = collapseMatchesByFile(rawMatches, symbolName);

				if (matches.length === 0) {
					const fuzzy = symbols.slice(0, 5).map((s) => ({
						name: s.name,
						kind: s.kind,
						filePath: s.filePath,
					}));
					if (isJson) {
						console.log(
							JSON.stringify(
								{ error: "Symbol not found", suggestions: fuzzy },
								null,
								2,
							),
						);
					} else {
						console.error(`Symbol "${symbolName}" not found.`);
						if (fuzzy.length > 0) {
							console.error(
								`Did you mean: ${fuzzy.map((s) => `${s.name} (${s.kind}) in ${s.filePath}`).join(", ")}?`,
							);
						}
					}
					process.exitCode = 1;
					return;
				}

				const results = await Promise.all(
					matches.map(async (sym) => {
						const [deps, dependents] = await Promise.all([
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
							docComment: sym.docComment ?? null,
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
						JSON.stringify(
							results.length === 1 ? results[0] : results,
							null,
							2,
						),
					);
					return;
				}

				for (const result of results) {
					console.log(`Symbol: ${result.name}`);
					console.log(
						`File:   ${result.file} (lines ${result.lines.start}-${result.lines.end})`,
					);
					console.log(
						`Kind:   ${result.kind}${result.exported ? " (exported)" : ""}`,
					);
					if (result.signature) {
						console.log(`Signature: ${result.signature}`);
					}
					if (result.docComment) {
						console.log(`Docs:   ${result.docComment.split("\n")[0]}`);
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
				const message = error instanceof Error ? error.message : String(error);
				if (isJson) {
					console.error(JSON.stringify({ error: message }, null, 2));
				} else {
					console.error(`Explain failed: ${message}`);
				}
				process.exitCode = 1;
			} finally {
				await metadata.close().catch(() => undefined);
			}
		});
}
