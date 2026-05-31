import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { ensureIndexed } from "./ensure-indexed.js";
import { formatAutoIndexResult } from "../format/compact.js";
import {
	findNearestTests,
	formatSuggestedVerification,
	formatTestHints,
} from "../test-hints.js";
import { normalizePathPrefix } from "./path-prefix.js";
import { resolveInitializedProjectRoot } from "../project-root.js";

function parseBodyLines(input?: string): number {
	if (!input) return 40;
	const value = Number.parseInt(input, 10);
	if (!Number.isFinite(value) || value < 1 || value > 200) {
		throw new Error("--body-lines must be a number between 1 and 200.");
	}
	return value;
}

async function readBodyPreview(
	repoRoot: string,
	filePath: string,
	startLine: number,
	endLine: number,
	maxLines: number,
): Promise<string[]> {
	const content = await readFile(path.join(repoRoot, filePath), "utf8");
	const lines = content.split("\n");
	const start = Math.max(0, startLine - 1);
	const end = Math.min(lines.length, Math.min(endLine, startLine + maxLines - 1));
	return lines.slice(start, end).map((line, index) => `${startLine + index} ${line}`);
}

export function registerExplainCommand(program: Command): void {
	program
		.command("explain <symbol>")
		.description("Show context for a symbol: signature, callers, and module")
		.option(
			"--path-prefix <string>",
			"limit results to symbols in files under this path",
		)
		.option("--include-body", "include a compact body preview")
		.option("--body-lines <number>", "number of body preview lines", "40")
		.option("--signature-only", "omit dependency context and body hints")
		.action(
			async (
				symbolArg: string,
				options?: {
					pathPrefix?: string;
					includeBody?: boolean;
					bodyLines?: string;
					signatureOnly?: boolean;
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
					console.error(`Explain failed: ${message}`);
					process.exitCode = 1;
					return;
				}
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");

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
					const indexResult = await ensureIndexed(metadata, resolvedProjectPath, {
						silent: !process.stderr.isTTY,
					});
					console.log(formatAutoIndexResult(indexResult));
					if (indexResult.status === "failed") {
						process.exitCode = 1;
						return;
					}

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
						filterFilePath = normalizePathPrefix(parts[0]);
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

					// Filter out fixtures/tests/vendor paths from symbol lookup.
					const excludePrefixes = ["tests/", "fixtures/", "vendor/"];
					const pathPrefix = normalizePathPrefix(options?.pathPrefix);

					symbols = symbols.filter((s) => {
						if (excludePrefixes.some((prefix) => s.filePath.startsWith(prefix))) {
							return false;
						}
						if (
							pathPrefix &&
							!s.filePath.startsWith(pathPrefix)
						) {
							return false;
						}
						return true;
					});

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

							symbols = symbols.filter((s) => {
								if (
									excludePrefixes.some((prefix) => s.filePath.startsWith(prefix))
								) {
									return false;
								}
								if (
									pathPrefix &&
									!s.filePath.startsWith(pathPrefix)
								) {
									return false;
								}
								return true;
							});
						}
					}

					const rawMatches = filterFilePath
						? symbols.filter((s) => s.filePath === filterFilePath)
						: [...symbols].sort((a, b) => sortSymbolMatches(a, b, symbolName));
					const matches = collapseMatchesByFile(rawMatches, symbolName);

					const hasExactMatch = matches.some(
						(m) => rankSymbolMatch(m.name, symbolName) === 0,
					);
					const finalMatches = hasExactMatch
						? matches.filter((m) => rankSymbolMatch(m.name, symbolName) === 0)
						: matches.slice(0, 5);

					if (!filterFilePath && finalMatches.length > 1) {
						console.log(`AMBIG ${symbolName} matches=${finalMatches.length}`);
						for (let i = 0; i < finalMatches.length; i++) {
							const match = finalMatches[i];
							console.log(
								`${i + 1}. ${match.filePath}:${match.range.start.line}-${match.range.end.line} ${match.kind}${match.exported ? " exported" : ""}`,
							);
						}
						const preferred = finalMatches[0];
						if (preferred) {
							console.log(
								`Use: idx explain ${preferred.filePath}::${preferred.name}`,
							);
						}
						console.log("");
					}

					if (finalMatches.length === 0) {
						const fuzzy = symbols.slice(0, 5).map((s) => ({
							name: s.name,
							kind: s.kind,
							filePath: s.filePath,
						}));
						console.error(`Symbol "${symbolName}" not found.`);
						if (fuzzy.length > 0) {
							console.error(
								`Did you mean: ${fuzzy.map((s) => `${s.name} (${s.kind}) in ${s.filePath}`).join(", ")}?`,
							);
						}
						process.exitCode = 1;
						return;
					}

					const allFiles = await metadata.listFiles(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						{},
					);

					const results = await Promise.all(
						finalMatches.map(async (sym) => {
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
								tests: findNearestTests({
									targetPaths: [sym.filePath],
									files: allFiles,
									dependencies: dependents,
									maxTests: 3,
								}),
							};
						}),
					);

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
						if (options?.signatureOnly) {
							if (results.length > 1) console.log("");
							continue;
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
						const testLines = formatTestHints(result.tests);
						if (testLines.length > 0) {
							console.log("");
							for (const line of testLines) {
								console.log(line);
							}
							const verify = formatSuggestedVerification(result.tests);
							if (verify) console.log(verify);
						}
						if (options?.includeBody) {
							try {
								const preview = await readBodyPreview(
									resolvedProjectPath,
									result.file,
									result.lines.start,
									result.lines.end,
									parseBodyLines(options.bodyLines),
								);
								console.log("\nBody preview:");
								for (const line of preview) {
									console.log(line);
								}
								if (preview.length < result.lines.end - result.lines.start + 1) {
									console.log("...");
								}
							} catch {
								console.log("\nBody preview unavailable.");
							}
						} else {
							console.log("body=omitted use --include-body");
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
			},
		);
}
