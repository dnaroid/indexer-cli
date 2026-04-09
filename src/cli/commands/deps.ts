import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { isJsonOutput } from "../output-mode.js";
import { ensureIndexed } from "./ensure-indexed.js";

export function registerDepsCommand(program: Command): void {
	program
		.command("deps <path>")
		.description("Show callers and callees for a module or symbol")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option(
			"--direction <dir>",
			"callers (who imports this), callees (what this imports), or both",
			"both",
		)
		.option("--depth <n>", "traversal depth (default: 1)", "1")
		.option("--txt", "output results as human-readable text")
		.action(
			async (
				targetPath: string,
				options?: {
					direction?: string;
					depth?: string;
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

				try {
					await metadata.initialize();
					await ensureIndexed(metadata, resolvedProjectPath, {
						silent: isJson,
					});

					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error("No completed snapshot found.");
					}

					const direction = options?.direction ?? "both";
					const depth = Math.max(
						1,
						Math.min(5, parseInt(options?.depth ?? "1", 10)),
					);

					// Normalize path (strip leading ./)
					const normalizedPath = targetPath.replace(/^\.\//, "");

					const result: {
						path: string;
						callers: string[];
						callees: string[];
					} = {
						path: normalizedPath,
						callers: [],
						callees: [],
					};

					// BFS traversal
					if (direction === "callers" || direction === "both") {
						const visited = new Set<string>();
						const queue = [normalizedPath];
						for (let d = 0; d < depth && queue.length > 0; d++) {
							const next: string[] = [];
							for (const p of queue) {
								if (visited.has(p)) continue;
								visited.add(p);
								const dependents = await metadata.getDependents(
									DEFAULT_PROJECT_ID,
									snapshot.id,
									p,
								);
								for (const dep of dependents) {
									if (!visited.has(dep.fromPath)) {
										result.callers.push(dep.fromPath);
										next.push(dep.fromPath);
									}
								}
							}
							queue.splice(0, queue.length, ...next);
						}
						result.callers = [...new Set(result.callers)].sort();
					}

					if (direction === "callees" || direction === "both") {
						const visited = new Set<string>();
						const queue = [normalizedPath];
						for (let d = 0; d < depth && queue.length > 0; d++) {
							const next: string[] = [];
							for (const p of queue) {
								if (visited.has(p)) continue;
								visited.add(p);
								const deps = await metadata.listDependencies(
									DEFAULT_PROJECT_ID,
									snapshot.id,
									p,
								);
								for (const dep of deps) {
									if (dep.dependencyType === "internal" && dep.toPath) {
										if (!visited.has(dep.toPath)) {
											result.callees.push(dep.toPath);
											next.push(dep.toPath);
										}
									}
								}
							}
							queue.splice(0, queue.length, ...next);
						}
						result.callees = [...new Set(result.callees)].sort();
					}

					if (isJson) {
						console.log(JSON.stringify(result, null, 2));
						return;
					}

					console.log(`Module: ${result.path}`);

					if (direction === "callers" || direction === "both") {
						if (result.callers.length === 0) {
							console.log("\nCallers: none");
						} else {
							console.log(`\nCallers (${result.callers.length}):`);
							for (const caller of result.callers) {
								console.log(`  ${caller}`);
							}
						}
					}

					if (direction === "callees" || direction === "both") {
						if (result.callees.length === 0) {
							console.log("\nCallees: none");
						} else {
							console.log(`\nCallees (${result.callees.length}):`);
							for (const callee of result.callees) {
								console.log(`  ${callee}`);
							}
						}
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (isJson) {
						console.error(JSON.stringify({ error: message }, null, 2));
					} else {
						console.error(`Deps failed: ${message}`);
					}
					process.exitCode = 1;
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
