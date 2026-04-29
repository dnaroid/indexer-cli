import path from "node:path";
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
import { resolveInitializedProjectRoot } from "../project-root.js";
import type { DependencyRecord } from "../../core/types.js";

type Direction = "callers" | "callees" | "both";

interface DependencyEdge {
	path: string;
	via?: string;
	kind?: string;
	depth: number;
}

function normalizeDirection(value?: string): Direction {
	if (value === "callers" || value === "callees" || value === "both") {
		return value;
	}
	throw new Error(
		`Invalid --direction "${value}". Expected callers, callees, or both.`,
	);
}

function compactSpecifier(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function formatImportEdge(
	edge: DependencyEdge,
	prefix: "<-" | "->",
	showEdges: boolean,
): string {
	const depth = edge.depth > 1 ? ` d=${edge.depth}` : "";
	if (!showEdges || !edge.via) return `${prefix} ${edge.path}${depth}`;
	const via = compactSpecifier(edge.via);
	const kind = edge.kind ? ` kind=${edge.kind}` : "";
	return `${prefix} ${edge.path}${depth} via=${via}${kind}`;
}

function sectionCountLabel(edges: DependencyEdge[], depth: number): string {
	if (depth <= 1) return `direct=${edges.length}`;
	const direct = edges.filter((edge) => edge.depth === 1).length;
	return `direct=${direct} total=${edges.length}`;
}

function riskLevel(importedBy: number, imports: number): "low" | "med" | "high" {
	if (importedBy >= 5 || imports >= 12) return "high";
	if (importedBy >= 2 || imports >= 6) return "med";
	return "low";
}

function appendUniqueEdge(
	edges: DependencyEdge[],
	seen: Set<string>,
	edge: DependencyEdge,
): void {
	const key = `${edge.path}\0${edge.depth}`;
	if (seen.has(key)) return;
	seen.add(key);
	edges.push(edge);
}

function toImportedByEdge(dep: DependencyRecord, depth: number): DependencyEdge {
	return {
		path: dep.fromPath,
		via: dep.toSpecifier,
		kind: dep.kind,
		depth,
	};
}

function toImportsEdge(dep: DependencyRecord, depth: number): DependencyEdge | null {
	if (dep.dependencyType !== "internal" || !dep.toPath) return null;
	return {
		path: dep.toPath,
		via: dep.toSpecifier,
		kind: dep.kind,
		depth,
	};
}

export function registerDepsCommand(program: Command): void {
	program
		.command("deps <path>")
		.description("Show module import dependencies for a path")
		.option(
			"--direction <dir>",
			"callers/imported-by, callees/imports, or both",
			"both",
		)
		.option("--depth <n>", "traversal depth (default: 1)", "1")
		.option("--show-edges", "show import specifier reasons for dependency edges")
		.option("--tests", "show nearest/impacted tests and suggested verification")
		.action(
			async (
				targetPath: string,
				options?: {
					direction?: string;
					depth?: string;
					showEdges?: boolean;
					tests?: boolean;
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
					console.error(`Error: ${message}`);
					process.exitCode = 1;
					return;
				}
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");

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

					const direction = normalizeDirection(options?.direction ?? "both");
					const depth = Math.max(
						1,
						Math.min(5, parseInt(options?.depth ?? "1", 10)),
					);
					const showEdges = options?.showEdges === true;
					const includeTests = options?.tests === true;

					// Normalize path (strip leading ./)
					const normalizedPath = targetPath.replace(/^\.\//, "");
					const matchedFiles = await metadata.listFiles(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						{ pathPrefix: normalizedPath },
					);

					if (matchedFiles.length === 0) {
						throw new Error(
							`Module "${normalizedPath}" not found in index. Run "indexer-cli index" to update.`,
						);
					}

					const seedPaths = matchedFiles.map((file) => file.path);

					const result: {
						path: string;
						importedBy: DependencyEdge[];
						imports: DependencyEdge[];
					} = {
						path: normalizedPath,
						importedBy: [],
						imports: [],
					};

					// BFS traversal
					if (direction === "callers" || direction === "both") {
						const visited = new Set<string>();
						const queue = [...seedPaths];
						const seenEdges = new Set<string>();
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
										appendUniqueEdge(
											result.importedBy,
											seenEdges,
											toImportedByEdge(dep, d + 1),
										);
										next.push(dep.fromPath);
									}
								}
							}
							queue.splice(0, queue.length, ...next);
						}
						result.importedBy.sort((a, b) => a.path.localeCompare(b.path));
					}

					if (direction === "callees" || direction === "both") {
						const visited = new Set<string>();
						const queue = [...seedPaths];
						const seenEdges = new Set<string>();
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
									const edge = toImportsEdge(dep, d + 1);
									if (edge && !visited.has(edge.path)) {
										appendUniqueEdge(result.imports, seenEdges, edge);
										next.push(edge.path);
									}
								}
							}
							queue.splice(0, queue.length, ...next);
						}
						result.imports.sort((a, b) => a.path.localeCompare(b.path));
					}

					console.log(`M ${result.path} mode=module-imports`);

					if (direction === "callers" || direction === "both") {
						if (result.importedBy.length === 0) {
							console.log("\nimported-by (Callers): none");
						} else {
							console.log(
								`\nimported-by (Callers) ${sectionCountLabel(result.importedBy, depth)}:`,
							);
							for (const caller of result.importedBy) {
								console.log(formatImportEdge(caller, "<-", showEdges));
							}
						}
					}

					if (direction === "callees" || direction === "both") {
						if (result.imports.length === 0) {
							console.log("\nimports (Callees): none");
						} else {
							console.log(
								`\nimports (Callees) ${sectionCountLabel(result.imports, depth)}:`,
							);
							for (const callee of result.imports) {
								console.log(formatImportEdge(callee, "->", showEdges));
							}
						}
					}

					const risk = riskLevel(result.importedBy.length, result.imports.length);
					console.log(
						`\nRisk: ${risk} imported-by=${result.importedBy.length} imports=${result.imports.length} mode=module-imports`,
					);

					if (includeTests) {
						const [allFiles, allDependencies] = await Promise.all([
							metadata.listFiles(DEFAULT_PROJECT_ID, snapshot.id, {}),
							metadata.listDependencies(DEFAULT_PROJECT_ID, snapshot.id),
						]);
						const testHints = findNearestTests({
							targetPaths: seedPaths,
							files: allFiles,
							dependencies: allDependencies,
							maxTests: 3,
						});
						const testLines = formatTestHints(testHints);
						if (testLines.length > 0) {
							console.log("");
							for (const line of testLines) {
								console.log(line);
							}
							const verify = formatSuggestedVerification(testHints);
							if (verify) console.log(verify);
						} else {
							console.log("\nTests: none");
							console.log("Verify: inspect package scripts");
						}
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`Error: ${message}`);
					process.exitCode = 1;
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
