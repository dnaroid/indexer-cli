import { cp, mkdir, readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentIndexer } from "../../src/knowledge/document-indexer.js";
import { DocumentSearchEngine } from "../../src/knowledge/search.js";
import { SqliteMetadataStore } from "../../src/storage/sqlite.js";
import { SqliteVecVectorStore } from "../../src/storage/vectors.js";
import { createEvalEmbeddingProvider } from "./embedding-provider.js";

type RetrievalEval = {
	id: string;
	query: string;
	expectedPath: string;
};

const runEval = process.env.RUN_KNOWLEDGE_EVAL === "1" ? describe : describe.skip;

runEval("real embedding knowledge retrieval eval", () => {
	it(
		"meets multilingual/paraphrase/path retrieval targets",
		async () => {
			const evalEmbedding = createEvalEmbeddingProvider("knowledge");
			const repoRoot = process.cwd();
			const fixtureRoot = path.join(repoRoot, "evals/knowledge/files");
			const evals = JSON.parse(
				await readFile(path.join(repoRoot, "evals/knowledge/retrieval-evals.json"), "utf8"),
			) as RetrievalEval[];
			const root = mkdtempSync(path.join(os.tmpdir(), "idx-knowledge-eval-"));
			const dbPath = path.join(root, ".indexer-cli/db.sqlite");
			await mkdir(path.dirname(dbPath), { recursive: true });
			await cp(fixtureRoot, root, { recursive: true });

			const metadata = new SqliteMetadataStore(dbPath);
			const vectors = new SqliteVecVectorStore({
				dbPath,
				vectorSize: evalEmbedding.vectorSize,
			});
			const knowledgeEmbedder = evalEmbedding.embedder;

			try {
				await Promise.all([
					metadata.initialize(),
					vectors.initialize(),
					knowledgeEmbedder.initialize(),
				]);
				const snapshot = await metadata.createSnapshot("default", {
					indexedAt: Date.now(),
					headCommit: "retrieval-eval",
				});
				const documentIndexer = new DocumentIndexer(
					root,
					metadata,
					metadata,
					vectors,
					knowledgeEmbedder,
				);
				const indexed = await documentIndexer.indexFull("default", snapshot.id);
				expect(indexed.errors).toEqual([]);

				const search = new DocumentSearchEngine(
					"default",
					snapshot.id,
					metadata,
					vectors,
					knowledgeEmbedder,
					metadata,
				);
				let semanticTop1 = 0;
				let semanticTop3 = 0;
				let semanticTop5 = 0;
				let hybridTop1 = 0;
				const failures: Array<{
					id: string;
					mode: "semantic" | "hybrid";
					query: string;
					expected: string;
					results: string[];
				}> = [];

				for (const evalCase of evals) {
					for (const mode of ["semantic", "hybrid"] as const) {
						const results = await search.search(evalCase.query, {
							limit: 5,
							mode,
							minScore: 0,
						});
						const paths = results.map((result) => result.path);
						const rank = paths.indexOf(evalCase.expectedPath);
						if (mode === "semantic") {
							if (rank === 0) semanticTop1 += 1;
							if (rank >= 0 && rank < 3) semanticTop3 += 1;
							if (rank >= 0 && rank < 5) semanticTop5 += 1;
						} else if (rank === 0) {
							hybridTop1 += 1;
						}
						if (rank !== 0) {
							failures.push({
								id: evalCase.id,
								mode,
								query: evalCase.query,
								expected: evalCase.expectedPath,
								results: paths,
							});
						}
					}
				}

				const total = evals.length;
				console.log(
					`KNOWLEDGE_RETRIEVAL_EVAL embedding=${evalEmbedding.mode} total=${total} semantic_top1=${semanticTop1} semantic_top3=${semanticTop3} semantic_top5=${semanticTop5} hybrid_top1=${hybridTop1}`,
				);
				if (failures.length > 0) console.log(JSON.stringify({ failures }, null, 2));

				expect(total).toBe(26);
				expect(semanticTop1 / total).toBeGreaterThanOrEqual(0.95);
				expect(semanticTop3).toBe(total);
				expect(semanticTop5).toBe(total);
				expect(hybridTop1 / total).toBeGreaterThanOrEqual(0.95);
			} finally {
				await Promise.allSettled([
					knowledgeEmbedder.close(),
					vectors.close(),
					metadata.close(),
				]);
				rmSync(root, { recursive: true, force: true });
			}
		},
		10 * 60_000,
	);
});
