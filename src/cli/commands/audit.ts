import type { Command } from "commander";
import path from "node:path";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { initLogger } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { DocumentSearchEngine } from "../../knowledge/search.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import { withSnapshotReadLease } from "../../core/snapshot-retention.js";
import { auditTask } from "../../knowledge/audit.js";
import { resolveInitializedProjectRoot } from "../project-root.js";

export function registerAuditCommand(program: Command): void {
	program.command("audit <changed-paths...>")
		.description("Report task-scoped documentation relationships")
		.option("--json", "emit a JSON audit report")
		.option("--no-semantic", "skip semantic retrieval")
		.action(async (changedPaths: string[], options: { json?: boolean; semantic?: boolean }) => {
			let metadata: SqliteMetadataStore | undefined;
			let vectors: SqliteVecVectorStore | undefined;
			let embedder: OllamaEmbeddingProvider | undefined;
			try {
				const { projectRoot, notice } = resolveInitializedProjectRoot();
				if (notice && !options.json) console.log(notice);
				const dataDir = path.join(projectRoot, ".indexer-cli");
				config.load(dataDir);
				initLogger(dataDir);
				const dbPath = path.join(dataDir, "db.sqlite");
				metadata = new SqliteMetadataStore(dbPath);
				vectors = new SqliteVecVectorStore({ dbPath, vectorSize: config.get("vectorSize") });
				await metadata.initialize();
				const offline = options.semantic === false;
				if (!offline) embedder = new OllamaEmbeddingProvider(config.get("ollamaBaseUrl"), config.get("knowledgeEmbeddingModel"), config.get("indexBatchSize"), config.get("indexConcurrency"), config.get("ollamaNumCtx"));
				const report = await withSnapshotReadLease(projectRoot, async () => {
					const snapshot = await metadata!.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						const result = await auditTask(projectRoot, changedPaths, { noSemantic: offline });
						result.warnings.push("No completed snapshot; dependency and symbol signals unavailable.");
						return result;
					}
					const [dependencies, symbols] = await Promise.all([
						metadata!.listDependencies(DEFAULT_PROJECT_ID, snapshot.id),
						metadata!.listSymbols(DEFAULT_PROJECT_ID, snapshot.id),
					]);
					let search: ((query: string) => Promise<string[]>) | undefined;
					const retrievalWarnings = new Set<string>();
					if (!offline) {
						let semanticAvailable = true;
						try {
							await vectors!.initialize();
							await embedder!.initialize();
						} catch { semanticAvailable = false; }
						const documents = new DocumentSearchEngine(DEFAULT_PROJECT_ID, snapshot.id, metadata!, semanticAvailable ? vectors! : null, semanticAvailable ? embedder! : null);
						search = async (query) => {
							const results = await documents.search(query, { mode: "hybrid", limit: 8 });
							const note = documents.getDiagnostics()?.note;
							if (note) retrievalWarnings.add(note);
							return results.map((result) => result.path);
						};
						if (!(await metadata!.listKnowledgeChunks(DEFAULT_PROJECT_ID, snapshot.id)).length) retrievalWarnings.add("Document index is empty; retrieval signals unavailable.");
					}
					const result = await auditTask(projectRoot, changedPaths, {
						noSemantic: offline,
						search,
						dependencies: dependencies.map((item) => ({ fromPath: item.fromPath, toPath: item.toPath })),
						symbols: symbols.map((item) => ({ filePath: item.filePath, name: item.name })),
					});
					result.warnings.push(...retrievalWarnings);
					result.warnings.push(`Indexed signals use completed snapshot ${snapshot.id} and may omit task changes; source declarations are scanned live. Run idx index to refresh indexed signals.`);
					return result;
				});
				if (options.json) console.log(JSON.stringify(report, null, 2));
				else {
					console.log(`Changed paths: ${report.changedPaths.join(", ")}`);
					for (const match of report.matches) console.log(`${match.group} ${match.path} <- ${match.reasons.map((r) => `${r.changedPath} (${r.basis}${r.symbol ? `, symbol=${r.symbol}` : ""})`).join(", ")} [${match.classification.kind}/${match.classification.status}; ${match.classification.kindSource}/${match.classification.statusSource}]`);
					for (const item of report.unresolvedPaths) console.log(`UNRESOLVED ${item.document}: ${item.path}${item.symbol ? `::${item.symbol}` : ""}${item.reason ? ` (${item.reason})` : ""}`);
					for (const item of report.uncoveredPaths) console.log(`UNCOVERED ${item}`);
					for (const warning of report.warnings) console.log(`WARN ${warning}`);
					console.log("Audit signals relationships only; an empty result does not prove no drift.");
				}
			} catch (error) { console.error(`Audit failed: ${error instanceof Error ? error.message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500) : "unexpected failure"}`); process.exitCode = 1; }
			finally { await Promise.allSettled([vectors?.close(), embedder?.close(), metadata?.close()]); }
		});
}
