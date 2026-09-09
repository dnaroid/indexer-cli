import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import type {
	KnowledgeBehaviorType,
	KnowledgeClassification,
	KnowledgeLifecycle,
	KnowledgeRelationKind,
} from "../../core/types.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { initLogger } from "../../core/logger.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SimpleGitOperations } from "../../engine/git.js";
import { KnowledgeImpactEngine } from "../../knowledge/impact.js";
import { KnowledgeSearchEngine } from "../../knowledge/search.js";
import { KnowledgeService } from "../../knowledge/service.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import { resolveInitializedProjectRoot } from "../project-root.js";
import { ensureIndexed } from "./ensure-indexed.js";

const CLASSIFICATIONS = new Set<KnowledgeClassification>([
	"spec",
	"spec-like",
	"meta-index",
	"design-only",
	"guide",
	"other",
]);
const BEHAVIOR_TYPES = new Set<KnowledgeBehaviorType>([
	"as-is",
	"change",
	"mixed",
	"unknown",
]);
const LIFECYCLES = new Set<KnowledgeLifecycle>([
	"active",
	"proposed",
	"historical",
	"superseded",
	"unknown",
]);

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

function choice<T extends string>(
	value: string | undefined,
	allowed: Set<T>,
	label: string,
): T | undefined {
	if (value === undefined) return undefined;
	if (!allowed.has(value as T)) {
		throw new Error(`${label} must be one of: ${[...allowed].join(", ")}`);
	}
	return value as T;
}

async function withWikiRuntime<T>(
	action: (runtime: {
		projectRoot: string;
		metadata: SqliteMetadataStore;
		service: KnowledgeService;
		snapshotId: string;
	}) => Promise<T>,
): Promise<T> {
	const resolved = resolveInitializedProjectRoot();
	if (resolved.notice) console.log(resolved.notice);
	const projectRoot = resolved.projectRoot;
	const dataDir = path.join(projectRoot, ".indexer-cli");
	const dbPath = path.join(dataDir, "db.sqlite");
	initLogger(dataDir);
	config.load(dataDir);
	const metadata = new SqliteMetadataStore(dbPath);
	try {
		await metadata.initialize();
		const indexResult = await ensureIndexed(metadata, projectRoot, {
			silent: !process.stderr.isTTY,
		});
		if (indexResult.status === "failed") {
			throw new Error(indexResult.reason);
		}
		const snapshot = await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
		if (!snapshot) throw new Error("No completed index snapshot is available.");
		const service = new KnowledgeService(
			DEFAULT_PROJECT_ID,
			projectRoot,
			metadata,
			metadata,
		);
		return await action({
			projectRoot,
			metadata,
			service,
			snapshotId: snapshot.id,
		});
	} finally {
		await metadata.close();
	}
}

function reportFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Wiki failed: ${message}`);
	process.exitCode = 1;
}

export function registerWikiCommand(program: Command): void {
	const wiki = program
		.command("wiki")
		.description("Discover, maintain, verify, and query project knowledge/contracts");

	wiki
		.command("discover")
		.description("Discover document candidates for semantic classification")
		.option("--limit <number>", "maximum candidates to return", "40")
		.option("--all", "include unchanged already-classified documents")
		.option(
			"--all-unclassified",
			"include all unclassified document-like files regardless heuristic score",
		)
		.option("--json", "print JSON")
		.action(async (options?: { limit?: string; all?: boolean; allUnclassified?: boolean; json?: boolean }) => {
			try {
				if (options?.all && options?.allUnclassified) {
					throw new Error("--all and --all-unclassified are mutually exclusive.");
				}
				await withWikiRuntime(async ({ service }) => {
					const candidates = await service.discover({
						includeAll: options?.all,
						allUnclassified: options?.allUnclassified,
					});
					const limitValue = Number.parseInt(options?.limit ?? "40", 10);
					const limit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 40;
					const page = candidates.slice(0, limit);
					if (options?.json) {
						console.log(
							JSON.stringify(
								{ total: candidates.length, hasMore: candidates.length > page.length, candidates: page },
								null,
								2,
							),
						);
						return;
					}
					console.log(`candidates: ${candidates.length} | showing ${page.length}`);
					for (const candidate of page) {
						const known = candidate.knownClassification
							? ` known=${candidate.knownClassification}`
							: "";
						console.log(
							`score=${candidate.score.toString().padStart(3)} ${candidate.roleHint.padEnd(16)} ${candidate.path}${known}`,
						);
						console.log(`      title: ${candidate.title}`);
						console.log(`      signals: ${candidate.signals.join(", ") || "none"}`);
					}
				});
			} catch (error) {
				reportFailure(error);
			}
		});

	wiki
		.command("record")
		.description("Record semantic knowledge metadata without claiming verification")
		.requiredOption("--path <path>")
		.requiredOption("--classification <classification>")
		.option("--type <type>")
		.option("--lifecycle <lifecycle>")
		.option("--confidence <confidence>")
		.option("--summary <summary>")
		.option("--topic <topic>", "retrieval topic; repeatable", collect, [])
		.option("--json", "print JSON")
		.action(async (options: {
			path: string;
			classification: string;
			type?: string;
			lifecycle?: string;
			confidence?: string;
			summary?: string;
			topic?: string[];
			json?: boolean;
		}) => {
			try {
				const classification = choice(options.classification, CLASSIFICATIONS, "--classification");
				if (!classification) throw new Error("--classification is required.");
				const behaviorType = choice(options.type, BEHAVIOR_TYPES, "--type");
				const lifecycle = choice(options.lifecycle, LIFECYCLES, "--lifecycle");
				await withWikiRuntime(async ({ service }) => {
					const entry = await service.record({
						path: options.path,
						classification,
						behaviorType,
						lifecycle,
						confidence: options.confidence,
						summary: options.summary,
						topics: options.topic,
					});
					const status = await service.getStatus(entry);
					if (options.json) console.log(JSON.stringify({ entry, status }, null, 2));
					else console.log(`recorded ${entry.classification}: ${entry.path} — ${status.status}`);
				});
			} catch (error) {
				reportFailure(error);
			}
		});

	wiki
		.command("verify")
		.description("Establish a semantic verification baseline for primary knowledge")
		.requiredOption("--path <path>")
		.option("--json", "print JSON")
		.action(async (options: { path: string; json?: boolean }) => {
			try {
				await withWikiRuntime(async ({ service }) => {
					const entry = await service.verify(options.path);
					const status = await service.getStatus(entry);
					if (options.json) console.log(JSON.stringify({ entry, status }, null, 2));
					else console.log(`verified: ${entry.path} — ${status.status}`);
				});
			} catch (error) {
				reportFailure(error);
			}
		});

	const relate = wiki
		.command("relate")
		.description("Add/remove inferred knowledge↔code/spec relations")
		.requiredOption("--path <path>", "primary knowledge source")
		.option("--add-code <path>", "add implementation relation", collect, [])
		.option("--remove-code <path>", "remove inferred implementation relation", collect, [])
		.option("--add-test <path>", "add test relation", collect, [])
		.option("--remove-test <path>", "remove inferred test relation", collect, [])
		.option("--add-related-spec <path>", "add related knowledge relation", collect, [])
		.option("--remove-related-spec <path>", "remove inferred related relation", collect, [])
		.option("--add-supersedes <path>", "add supersedes relation", collect, [])
		.option("--remove-supersedes <path>", "remove inferred supersedes relation", collect, [])
		.option("--add-superseded-by <path>", "add superseded-by relation", collect, [])
		.option("--remove-superseded-by <path>", "remove inferred superseded-by relation", collect, [])
		.option("--json", "print JSON");

	relate.action(async (options: Record<string, unknown> & { path: string; json?: boolean }) => {
		try {
			await withWikiRuntime(async ({ service }) => {
				const operations: Array<{
					values: string[];
					targetKind: "code" | "knowledge";
					relationKind: KnowledgeRelationKind;
					action: "add" | "remove";
				}> = [
					{ values: (options.addCode as string[] | undefined) ?? [], targetKind: "code", relationKind: "implements", action: "add" },
					{ values: (options.removeCode as string[] | undefined) ?? [], targetKind: "code", relationKind: "implements", action: "remove" },
					{ values: (options.addTest as string[] | undefined) ?? [], targetKind: "code", relationKind: "tests", action: "add" },
					{ values: (options.removeTest as string[] | undefined) ?? [], targetKind: "code", relationKind: "tests", action: "remove" },
					{ values: (options.addRelatedSpec as string[] | undefined) ?? [], targetKind: "knowledge", relationKind: "related", action: "add" },
					{ values: (options.removeRelatedSpec as string[] | undefined) ?? [], targetKind: "knowledge", relationKind: "related", action: "remove" },
					{ values: (options.addSupersedes as string[] | undefined) ?? [], targetKind: "knowledge", relationKind: "supersedes", action: "add" },
					{ values: (options.removeSupersedes as string[] | undefined) ?? [], targetKind: "knowledge", relationKind: "supersedes", action: "remove" },
					{ values: (options.addSupersededBy as string[] | undefined) ?? [], targetKind: "knowledge", relationKind: "superseded-by", action: "add" },
					{ values: (options.removeSupersededBy as string[] | undefined) ?? [], targetKind: "knowledge", relationKind: "superseded-by", action: "remove" },
				];
				if (!operations.some((operation) => operation.values.length > 0)) {
					throw new Error("At least one relation add/remove option is required.");
				}
				let status;
				for (const operation of operations) {
					for (const targetPath of operation.values) {
						status = await service.relate({
							sourcePath: options.path,
							targetPath,
							targetKind: operation.targetKind,
							relationKind: operation.relationKind,
							action: operation.action,
						});
					}
				}
				if (options.json) console.log(JSON.stringify({ status }, null, 2));
				else if (status) console.log(`updated relations: ${options.path} — ${status.status}`);
			});
		} catch (error) {
			reportFailure(error);
		}
	});

	wiki
		.command("remove")
		.description("Remove knowledge metadata without deleting the source document")
		.requiredOption("--path <path>")
		.action(async (options: { path: string }) => {
			try {
				await withWikiRuntime(async ({ service }) => service.remove(options.path));
				console.log(`removed knowledge metadata: ${options.path}`);
			} catch (error) {
				reportFailure(error);
			}
		});

	wiki
		.command("show")
		.description("Show one knowledge entry, freshness, relations, and verified inputs")
		.requiredOption("--path <path>")
		.option("--json", "print JSON")
		.action(async (options: { path: string; json?: boolean }) => {
			try {
				await withWikiRuntime(async ({ metadata, service }) => {
					const normalized = options.path.replace(/\\/g, "/").replace(/^\.\//, "");
					const entry = await metadata.getKnowledgeEntry(
						DEFAULT_PROJECT_ID,
						normalized,
					);
					if (!entry) throw new Error(`Knowledge entry not found: ${normalized}`);
					const [status, relations, verifiedInputs] = await Promise.all([
						service.getStatus(entry),
						metadata.listKnowledgeRelations(DEFAULT_PROJECT_ID, {
							sourcePath: normalized,
						}),
						metadata.listKnowledgeVerifiedInputs(DEFAULT_PROJECT_ID, normalized),
					]);
					const payload = { entry, status, relations, verifiedInputs };
					if (options.json) {
						console.log(JSON.stringify(payload, null, 2));
						return;
					}
					console.log(
						`${entry.path} — ${entry.classification}/${entry.behaviorType}/${entry.lifecycle} — ${status.status}`,
					);
					if (entry.summary) console.log(`  ${entry.summary}`);
					for (const relation of relations) {
						console.log(
							`  ${relation.provenance} ${relation.relationKind} ${relation.targetKind}:${relation.targetPath}`,
						);
					}
					for (const input of verifiedInputs) {
						console.log(`  verified-input ${input.inputPath}`);
					}
				});
			} catch (error) {
				reportFailure(error);
			}
		});

	for (const name of ["status", "audit"] as const) {
		wiki
			.command(name)
			.description("Report knowledge freshness and discovery health")
			.option("--candidate-limit <number>", "maximum candidates to print", "20")
			.option("--json", "print JSON")
			.action(async (options?: { candidateLimit?: string; json?: boolean }) => {
				try {
					await withWikiRuntime(async ({ service }) => {
						const audit = await service.audit();
						const candidateLimit = Number.parseInt(options?.candidateLimit ?? "20", 10);
						const payload = {
							...audit,
							candidates: audit.candidates.slice(
								0,
								Number.isFinite(candidateLimit) && candidateLimit > 0 ? candidateLimit : 20,
							),
						};
						if (options?.json) {
							console.log(JSON.stringify(payload, null, 2));
							return;
						}
						console.log(
							`primary specs: ${payload.primarySpecCount} (${payload.currentPrimarySpecCount} current/proposed) | fresh: ${payload.freshCount} | unverified: ${payload.unverifiedCount} | needs review: ${payload.needsReviewCount} | unresolved refs: ${payload.unresolvedReferenceCount} | uncovered active as-is: ${payload.uncoveredActiveAsIsCount} | new/changed candidates: ${payload.candidateCount}`,
						);
						for (const status of payload.statuses) {
							if (status.status === "fresh" || status.lifecycle === "historical" || status.lifecycle === "superseded") continue;
							console.log(
								`  ${status.status.padEnd(24)} ${status.path}${status.reasons.length ? ` — ${status.reasons.join(", ")}` : ""}`,
							);
						}
						for (const sourcePath of payload.uncoveredActiveAsIsSpecs) {
							console.log(`  relation-gap             ${sourcePath} — no tracked code/test inputs`);
						}
					});
				} catch (error) {
					reportFailure(error);
				}
			});
	}

	wiki
		.command("catalog")
		.description("Generate and print the compact project knowledge catalog")
		.option("--json", "print JSON with catalog text")
		.action(async (options?: { json?: boolean }) => {
			try {
				await withWikiRuntime(async ({ service, snapshotId }) => {
					const text = await service.renderCatalog(snapshotId);
					if (options?.json) console.log(JSON.stringify({ text }, null, 2));
					else process.stdout.write(text);
				});
			} catch (error) {
				reportFailure(error);
			}
		});

	wiki
		.command("search <query>")
		.description("Search indexed primary project knowledge semantically")
		.option("--limit <number>", "maximum results", "8")
		.option("--include-secondary", "include design-only secondary references")
		.option("--path-prefix <path>", "limit knowledge sources to a path prefix")
		.option("--min-score <number>", "minimum combined knowledge score")
		.option("--json", "print JSON")
		.action(
			async (
				query: string,
				options?: {
					limit?: string;
					includeSecondary?: boolean;
					pathPrefix?: string;
					minScore?: string;
					json?: boolean;
				},
			) => {
				try {
					await withWikiRuntime(async ({ projectRoot, metadata, service, snapshotId }) => {
						const dbPath = path.join(projectRoot, ".indexer-cli", "db.sqlite");
						const vectors = new SqliteVecVectorStore({
							dbPath,
							vectorSize: config.get("vectorSize"),
						});
						const embedder = new OllamaEmbeddingProvider(
							config.get("ollamaBaseUrl"),
							config.get("knowledgeEmbeddingModel"),
							config.get("indexBatchSize"),
							config.get("indexConcurrency"),
							config.get("ollamaNumCtx"),
						);
						try {
							await Promise.all([vectors.initialize(), embedder.initialize()]);
							const engine = new KnowledgeSearchEngine(
								DEFAULT_PROJECT_ID,
								snapshotId,
								metadata,
								metadata,
								vectors,
								embedder,
								service,
							);
							const limitValue = Number.parseInt(options?.limit ?? "8", 10);
							const minScore = options?.minScore
								? Number.parseFloat(options.minScore)
								: undefined;
							if (minScore !== undefined && !Number.isFinite(minScore)) {
								throw new Error("--min-score must be a number.");
							}
							const results = await engine.search(query, {
								limit: Number.isFinite(limitValue) && limitValue > 0 ? limitValue : 8,
								includeSecondary: options?.includeSecondary,
								pathPrefix: options?.pathPrefix?.replace(/\\/g, "/").replace(/^\.\//, ""),
								minScore,
							});
							if (options?.json) {
								console.log(JSON.stringify({ query, results }, null, 2));
								return;
							}
							if (results.length === 0) {
								console.log("no indexed project knowledge matched");
								return;
							}
							for (const result of results) {
								console.log(
									`score=${result.score.toFixed(2).padStart(6)} ${result.lifecycle.padEnd(10)} ${result.status.padEnd(18)} ${result.path} — ${result.title}`,
								);
								console.log(`      ${result.summary}`);
								if (result.reasonCodes.length > 0) {
									console.log(`      why=${result.reasonCodes.slice(0, 6).join("+")}`);
								}
							}
						} finally {
							await Promise.allSettled([vectors.close(), embedder.close()]);
						}
					});
				} catch (error) {
					reportFailure(error);
				}
			},
		);

	wiki
		.command("impact [paths...]")
		.description(
			"Report known and uncovered spec impact for task-scoped paths or Git changes",
		)
		.option("--base <ref>", "Git base when paths are omitted", "HEAD")
		.option("--semantic-limit <number>", "wiki candidates per uncovered path", "5")
		.option("--no-semantic", "skip semantic candidate retrieval for uncovered paths")
		.option("--json", "print JSON")
		.action(
			async (
				paths: string[] | undefined,
				options?: {
					base?: string;
					semanticLimit?: string;
					semantic?: boolean;
					json?: boolean;
				},
			) => {
				try {
					await withWikiRuntime(async ({ projectRoot, metadata, service, snapshotId }) => {
						const semanticEnabled = options?.semantic !== false;
						let vectors: SqliteVecVectorStore | undefined;
						let embedder: OllamaEmbeddingProvider | undefined;
						let searchEngine: KnowledgeSearchEngine | undefined;
						let initialized = false;
						const searcher = semanticEnabled
							? {
									search: async (
										query: string,
										searchOptions?: { limit?: number; includeSecondary?: boolean },
									) => {
										if (!initialized) {
											const dbPath = path.join(
												projectRoot,
												".indexer-cli",
												"db.sqlite",
											);
											vectors = new SqliteVecVectorStore({
												dbPath,
												vectorSize: config.get("vectorSize"),
											});
											embedder = new OllamaEmbeddingProvider(
												config.get("ollamaBaseUrl"),
												config.get("knowledgeEmbeddingModel"),
												config.get("indexBatchSize"),
												config.get("indexConcurrency"),
												config.get("ollamaNumCtx"),
											);
											await Promise.all([vectors.initialize(), embedder.initialize()]);
											searchEngine = new KnowledgeSearchEngine(
												DEFAULT_PROJECT_ID,
												snapshotId,
												metadata,
												metadata,
												vectors,
												embedder,
												service,
											);
											initialized = true;
										}
										return searchEngine?.search(query, searchOptions) ?? [];
									},
								}
							: undefined;
						try {
							const engine = new KnowledgeImpactEngine(
								DEFAULT_PROJECT_ID,
								projectRoot,
								snapshotId,
								metadata,
								metadata,
								service,
								new SimpleGitOperations(),
								searcher,
							);
							const semanticLimit = Number.parseInt(options?.semanticLimit ?? "5", 10);
							const result = await engine.impact({
								paths: paths && paths.length > 0 ? paths : undefined,
								base: options?.base ?? "HEAD",
								semanticLimit:
									Number.isFinite(semanticLimit) && semanticLimit > 0 ? semanticLimit : 5,
							});
							if (options?.json) {
								console.log(JSON.stringify(result, null, 2));
								return;
							}
							console.log(
								`changed: ${result.changedPaths.length} | known affected: ${result.knownAffected.length} | uncovered: ${result.uncoveredPaths.length} | changed docs: ${result.changedDocuments.length} | semantic sweep: ${result.semanticSweepRequired ? "yes" : "no"}`,
							);
							for (const affected of result.knownAffected) {
								console.log(
									`  known ${affected.path} — ${affected.status} — ${affected.matchedChanges.join(", ")}`,
								);
							}
							for (const uncovered of result.uncoveredPaths) {
								console.log(`  uncovered ${uncovered}`);
							}
							for (const document of result.changedDocuments) {
								console.log(
									`  doc ${document.path} — ${document.knownClassification ?? "unclassified"} — score=${document.score} ${document.roleHint}`,
								);
							}
							for (const candidateSet of result.semanticCandidates) {
								const paths = candidateSet.candidates
									.slice(0, 3)
									.map((candidate) => candidate.path)
									.join(", ");
								console.log(
									`  candidates ${candidateSet.changedPath}: ${paths || "none"}`,
								);
							}
						} finally {
							await Promise.allSettled([
								vectors?.close(),
								embedder?.close(),
							]);
						}
					});
				} catch (error) {
					reportFailure(error);
				}
			},
		);
}

