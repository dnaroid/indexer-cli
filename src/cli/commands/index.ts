import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { initLogger } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SimpleGitOperations } from "../../engine/git.js";
import { mergeGitDiffs } from "../../engine/git.js";
import {
	IndexerEngine,
	createDefaultLanguagePlugins,
} from "../../engine/indexer.js";
import { scanProjectFiles } from "../../engine/scanner.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { LanceDbVectorStore } from "../../storage/vectors.js";
import type { GitDiff } from "../../core/types.js";

function countChangedFiles(diff: GitDiff): number {
	return diff.added.length + diff.modified.length + diff.deleted.length;
}

type TreeNode = {
	dirs: Map<string, TreeNode>;
	files: Set<string>;
};

function buildFileTree(filePaths: string[]): TreeNode {
	const root: TreeNode = { dirs: new Map(), files: new Set() };
	for (const filePath of filePaths) {
		const parts = filePath.split("/");
		let node = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const dir = parts[i];
			let child = node.dirs.get(dir);
			if (!child) {
				child = { dirs: new Map(), files: new Set() };
				node.dirs.set(dir, child);
			}
			node = child;
		}
		node.files.add(parts[parts.length - 1]);
	}
	return root;
}

function printFileTree(node: TreeNode, indent: string): void {
	const dirs = Array.from(node.dirs.entries()).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	const files = Array.from(node.files).sort((a, b) => a.localeCompare(b));

	for (const [name, child] of dirs) {
		console.log(`${indent}${name}/`);
		printFileTree(child, `${indent}  `);
	}
	for (const name of files) {
		console.log(`${indent}${name}`);
	}
}

export function registerIndexCommand(program: Command): void {
	program
		.command("index")
		.description("Index project files for semantic search")
		.option("--full", "force a full reindex")
		.option("--dry-run", "show what would change without indexing")
		.option("--status", "show indexing status for the current project")
		.option("--tree", "show indexed file tree (use with --status)")
		.option("--json", "output status as JSON (use with --status)")
		.action(
			async (options?: {
				full?: boolean;
				dryRun?: boolean;
				status?: boolean;
				tree?: boolean;
				json?: boolean;
			}) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");
				const vectorsPath = path.join(dataDir, "vectors");

				initLogger(dataDir);
				config.load(dataDir);

				const metadata = new SqliteMetadataStore(dbPath);

				try {
					await metadata.initialize();

					if (options?.status) {
						const snapshot =
							await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);

						if (!snapshot) {
							if (options?.json) {
								console.log(JSON.stringify({ indexed: false }, null, 2));
							} else {
								console.log(
									"No completed snapshot found. Run `indexer-cli index` first.",
								);
							}
							return;
						}

						const [files, symbols, dependencies] = await Promise.all([
							metadata.listFiles(DEFAULT_PROJECT_ID, snapshot.id, {}),
							metadata.listSymbols(DEFAULT_PROJECT_ID, snapshot.id),
							metadata.listDependencies(DEFAULT_PROJECT_ID, snapshot.id),
						]);

						const vectors = new LanceDbVectorStore({
							dbPath: vectorsPath,
							vectorSize: config.get("vectorSize"),
						});
						let vectorCount = 0;
						try {
							await vectors.initialize();
							vectorCount = await vectors.countVectors({
								projectId: DEFAULT_PROJECT_ID,
								snapshotId: snapshot.id,
							});
						} finally {
							await vectors.close().catch(() => undefined);
						}

						const languages = new Map<string, number>();
						for (const file of files) {
							const lang = file.languageId || "unknown";
							languages.set(lang, (languages.get(lang) ?? 0) + 1);
						}

						const symbolKinds = new Map<string, number>();
						for (const symbol of symbols) {
							symbolKinds.set(
								symbol.kind,
								(symbolKinds.get(symbol.kind) ?? 0) + 1,
							);
						}

						if (options?.json) {
							const output: Record<string, unknown> = {
								indexed: true,
								snapshot: {
									id: snapshot.id,
									status: snapshot.status,
									createdAt: snapshot.createdAt,
									gitRef: snapshot.meta.headCommit ?? null,
								},
								stats: {
									files: files.length,
									symbols: symbols.length,
									chunks: vectorCount,
									dependencies: dependencies.length,
								},
								languages: Object.fromEntries(languages),
								symbolKinds: Object.fromEntries(symbolKinds),
							};
							if (options?.tree) {
								output.files = files.map((f) => f.path);
							}
							console.log(JSON.stringify(output, null, 2));
							return;
						}

						console.log(`Snapshot: ${snapshot.id} (${snapshot.status})`);
						console.log(
							`Created: ${snapshot.createdAt}  |  Git ref: ${snapshot.meta.headCommit ?? "unknown"}`,
						);
						console.log(
							`Files: ${files.length}  |  Symbols: ${symbols.length}  |  Chunks: ${vectorCount}  |  Dependencies: ${dependencies.length}`,
						);

						if (languages.size > 0) {
							const langEntries = Array.from(languages.entries())
								.sort((a, b) => b[1] - a[1])
								.map(([lang, count]) => `${lang}: ${count}`)
								.join(", ");
							console.log(`Languages: ${langEntries}`);
						}

						if (symbolKinds.size > 0) {
							const kindEntries = Array.from(symbolKinds.entries())
								.sort((a, b) => b[1] - a[1])
								.map(([kind, count]) => `${kind}: ${count}`)
								.join(", ");
							console.log(`Symbol kinds: ${kindEntries}`);
						}

						if (options?.tree) {
							console.log("");
							const filePaths = files.map((f) => f.path);
							printFileTree(buildFileTree(filePaths), "");
						}

						return;
					}

					const startedAt = Date.now();
					console.log("Preparing indexer...");

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
					const git = new SimpleGitOperations();
					let engine: IndexerEngine | null = null;

					try {
						engine = new IndexerEngine({
							projectId: DEFAULT_PROJECT_ID,
							repoRoot: resolvedProjectPath,
							metadata,
							vectors,
							embedder,
							git,
							languagePlugins: createDefaultLanguagePlugins(),
						});
						const latestSnapshot =
							await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
						const headCommit = await git.getHeadCommit(resolvedProjectPath);
						const changedFiles =
							!options?.full && latestSnapshot?.meta.headCommit
								? mergeGitDiffs(
										await git.getChangedFiles(
											resolvedProjectPath,
											latestSnapshot.meta.headCommit,
										),
										await git.getWorkingTreeChanges(resolvedProjectPath),
									)
								: undefined;

						if (options?.dryRun) {
							if (options.full || !latestSnapshot) {
								const plannedFiles = await scanProjectFiles(
									resolvedProjectPath,
									[
										".ts",
										".tsx",
										".mts",
										".cts",
										".js",
										".jsx",
										".mjs",
										".cjs",
										".py",
										".pyi",
										".cs",
										".gd",
									],
								);
								console.log("Dry run complete.");
								console.log("Mode: full reindex");
								console.log(`Files to index: ${plannedFiles.length}`);
							} else {
								const diff = changedFiles ?? {
									added: [],
									modified: [],
									deleted: [],
								};
								console.log("Dry run complete.");
								console.log("Mode: incremental");
								console.log(`Added: ${diff.added.length}`);
								console.log(`Modified: ${diff.modified.length}`);
								console.log(`Deleted: ${diff.deleted.length}`);
								console.log(`Changed total: ${countChangedFiles(diff)}`);
							}

							return;
						}

						await engine.initialize();
						const mode = options?.full
							? "Running full reindex..."
							: "Running incremental index...";
						console.log(mode);

						const result = await engine.indexProject({
							projectId: DEFAULT_PROJECT_ID,
							repoRoot: resolvedProjectPath,
							gitRef: headCommit ?? "unknown",
							isFullReindex: Boolean(options?.full),
							changedFiles,
							onProgress: (processed, total) => {
								console.log(`  ${processed}/${total} files...`);
							},
						});

						const snapshot = await metadata.getSnapshot(result.snapshotId);
						const elapsedMs = Date.now() - startedAt;
						const totalFiles = snapshot?.totalFiles
							? ` / ${snapshot.totalFiles}`
							: "";

						console.log("Index completed successfully.");
						console.log(`  Snapshot: ${result.snapshotId}`);
						console.log(`  Files indexed: ${result.filesIndexed}${totalFiles}`);
						console.log(
							`  Chunks created: ${await vectors.countVectors({ projectId: DEFAULT_PROJECT_ID, snapshotId: result.snapshotId })}`,
						);
						console.log(`  Time elapsed: ${(elapsedMs / 1000).toFixed(2)}s`);
						console.log(`  Errors: ${result.errors.length}`);

						if (result.errors.length > 0) {
							for (const error of result.errors) {
								console.error(`  - ${error}`);
							}
						}
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						console.error(`Indexing failed: ${message}`);
						process.exitCode = 1;
					} finally {
						if (engine) {
							await engine.close().catch(() => undefined);
						} else {
							await Promise.allSettled([vectors.close(), embedder.close()]);
						}
					}
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
