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
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SimpleGitOperations } from "../../engine/git.js";
import { KnowledgeImpactEngine } from "../../knowledge/impact.js";
import { KnowledgeReviewService } from "../../knowledge/review.js";
import { KnowledgeSearchEngine } from "../../knowledge/search.js";
import { summarizeKnowledgeCandidates } from "../../knowledge/service.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import { SqliteKnowledgeReviewStore } from "../../storage/knowledge-reviews.js";
import { candidateReviewRecommendation } from "../format/knowledge.js";
import { withWikiRuntime } from "./wiki-runtime.js";
import { registerWikiSearchCommand } from "./wiki-search.js";
import { registerWikiManifestCommand } from "./wiki-manifest.js";
import { registerWikiVerificationCommands } from "./wiki-verification.js";
import { collectWikiReviewInput, registerWikiReviewCommands } from "./wiki-review.js";
import { wikiReviewRuntime, withWikiReviewRuntime } from "./wiki-review-runtime.js";

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

function reportFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Wiki failed: ${message}`);
	process.exitCode = 1;
}

export function registerWikiCommand(program: Command): void {
	const wiki = program
		.command("wiki")
		.description("Discover, maintain, verify, and query project knowledge/contracts");
	registerWikiManifestCommand(wiki, withWikiRuntime);
	registerWikiReviewCommands(wiki, withWikiReviewRuntime);

	wiki
		.command("discover")
		.description("Discover document candidates for semantic classification")
		.option("--limit <number>", "maximum candidates to return", "40")
		.option("--cursor <number>", "candidate offset for the current deterministic scan", "0")
		.option("--all", "include unchanged already-classified documents")
		.option(
			"--all-unclassified",
			"include all unclassified document-like files regardless heuristic score",
		)
		.option("--json", "print JSON")
		.action(async (options?: { limit?: string; cursor?: string; all?: boolean; allUnclassified?: boolean; json?: boolean }) => {
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
					const cursor = Number(options?.cursor ?? "0");
					if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("--cursor must be a non-negative integer.");
					const page = candidates.slice(cursor, cursor + limit);
					const nextCursor = cursor + page.length < candidates.length ? cursor + page.length : null;
					if (options?.json) {
						console.log(
							JSON.stringify(
								{ total: candidates.length, cursor, nextCursor, hasMore: nextCursor !== null, candidates: page },
								null,
								2,
							),
						);
						return;
					}
					console.log(`candidates: ${candidates.length} | showing ${page.length}`);
					if (nextCursor !== null) console.log(`next cursor: ${nextCursor}`);
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
		.command("trust")
		.description("Explicitly trust registered knowledge; unclassified indexed docs are already trusted by default")
		.option("--path <path>", "recorded knowledge path; repeatable", collect, [])
		.option("--all", "apply to all currently recorded knowledge entries")
		.option("--clear", "remove explicit trust and return to default-trust policy")
		.option("--rationale <text>", "optional trust rationale")
		.option("--json", "print JSON")
		.action(async (options: {
			path?: string[];
			all?: boolean;
			clear?: boolean;
			rationale?: string;
			json?: boolean;
		}) => {
			try {
				const requestedPaths = options.path ?? [];
				if (options.all && requestedPaths.length > 0) {
					throw new Error("--all and --path are mutually exclusive.");
				}
				if (!options.all && requestedPaths.length === 0) {
					throw new Error("Use --all or at least one --path.");
				}
				await withWikiRuntime(async ({ metadata, service }) => {
					const paths = options.all
						? (await metadata.listKnowledgeEntries(DEFAULT_PROJECT_ID)).map((entry) => entry.path)
						: requestedPaths;
					const candidateSummary = options.all
						? summarizeKnowledgeCandidates(await service.discover())
						: undefined;
					const results = [];
					const errors: Array<{ path: string; error: string }> = [];
					for (const filePath of [...new Set(paths)].sort()) {
						try {
							results.push(await service.trust(filePath, {
								clear: options.clear,
								rationale: options.rationale,
							}));
						} catch (error) {
							errors.push({
								path: filePath,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
					if (options.json) {
						console.log(JSON.stringify({
							action: options.clear ? "clear" : "trust",
							results,
							errors,
							...(candidateSummary ? {
								defaultTrustedUnclassifiedCandidateCount: candidateSummary.unclassifiedCandidateCount,
								specCandidateCount: candidateSummary.specCandidateCount,
							} : {}),
							...(options.all && paths.length === 0 ? {
								note: "No registered knowledge entries exist. Indexed unclassified documents are already trusted by default for retrieval; use wiki record only to promote selected documents to durable registered knowledge.",
							} : {}),
						}, null, 2));
					} else {
						for (const result of results) {
							console.log(`${options.clear ? "default-trust" : "trusted"} ${result.path} — trust=${result.trust}`);
						}
						if (options.all && paths.length === 0) {
							console.log("No registered knowledge entries to mark explicitly trusted.");
							console.log(
								`Indexed unclassified documents are already trusted by default for retrieval: ${candidateSummary?.unclassifiedCandidateCount ?? 0} review candidates (${candidateSummary?.specCandidateCount ?? 0} heuristic spec candidates).`,
							);
							console.log("Use `idx wiki search` / `idx context` now; use `idx wiki record` only for durable registered primary knowledge.");
						}
						for (const error of errors) console.error(`Trust failed: ${error.path}: ${error.error}`);
					}
					if (errors.length > 0) process.exitCode = 1;
				});
			} catch (error) {
				reportFailure(error);
			}
		});

	registerWikiVerificationCommands(wiki);

	const relate = wiki
		.command("relate")
		.description("Add/remove knowledge↔code/spec relations")
		.requiredOption("--path <path>", "primary knowledge source")
		.option("--add-code <path>", "add implementation relation", collect, [])
		.option("--remove-code <path>", "remove implementation relation", collect, [])
		.option("--add-test <path>", "add test relation", collect, [])
		.option("--remove-test <path>", "remove test relation", collect, [])
		.option("--add-related-spec <path>", "add related knowledge relation", collect, [])
		.option("--remove-related-spec <path>", "remove related relation", collect, [])
		.option("--add-supersedes <path>", "add supersedes relation", collect, [])
		.option("--remove-supersedes <path>", "remove supersedes relation", collect, [])
		.option("--add-superseded-by <path>", "add superseded-by relation", collect, [])
		.option("--remove-superseded-by <path>", "remove superseded-by relation", collect, [])
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
				const warnings = new Set<string>();
				const results: Array<{
					action: "add" | "remove";
					targetPath: string;
					targetKind: "code" | "knowledge";
					relationKind: KnowledgeRelationKind;
					changed: boolean;
				}> = [];
				for (const operation of operations) {
					for (const targetPath of operation.values) {
						status = await service.relate({
							sourcePath: options.path,
							targetPath,
							targetKind: operation.targetKind,
							relationKind: operation.relationKind,
							action: operation.action,
						});
						for (const warning of status.warnings) warnings.add(warning);
						results.push({
							action: operation.action,
							targetPath,
							targetKind: operation.targetKind,
							relationKind: operation.relationKind,
							changed: status.changed,
						});
					}
				}
				const changed = results.some((result) => result.changed);
				if (options.json) {
					console.log(
						JSON.stringify(
							{
								status: { ...status, changed },
								warnings: [...warnings],
								operations: results,
							},
							null,
							2,
						),
					);
				} else if (status) {
					for (const warning of warnings) console.log(`Warning: ${warning}`);
					if (changed) {
						console.log(`updated relations: ${options.path} — ${status.status}`);
					} else {
						console.log(`no relation changes: ${options.path} — ${status.status}`);
					}
				}
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
						`${entry.path} — ${entry.classification}/${entry.behaviorType}/${entry.lifecycle} — ${status.status} — trust=${status.trust}`,
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
			.option("--strict", "exit nonzero for freshness, coverage, reference, or discovery obligations")
			.option("--json", "print JSON")
			.action(async (options?: { candidateLimit?: string; strict?: boolean; json?: boolean }) => {
				try {
					await withWikiRuntime(async ({ service }) => {
						const audit = await service.audit();
						if (options?.strict && (audit.unverifiedCount > 0 || audit.needsReviewCount > 0 ||
							audit.unresolvedReferenceCount > 0 || audit.uncoveredActiveAsIsCount > 0 || audit.candidateCount > 0)) {
							process.exitCode = 1;
						}
						const candidateLimit = Number.parseInt(options?.candidateLimit ?? "20", 10);
						const recommendation = candidateReviewRecommendation(audit);
						const payload = {
							...audit,
							...(recommendation ? { recommendation } : {}),
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
							`registered primary specs: ${payload.primarySpecCount} (${payload.currentPrimarySpecCount} current/proposed) | fresh: ${payload.freshCount} | unverified: ${payload.unverifiedCount} | needs review: ${payload.needsReviewCount} | trust verified/explicit/default: ${payload.verifiedTrustCount}/${payload.explicitTrustCount}/${payload.defaultTrustCount} | unresolved refs: ${payload.unresolvedReferenceCount} | uncovered active as-is: ${payload.uncoveredActiveAsIsCount} | candidates: ${payload.candidateCount} (${payload.specCandidateCount} spec-like, ${payload.unclassifiedCandidateCount} unclassified, ${payload.changedClassifiedCandidateCount} changed classified)`,
						);
						if (payload.primarySpecCount === 0 && payload.unclassifiedCandidateCount > 0) {
							console.log("Bootstrap: no registered primary specs yet; indexed documents are still available to search/context as default-trusted, unreviewed knowledge.");
						}
						if (payload.recommendation) {
							console.log(`Recommendation: ${payload.recommendation}`);
						}
						for (const status of payload.statuses) {
							if (status.status === "fresh" || status.lifecycle === "historical" || status.lifecycle === "superseded") continue;
							console.log(
								`  ${status.status.padEnd(24)} ${status.path} trust=${status.trust}${status.reasons.length ? ` — ${status.reasons.join(", ")}` : ""}`,
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

	registerWikiSearchCommand(wiki);

	wiki
		.command("impact [paths...]")
		.description(
			"Report known and uncovered spec impact for task-scoped paths or Git changes",
		)
		.option("--base <ref>", "Git base when paths are omitted", "HEAD")
		.option("--semantic-limit <number>", "wiki candidates per uncovered path", "5")
		.option("--no-semantic", "skip semantic candidate retrieval for uncovered paths")
		.option("--no-refresh", "use the existing completed index without auto-indexing")
		.option("--persist-review", "collect durable review obligations for this exact task scope")
		.option("--scope <name>", "independent task scope for persisted review")
		.option("--json", "print JSON")
		.action(
			async (
				paths: string[] | undefined,
				options?: {
					base?: string;
					semanticLimit?: string;
					semantic?: boolean;
					refresh?: boolean;
					persistReview?: boolean;
					scope?: string;
					json?: boolean;
				},
			) => {
				try {
					await withWikiRuntime(async (runtime) => {
						const { projectRoot, metadata, service, snapshotId, indexWarning } = runtime;
						const semanticEnabled = options?.semantic !== false;
						let vectors: SqliteVecVectorStore | undefined;
						let embedder: OllamaEmbeddingProvider | undefined;
						let searchEngine: KnowledgeSearchEngine | undefined;
						let initialized = false;
						let initializationWarning: string | undefined;
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
											let semanticReady = true;
											try {
												await Promise.all([vectors.initialize(), embedder.initialize()]);
											} catch (error) {
												semanticReady = false;
												initializationWarning = error instanceof Error ? error.message : String(error);
												console.error(`Impact retrieval degraded to lexical: ${initializationWarning}`);
											}
											searchEngine = new KnowledgeSearchEngine(
												DEFAULT_PROJECT_ID,
												snapshotId,
												metadata,
												metadata,
												vectors,
												semanticReady ? embedder : null,
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
							let review: { taskScope: string; obligationCount: number } | undefined;
							if (options?.persistReview) {
								const reviewRuntime = wikiReviewRuntime(runtime);
								// Reuse these exact impact facts; fingerprint collection still hashes live files.
								reviewRuntime.impact = async () => result;
								const input = await collectWikiReviewInput(reviewRuntime, paths, options);
								const store = new SqliteKnowledgeReviewStore(reviewRuntime.dbPath);
								try {
									const obligations = await new KnowledgeReviewService(store).collect(input);
									review = { taskScope: input.taskScope, obligationCount: obligations.length };
								} finally { await store.close(); }
							}
							if (options?.json) {
								console.log(JSON.stringify({ ...result, review, diagnostics: {
									indexWarning, initializationWarning, retrieval: searchEngine?.getDiagnostics(),
								} }, null, 2));
								return;
							}
							console.log(
								`changed: ${result.changedPaths.length} | known affected: ${result.knownAffected.length} | uncovered: ${result.uncoveredPaths.length} | changed docs: ${result.changedDocuments.length} | semantic sweep: ${result.semanticSweepRequired ? "yes" : "no"}`,
							);
							if (review) console.log(`review: ${review.obligationCount} obligation(s), scope=${review.taskScope}`);
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
					}, { refresh: options?.refresh !== false && options?.semantic !== false });
				} catch (error) {
					reportFailure(error);
				}
			},
		);
}
