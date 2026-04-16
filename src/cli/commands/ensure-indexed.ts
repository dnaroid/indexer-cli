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
import { computeHash } from "../../utils/hash.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import type { SqliteMetadataStore } from "../../storage/sqlite.js";

type GitDiff = Awaited<ReturnType<SimpleGitOperations["getChangedFiles"]>>;

// Extensions that the indexer actually processes (from language plugins).
// Non-code files in workspace changes are irrelevant for re-index decisions.
const INDEXED_EXTENSIONS = new Set([
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
	".rb",
]);

type IndexPlan =
	| { isFullReindex: true; changedFiles: undefined }
	| { isFullReindex: false; changedFiles: GitDiff }
	| null;

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

/**
 * Returns true if every workspace-modified/added file in workspaceChanges
 * is already captured in `snapshot` with the same sha256 as on disk.
 * This prevents repeated reindexing of persistent uncommitted changes.
 */
async function workspaceAlreadyIndexed(
	metadata: SqliteMetadataStore,
	repoRoot: string,
	snapshot: Snapshot,
	workspaceChanges: GitDiff,
): Promise<boolean> {
	// Deleted files can't be verified as "already indexed"
	if (workspaceChanges.deleted.length > 0) return false;

	const filesToCheck = [
		...workspaceChanges.modified,
		...workspaceChanges.added,
	];
	if (filesToCheck.length === 0) return true;

	for (const filePath of filesToCheck) {
		if (!INDEXED_EXTENSIONS.has(extname(filePath).toLowerCase())) {
			continue; // Non-code file — not indexed, irrelevant for re-index decision
		}

		const record = await metadata.getFile(
			DEFAULT_PROJECT_ID,
			snapshot.id,
			filePath,
		);
		if (!record) return false; // Code file not in snapshot

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

	const headCommit = await git.getHeadCommit(repoRoot);
	const workspaceChanges = await git.getWorkingTreeChanges(repoRoot);
	const committedChanges =
		headCommit && headCommit !== snapshot.meta.headCommit
			? await git.getChangedFiles(repoRoot, snapshot.meta.headCommit)
			: { added: [], modified: [], deleted: [] };
	const changedFiles = mergeGitDiffs(committedChanges, workspaceChanges);
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
	},
): Promise<void> {
	const silent = options?.silent ?? !process.stderr.isTTY;
	const git = new SimpleGitOperations();
	const snapshot =
		(await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID)) ??
		undefined;
	const indexPlan = await getIndexPlan(git, repoRoot, metadata, snapshot);

	if (!indexPlan) {
		return;
	}

	let release: (() => Promise<void>) | null = null;
	try {
		release = await acquireIndexLock(repoRoot, {
			waitMs: 30_000,
			retryIntervalMs: 500,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("already in progress")) {
			if (!silent) {
				console.error("Skipping auto-index: another process holds the lock.");
			}
			return;
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
			return;
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

		let engine: IndexerEngine | null = null;

		try {
			await vectors.initialize();
			await embedder.initialize();

			engine = new IndexerEngine({
				projectId: DEFAULT_PROJECT_ID,
				repoRoot,
				metadata,
				vectors,
				embedder,
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

			const elapsedMs = Date.now() - startedAt;
			const chunkCount = await vectors.countVectors({
				projectId: DEFAULT_PROJECT_ID,
				snapshotId: result.snapshotId,
			});

			if (!silent) {
				console.error("Index updated.");
				console.error(`  Snapshot: ${result.snapshotId}`);
				console.error(`  Files indexed: ${result.filesIndexed}`);
				console.error(`  Chunks created: ${chunkCount}`);
				console.error(`  Time elapsed: ${(elapsedMs / 1000).toFixed(2)}s`);
			}

			if (!silent && result.errors.length > 0) {
				for (const error of result.errors) {
					console.error(`  Error: ${error}`);
				}
			}
		} catch (indexError) {
			throw new Error(
				formatAutoIndexError(
					indexError,
					updatedPlan.isFullReindex ? "full" : "incremental",
				),
				{ cause: indexError },
			);
		} finally {
			await Promise.allSettled([vectors.close(), embedder.close()]);
		}
	} finally {
		await release();
	}
}
