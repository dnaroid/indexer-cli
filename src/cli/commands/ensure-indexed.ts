import path from "node:path";
import { config } from "../../core/config.js";
import type { Snapshot } from "../../core/types.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SimpleGitOperations } from "../../engine/git.js";
import { mergeGitDiffs } from "../../engine/git.js";
import {
	IndexerEngine,
	createDefaultLanguagePlugins,
} from "../../engine/indexer.js";
import { LanceDbVectorStore } from "../../storage/vectors.js";
import type { SqliteMetadataStore } from "../../storage/sqlite.js";

async function getIndexPlan(
	git: SimpleGitOperations,
	repoRoot: string,
	snapshot: Snapshot | undefined,
): Promise<
	| { isFullReindex: true; changedFiles: undefined }
	| {
			isFullReindex: false;
			changedFiles: Awaited<ReturnType<SimpleGitOperations["getChangedFiles"]>>;
	  }
	| null
> {
	if (!snapshot) {
		return {
			isFullReindex: true,
			changedFiles: undefined,
		};
	}

	if (!snapshot.meta.headCommit) {
		return {
			isFullReindex: true,
			changedFiles: undefined,
		};
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

	if (!hasChanges) {
		return null;
	}

	return {
		isFullReindex: false,
		changedFiles,
	};
}

export async function ensureIndexed(
	metadata: SqliteMetadataStore,
	repoRoot: string,
): Promise<void> {
	const git = new SimpleGitOperations();
	const snapshot =
		(await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID)) ??
		undefined;
	const indexPlan = await getIndexPlan(git, repoRoot, snapshot);

	if (!indexPlan) {
		return;
	}

	const dataDir = path.join(repoRoot, ".indexer-cli");
	const vectorsPath = path.join(dataDir, "vectors");
	const vectors = new LanceDbVectorStore({
		dbPath: vectorsPath,
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

		await engine.initialize();
		const mode = indexPlan.isFullReindex ? "full" : "incremental";
		console.log(`Indexing (${mode})...`);

		const result = await engine.indexProject({
			projectId: DEFAULT_PROJECT_ID,
			repoRoot,
			gitRef: headCommit ?? "unknown",
			isFullReindex: indexPlan.isFullReindex,
			changedFiles: indexPlan.changedFiles,
			onProgress: (processed, total) => {
				console.log(`  ${processed}/${total} files...`);
			},
		});

		const elapsedMs = Date.now() - startedAt;
		const chunkCount = await vectors.countVectors({
			projectId: DEFAULT_PROJECT_ID,
			snapshotId: result.snapshotId,
		});

		console.log("Index updated.");
		console.log(`  Snapshot: ${result.snapshotId}`);
		console.log(`  Files indexed: ${result.filesIndexed}`);
		console.log(`  Chunks created: ${chunkCount}`);
		console.log(`  Time elapsed: ${(elapsedMs / 1000).toFixed(2)}s`);

		if (result.errors.length > 0) {
			for (const error of result.errors) {
				console.error(`  Error: ${error}`);
			}
		}
	} catch (indexError) {
		const message =
			indexError instanceof Error ? indexError.message : String(indexError);
		throw new Error(`Auto-indexing failed: ${message}`);
	} finally {
		// metadata is borrowed from caller — do NOT close it here
		await Promise.allSettled([vectors.close(), embedder.close()]);
	}
}
