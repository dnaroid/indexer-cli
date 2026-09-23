import { readFile } from "node:fs/promises";
import path from "node:path";
import { extname } from "node:path";
import { config } from "../../core/config.js";
import { acquireIndexLock } from "../../core/lock.js";
import type { Snapshot } from "../../core/types.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SimpleGitOperations } from "../../engine/git.js";
import { mergeGitDiffs } from "../../engine/git.js";
import {
	IndexerEngine,
	createDefaultLanguagePlugins,
} from "../../engine/indexer.js";
import { scanProjectFiles } from "../../engine/scanner.js";
import { scanProjectDocuments } from "../../knowledge/document-scanner.js";
import { computeHash } from "../../utils/hash.js";
import { knowledgeSnapshotNeedsRefresh } from "../../knowledge/embedding.js";
import { matchesPathPatterns } from "../../utils/path-patterns.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import type { SqliteMetadataStore } from "../../storage/sqlite.js";

type GitDiff = Awaited<ReturnType<SimpleGitOperations["getChangedFiles"]>>;

const CODE_EXTENSIONS = new Set(
	createDefaultLanguagePlugins().flatMap((plugin) => plugin.fileExtensions),
);

function indexedDomainForPath(filePath: string): "code" | "document" | null {
	const normalized = filePath.replace(/\\/g, "/");
	const extension = extname(normalized).toLowerCase();
	if (CODE_EXTENSIONS.has(extension)) return "code";
	if (!config.get("documentExtensions").includes(extension)) return null;
	const includePaths = config.get("documentIncludePaths");
	if (matchesPathPatterns(normalized, includePaths)) return "document";
	if (matchesPathPatterns(normalized, config.get("documentExcludePaths"))) {
		return null;
	}
	return "document";
}

const READ_COMMAND_LOCK_WAIT_MS = 10_000;
const READ_COMMAND_LOCK_RETRY_MS = 500;

type IndexPlan =
	| { isFullReindex: true; changedFiles: undefined }
	| { isFullReindex: false; changedFiles: GitDiff }
	| null;

export type AutoIndexResult =
	| { status: "noop"; ms: number }
	| {
			status: "updated";
			files?: number;
			removed?: number;
			errors?: number;
			ms: number;
	  }
	| { status: "stale"; reason: string; message?: string; action?: string; ms: number }
	| { status: "failed"; reason: string; message: string; action?: string; ms: number };

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message || error.name;
	}

	if (typeof error === "string") {
		return error;
	}

	if (typeof error === "object" && error !== null) {
		const message = Reflect.get(error, "message");
		if (typeof message === "string" && message.trim().length > 0) {
			return message;
		}
	}

	return String(error);
}

function getErrorDetailParts(error: unknown): string[] {
	if (typeof error !== "object" || error === null) {
		return [];
	}

	const details: string[] = [];
	const code = Reflect.get(error, "code");
	const syscall = Reflect.get(error, "syscall");
	const errorPath = Reflect.get(error, "path");

	if (typeof code === "string" && code.length > 0) {
		details.push(`code: ${code}`);
	}
	if (typeof syscall === "string" && syscall.length > 0) {
		details.push(`syscall: ${syscall}`);
	}
	if (typeof errorPath === "string" && errorPath.length > 0) {
		details.push(`path: ${errorPath}`);
	}

	return details;
}

function describeError(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<string>();
	let current: unknown = error;

	for (let depth = 0; depth < 4 && current != null; depth += 1) {
		const message = getErrorMessage(current).trim();
		const details = getErrorDetailParts(current);
		const formatted =
			details.length > 0 ? `${message} (${details.join(", ")})` : message;

		if (formatted.length > 0 && !seen.has(formatted)) {
			parts.push(formatted);
			seen.add(formatted);
		}

		if (typeof current !== "object" || current === null) {
			break;
		}

		const cause = Reflect.get(current, "cause");
		if (cause == null || cause === current) {
			break;
		}

		current = cause;
	}

	return parts.join("; cause: ");
}

function formatAutoIndexError(
	error: unknown,
	mode: "full" | "incremental",
): string {
	return `Auto-indexing failed during ${mode} reindex: ${describeError(error)}`;
}

function countRemovedFiles(changedFiles: GitDiff | undefined): number | undefined {
	return changedFiles?.deleted.length;
}

function lockRefreshFailure(
	options: {
		silent: boolean;
		startedAt: number;
		lockWaitMs: number;
	},
): AutoIndexResult {
	const message = `Timed out after waiting ${options.lockWaitMs}ms for another indexing process; index refresh did not complete and existing data may be stale. Retry after it finishes.`;
	if (!options.silent) {
		console.error(message);
	}
	return {
		status: "failed",
		reason: "lock-held",
		message,
		action: "run-idx-index",
		ms: Date.now() - options.startedAt,
	};
}

function touchesRootGitignore(changedFiles: GitDiff): boolean {
	return [
		...changedFiles.added,
		...changedFiles.modified,
		...changedFiles.deleted,
	].some((filePath) => filePath.replace(/\\/g, "/") === ".gitignore");
}

async function snapshotMatchesCurrentIndexedFiles(
	metadata: SqliteMetadataStore,
	repoRoot: string,
	snapshot: Snapshot,
): Promise<boolean> {
	const [snapshotCodeFiles, currentCodeFiles, snapshotDocumentFiles, currentDocumentFiles] =
		await Promise.all([
		metadata.listFiles(DEFAULT_PROJECT_ID, snapshot.id),
		scanProjectFiles(repoRoot, Array.from(CODE_EXTENSIONS), {
			includePaths: config.get("indexIncludePaths"),
		}),
		metadata.listFiles(DEFAULT_PROJECT_ID, snapshot.id, { domain: "document" }),
		scanProjectDocuments(repoRoot),
	]);

	const snapshotPaths = new Set(
		[...snapshotCodeFiles, ...snapshotDocumentFiles].map((file) =>
			file.path.replace(/\\/g, "/"),
		),
	);
	const currentPaths = new Set(
		[...currentCodeFiles, ...currentDocumentFiles].map((filePath) =>
			filePath.replace(/\\/g, "/"),
		),
	);

	if (snapshotPaths.size !== currentPaths.size) return false;

	for (const filePath of snapshotPaths) {
		if (!currentPaths.has(filePath)) return false;
	}

	return true;
}

/**
 * Returns true if every workspace change is already captured in `snapshot`:
 * modified/added files have the same sha256 as on disk, and deleted files are
 * already absent from the snapshot. When the root .gitignore changed, the
 * snapshot file set must also match the current scanner output.
 * This prevents repeated reindexing of persistent uncommitted changes.
 */
async function workspaceAlreadyIndexed(
	metadata: SqliteMetadataStore,
	repoRoot: string,
	snapshot: Snapshot,
	workspaceChanges: GitDiff,
): Promise<boolean> {
	if (touchesRootGitignore(workspaceChanges)) {
		const fileSetAlreadyCaptured = await snapshotMatchesCurrentIndexedFiles(
			metadata,
			repoRoot,
			snapshot,
		);
		if (!fileSetAlreadyCaptured) return false;
	}

	for (const filePath of workspaceChanges.deleted) {
		const domain = indexedDomainForPath(filePath);
		if (!domain) continue;

		const record = await metadata.getFile(
			DEFAULT_PROJECT_ID,
			snapshot.id,
			filePath,
			{ domain },
		);
		if (record) return false;
	}

	const filesToCheck = [
		...workspaceChanges.modified,
		...workspaceChanges.added,
	];
	if (filesToCheck.length === 0) return true;

	for (const filePath of filesToCheck) {
		const domain = indexedDomainForPath(filePath);
		if (!domain) continue;

		const record = await metadata.getFile(
			DEFAULT_PROJECT_ID,
			snapshot.id,
			filePath,
			{ domain },
		);
		if (!record) return false;

		let content: string;
		try {
			content = await readFile(path.join(repoRoot, filePath), "utf8");
		} catch {
			return false; // Unreadable
		}

		if (computeHash(content) !== record.sha256) return false;
	}

	return true;
}

async function getIndexPlan(
	git: SimpleGitOperations,
	repoRoot: string,
	metadata: SqliteMetadataStore,
	snapshot: Snapshot | undefined,
): Promise<IndexPlan> {
	if (!snapshot) {
		return { isFullReindex: true, changedFiles: undefined };
	}

	if (!snapshot.meta.headCommit) {
		return { isFullReindex: true, changedFiles: undefined };
	}

	if (
		await metadata.codeSearchIndexNeedsRefresh(
			DEFAULT_PROJECT_ID,
			snapshot.id,
		)
	) {
		return { isFullReindex: true, changedFiles: undefined };
	}

	const knowledgeNeedsRefresh = await knowledgeSnapshotNeedsRefresh(
		metadata,
		DEFAULT_PROJECT_ID,
		snapshot.id,
	);
	const headCommit = await git.getHeadCommit(repoRoot);
	const workspaceChanges = await git.getWorkingTreeChanges(repoRoot);
	const committedChanges =
		headCommit && headCommit !== snapshot.meta.headCommit
			? await git.getChangedFiles(repoRoot, snapshot.meta.headCommit)
			: { added: [], modified: [], deleted: [] };
	const changedFiles = mergeGitDiffs(committedChanges, workspaceChanges);
	if (knowledgeNeedsRefresh) {
		const documents = await scanProjectDocuments(repoRoot);
		// Refresh document configuration without dropping concurrent code changes.
		// An empty document selection still needs a new snapshot/config artifact.
		return {
			isFullReindex: false,
			changedFiles: mergeGitDiffs(changedFiles, {
				added: [], modified: documents, deleted: [],
			}),
		};
	}
	const hasChanges =
		changedFiles.added.length > 0 ||
		changedFiles.modified.length > 0 ||
		changedFiles.deleted.length > 0;

	if (!hasChanges) return null;

	// Optimisation: if the only "changes" are workspace changes that were
	// already indexed in the latest snapshot (same sha256 on disk), skip.
	const noCommittedChanges =
		committedChanges.added.length === 0 &&
		committedChanges.modified.length === 0 &&
		committedChanges.deleted.length === 0;

	if (noCommittedChanges) {
		const alreadyIndexed = await workspaceAlreadyIndexed(
			metadata,
			repoRoot,
			snapshot,
			workspaceChanges,
		);
		if (alreadyIndexed) return null;
	}

	return { isFullReindex: false, changedFiles };
}

export async function ensureIndexed(
	metadata: SqliteMetadataStore,
	repoRoot: string,
	options?: {
		silent?: boolean;
		lockWaitMs?: number;
		lockRetryIntervalMs?: number;
	},
): Promise<AutoIndexResult> {
	const ensureStartedAt = Date.now();
	if (process.env.IDX_ASK_CHILD === "1") {
		return {
			status: "stale",
			reason: "ask-read-only",
			message: "Ask uses the existing snapshot without automatic indexing; it may be stale.",
			action: "Run idx index explicitly to refresh.",
			ms: 0,
		};
	}
	const silent = options?.silent ?? !process.stderr.isTTY;
	const git = new SimpleGitOperations();
	const snapshot =
		(await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID)) ??
		undefined;
	const indexPlan = await getIndexPlan(git, repoRoot, metadata, snapshot);

	if (!indexPlan) {
		return { status: "noop", ms: Date.now() - ensureStartedAt };
	}

	let release: (() => Promise<void>) | null = null;
	try {
		release = await acquireIndexLock(repoRoot, {
			// Query commands wait briefly for an active indexer, then recompute their
			// plan below. A timeout fails rather than silently using stale data.
			waitMs: options?.lockWaitMs ?? READ_COMMAND_LOCK_WAIT_MS,
			retryIntervalMs:
				options?.lockRetryIntervalMs ?? READ_COMMAND_LOCK_RETRY_MS,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("already in progress")) {
			return lockRefreshFailure({
				silent,
				startedAt: ensureStartedAt,
				lockWaitMs: options?.lockWaitMs ?? READ_COMMAND_LOCK_WAIT_MS,
			});
		}
		throw error;
	}

	try {
		const updatedSnapshot =
			(await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID)) ??
			undefined;
		const updatedPlan = await getIndexPlan(
			git,
			repoRoot,
			metadata,
			updatedSnapshot,
		);

		if (!updatedPlan) {
			return { status: "noop", ms: Date.now() - ensureStartedAt };
		}

		const dataDir = path.join(repoRoot, ".indexer-cli");
		const dbPath = path.join(dataDir, "db.sqlite");
		const vectors = new SqliteVecVectorStore({
			dbPath,
			vectorSize: config.get("vectorSize"),
		});

		const startedAt = Date.now();

		const embedder = new OllamaEmbeddingProvider(
			config.get("ollamaBaseUrl"),
			config.get("embeddingModel"),
			config.get("indexBatchSize"),
			config.get("indexConcurrency"),
			config.get("ollamaNumCtx"),
		);
		const knowledgeEmbedder = new OllamaEmbeddingProvider(
			config.get("ollamaBaseUrl"),
			config.get("knowledgeEmbeddingModel"),
			config.get("indexBatchSize"),
			config.get("indexConcurrency"),
			config.get("ollamaNumCtx"),
		);

		let engine: IndexerEngine | null = null;

		try {
			await Promise.all([
				vectors.initialize(),
				embedder.initialize(),
				knowledgeEmbedder.initialize(),
			]);

			engine = new IndexerEngine({
				projectId: DEFAULT_PROJECT_ID,
				repoRoot,
				metadata,
				knowledgeStore: metadata,
				vectors,
				embedder,
				knowledgeEmbedder,
				git,
				languagePlugins: createDefaultLanguagePlugins(),
			});
			const headCommit = await git.getHeadCommit(repoRoot);

			const mode = updatedPlan.isFullReindex ? "full" : "incremental";
			if (!silent) {
				console.error(`Indexing (${mode})...`);
			}

			const result = await engine.indexProject({
				projectId: DEFAULT_PROJECT_ID,
				repoRoot,
				gitRef: headCommit ?? "unknown",
				isFullReindex: updatedPlan.isFullReindex,
				changedFiles: updatedPlan.changedFiles,
				onFileStart:
					silent || !updatedPlan.isFullReindex
						? undefined
						: (filePath, current, total) => {
								console.error(`  [${current}/${total}] ${filePath}`);
							},
				onProgress: silent
					? undefined
					: (processed, total) => {
							console.error(`  ${processed}/${total} files...`);
						},
			});
			const completedSnapshot =
				(await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID)) ??
				undefined;
			const postIndexPlan = await getIndexPlan(
				git,
				repoRoot,
				metadata,
				completedSnapshot,
			);
			if (postIndexPlan) {
				return {
					status: "stale",
					reason: "files-changed-during-index",
					message: "Files changed while indexing completed; run `idx index` to refresh the new changes.",
					action: "run-idx-index",
					ms: Date.now() - ensureStartedAt,
				};
			}

			const elapsedMs = Date.now() - startedAt;
			const [chunkCount, embeddingCount] = await Promise.all([
				metadata
					.listChunks(DEFAULT_PROJECT_ID, result.snapshotId)
					.then((chunks) => chunks.length),
				vectors.countVectors({
					projectId: DEFAULT_PROJECT_ID,
					snapshotId: result.snapshotId,
				}),
			]);

			if (!silent) {
				console.error("Index updated.");
				console.error(`  Snapshot: ${result.snapshotId}`);
				console.error(`  Files indexed: ${result.filesIndexed}`);
				console.error(`  Chunks created: ${chunkCount}`);
				console.error(`  Embeddings: ${embeddingCount}`);
				console.error(`  Time elapsed: ${(elapsedMs / 1000).toFixed(2)}s`);
			}

			if (!silent && result.errors.length > 0) {
				for (const error of result.errors) {
					console.error(`  Error: ${error}`);
				}
			}

			return {
				status: "updated",
				files: result.filesIndexed,
				removed: updatedPlan.isFullReindex
					? 0
					: countRemovedFiles(updatedPlan.changedFiles),
				errors: result.errors.length > 0 ? result.errors.length : undefined,
				ms: Date.now() - ensureStartedAt,
			};
		} catch (indexError) {
			throw new Error(
				formatAutoIndexError(
					indexError,
					updatedPlan.isFullReindex ? "full" : "incremental",
				),
				{ cause: indexError },
			);
		} finally {
			await Promise.allSettled([
				vectors.close(),
				embedder.close(),
				knowledgeEmbedder.close(),
			]);
		}
	} finally {
		await release();
	}
}
