import path from "node:path";
import { config } from "../../core/config.js";
import type { Snapshot } from "../../core/types.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { SimpleGitOperations } from "../../engine/git.js";
import {
	IndexerEngine,
	createDefaultLanguagePlugins,
} from "../../engine/indexer.js";
import { LanceDbVectorStore } from "../../storage/vectors.js";
import type { SqliteMetadataStore } from "../../storage/sqlite.js";

type CliColors = {
	green(text: string): string;
	red(text: string): string;
	gray(text: string): string;
};

async function loadOra() {
	return (await import("ora")).default;
}

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
	if (headCommit === snapshot.meta.headCommit) {
		return null;
	}

	return {
		isFullReindex: false,
		changedFiles: await git.getChangedFiles(repoRoot, snapshot.meta.headCommit),
	};
}

export async function ensureIndexed(
	metadata: SqliteMetadataStore,
	repoRoot: string,
	chalk: CliColors,
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

	const ora = await loadOra();
	const spinner = ora("Preparing indexer...").start();
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
		spinner.text = indexPlan.isFullReindex
			? "Running full index..."
			: "Running incremental index...";

		const result = await engine.indexProject({
			projectId: DEFAULT_PROJECT_ID,
			repoRoot,
			gitRef: headCommit ?? "unknown",
			isFullReindex: indexPlan.isFullReindex,
			changedFiles: indexPlan.changedFiles,
			onProgress: (processed, total) => {
				spinner.text = `Indexing files ${processed}/${total}`;
			},
		});

		const elapsedMs = Date.now() - startedAt;

		spinner.succeed(chalk.green("Index updated."));
		console.log(chalk.gray(`Snapshot: ${result.snapshotId}`));
		console.log(chalk.gray(`Files indexed: ${result.filesIndexed}`));
		console.log(
			chalk.gray(
				`Chunks created: ${await vectors.countVectors({ projectId: DEFAULT_PROJECT_ID, snapshotId: result.snapshotId })}`,
			),
		);
		console.log(chalk.gray(`Time elapsed: ${(elapsedMs / 1000).toFixed(2)}s`));

		if (result.errors.length > 0) {
			for (const error of result.errors) {
				console.log(chalk.red(`- ${error}`));
			}
		}
	} catch (indexError) {
		spinner.fail(chalk.red("Indexing failed."));
		const message =
			indexError instanceof Error ? indexError.message : String(indexError);
		throw new Error(`Auto-indexing failed: ${message}`);
	} finally {
		if (engine) {
			await engine.close().catch(() => undefined);
		} else {
			await Promise.allSettled([vectors.close(), embedder.close()]);
		}
	}
}
