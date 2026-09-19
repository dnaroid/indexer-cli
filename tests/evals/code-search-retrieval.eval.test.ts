import { cp, mkdir, readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../../src/core/config.js";
import type { GitDiff, GitOperations } from "../../src/core/types.js";
import { DEFAULT_PROJECT_ID } from "../../src/core/types.js";
import { OllamaEmbeddingProvider } from "../../src/embedding/ollama.js";
import {
	IndexerEngine,
	createDefaultLanguagePlugins,
} from "../../src/engine/indexer.js";
import { SearchEngine } from "../../src/engine/searcher.js";
import { SqliteMetadataStore } from "../../src/storage/sqlite.js";
import { SqliteVecVectorStore } from "../../src/storage/vectors.js";

type SearchMode = "hybrid" | "semantic" | "lexical" | "symbol";

type CodeRetrievalEval = {
	id: string;
	query: string;
	mode: SearchMode;
	expectedPaths: string[];
};

class EvalGitOperations implements GitOperations {
	async getHeadCommit(): Promise<string | null> {
		return "code-search-eval";
	}
	async isDirty(): Promise<boolean> {
		return false;
	}
	async getChangedFiles(): Promise<GitDiff> {
		return { added: [], modified: [], deleted: [] };
	}
	async getWorkingTreeChanges(): Promise<GitDiff> {
		return { added: [], modified: [], deleted: [] };
	}
	async getChurnByFile(): Promise<Record<string, number>> {
		return {};
	}
}

function bestExpectedRank(paths: string[], expectedPaths: string[]): number {
	let best = -1;
	for (const expectedPath of expectedPaths) {
		const rank = paths.indexOf(expectedPath);
		if (rank >= 0 && (best < 0 || rank < best)) best = rank;
	}
	return best;
}

const runEval = process.env.RUN_CODE_SEARCH_EVAL === "1" ? describe : describe.skip;

runEval("real embedding code-search retrieval eval", () => {
	it(
		"meets hybrid, lexical, symbol, path, Unicode, and distractor targets",
		async () => {
			const repoRoot = process.cwd();
			const fixtureRoot = path.join(repoRoot, "fixtures/projects/e2e-app");
			const evals = JSON.parse(
				await readFile(
					path.join(repoRoot, "evals/code-search/retrieval-evals.json"),
					"utf8",
				),
			) as CodeRetrievalEval[];
			const root = mkdtempSync(path.join(os.tmpdir(), "idx-code-search-eval-"));
			const dbPath = path.join(root, ".indexer-cli/db.sqlite");
			await mkdir(path.dirname(dbPath), { recursive: true });
			await cp(fixtureRoot, root, { recursive: true });

			const metadata = new SqliteMetadataStore(dbPath);
			const vectors = new SqliteVecVectorStore({
				dbPath,
				vectorSize: config.get("vectorSize"),
			});
			const embedder = new OllamaEmbeddingProvider(
				config.get("ollamaBaseUrl"),
				config.get("embeddingModel"),
				config.get("indexBatchSize"),
				config.get("indexConcurrency"),
				config.get("ollamaNumCtx"),
			);
			const indexer = new IndexerEngine({
				projectId: DEFAULT_PROJECT_ID,
				repoRoot: root,
				metadata,
				vectors,
				embedder,
				git: new EvalGitOperations(),
				languagePlugins: createDefaultLanguagePlugins(),
			});

			try {
				await indexer.initialize();
				const indexed = await indexer.indexProject({
					projectId: DEFAULT_PROJECT_ID,
					repoRoot: root,
					gitRef: "code-search-eval",
					isFullReindex: true,
				});
				expect(indexed.errors).toEqual([]);
				const search = new SearchEngine(metadata, vectors, embedder, root);

				let top1 = 0;
				let top3 = 0;
				let recall5 = 0;
				let reciprocalRank = 0;
				let semanticTop1 = 0;
				let hybridComparable = 0;
				const failures: Array<{
					id: string;
					mode: SearchMode;
					query: string;
					expectedPaths: string[];
					results: string[];
				}> = [];

				for (const evalCase of evals) {
					const results = await search.search(
						DEFAULT_PROJECT_ID,
						indexed.snapshotId,
						evalCase.query,
						{
							topK: 5,
							mode: evalCase.mode,
							includeContent: false,
							includeReasonCodes: true,
							minScore: 0,
						},
					);
					const paths = results.map((result) => result.filePath);
					const rank = bestExpectedRank(paths, evalCase.expectedPaths);
					if (rank === 0) top1 += 1;
					if (rank >= 0 && rank < 3) top3 += 1;
					if (rank >= 0 && rank < 5) recall5 += 1;
					if (rank >= 0) reciprocalRank += 1 / (rank + 1);
					if (rank !== 0) {
						failures.push({
							id: evalCase.id,
							mode: evalCase.mode,
							query: evalCase.query,
							expectedPaths: evalCase.expectedPaths,
							results: paths,
						});
					}

					if (evalCase.mode === "hybrid") {
						hybridComparable += 1;
						const semantic = await search.search(
							DEFAULT_PROJECT_ID,
							indexed.snapshotId,
							evalCase.query,
							{
								topK: 5,
								mode: "semantic",
								includeContent: false,
								minScore: 0,
							},
						);
						if (
							bestExpectedRank(
								semantic.map((result) => result.filePath),
								evalCase.expectedPaths,
							) === 0
						) {
							semanticTop1 += 1;
						}
					}
				}

				const total = evals.length;
				const mrr = reciprocalRank / total;
				console.log(
					`CODE_SEARCH_RETRIEVAL_EVAL total=${total} top1=${top1} top3=${top3} recall5=${recall5} mrr=${mrr.toFixed(3)} hybrid_cases=${hybridComparable} semantic_top1=${semanticTop1}`,
				);
				if (failures.length > 0) console.log(JSON.stringify({ failures }, null, 2));

				expect(total).toBeGreaterThanOrEqual(12);
				expect(top1 / total).toBeGreaterThanOrEqual(0.9);
				expect(top3).toBe(total);
				expect(recall5).toBe(total);
				expect(mrr).toBeGreaterThanOrEqual(0.95);
				expect(top1).toBeGreaterThanOrEqual(semanticTop1);
			} finally {
				await indexer.close();
				rmSync(root, { recursive: true, force: true });
			}
		},
		10 * 60_000,
	);
});
