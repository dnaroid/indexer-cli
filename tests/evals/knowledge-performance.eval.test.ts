import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EmbeddingProvider } from "../../src/core/types.js";
import { TokenEstimator } from "../../src/utils/token-estimator.js";
import {
	formatKnowledgeContext,
	type KnowledgeContextPack,
} from "../../src/knowledge/context.js";
import { DocumentIndexer } from "../../src/knowledge/document-indexer.js";
import type { KnowledgeSearchResult } from "../../src/knowledge/search.js";
import { SqliteMetadataStore } from "../../src/storage/sqlite.js";
import { SqliteVecVectorStore } from "../../src/storage/vectors.js";

class FastEmbeddingProvider implements EmbeddingProvider {
	readonly id = "perf-fake";
	async initialize(): Promise<void> {}
	async close(): Promise<void> {}
	getDimension(): number {
		return 3;
	}
	async embed(texts: string[]): Promise<number[][]> {
		return texts.map((text, index) => [
			1,
			Math.max(1, text.length % 97),
			(index % 31) + 1,
		]);
	}
}

const runPerfEval = process.env.RUN_KNOWLEDGE_PERF_EVAL === "1";
const describePerf = runPerfEval ? describe : describe.skip;

describePerf("knowledge large-corpus performance", () => {
	let root = "";

	afterAll(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("indexes hundreds of documents and keeps context output bounded", async () => {
		root = mkdtempSync(path.join(os.tmpdir(), "idx-knowledge-perf-"));
		await mkdir(path.join(root, "docs"), { recursive: true });

		const documentCount = 400;
		await Promise.all(
			Array.from({ length: documentCount }, async (_, index) => {
				await writeFile(
					path.join(root, "docs", `contract-${index.toString().padStart(4, "0")}.md`),
					[
						`# Contract ${index}`,
						"",
						"## Behavior",
						"",
						`Request family ${index} is idempotent and preserves the original result.`,
						"",
						"## Verification",
						"",
						`Verify request family ${index} against implementation and tests.`,
						"",
					].join("\n"),
					"utf8",
				);
			}),
		);

		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		const snapshot = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "perf",
		});
		const indexer = new DocumentIndexer(
			root,
			metadata,
			metadata,
			vectors,
			new FastEmbeddingProvider(),
		);

		const startedAt = Date.now();
		const result = await indexer.indexFull("project", snapshot.id);
		const elapsedMs = Date.now() - startedAt;
		const vectorCount = await vectors.countVectors({
			projectId: "project",
			snapshotId: snapshot.id,
			domain: "document",
		});

		expect(result.errors).toEqual([]);
		expect(result.indexed).toBe(documentCount);
		expect(vectorCount).toBeGreaterThanOrEqual(documentCount);
		expect(elapsedMs).toBeLessThan(15_000);

		const specs: KnowledgeSearchResult[] = Array.from({ length: 200 }, (_, index) => ({
			path: `docs/contract-${index.toString().padStart(4, "0")}.md`,
			title: `Contract ${index}`,
			classification: "spec",
			authority: "registered",
			behaviorType: "as-is",
			lifecycle: "active",
			status: "fresh",
			trust: "verified",
			score: 10 - index / 100,
			semanticScore: 0.9,
			lexicalScore: 1,
			summary: `Request family ${index} idempotency contract with implementation evidence.`,
			topics: ["requests", "idempotency"],
			reasonCodes: ["semantic"],
			bestRanges: [{ startLine: 1, endLine: 9, score: 0.9 }],
		}));
		const pack: KnowledgeContextPack = {
			query: "request idempotency",
			specs,
			implementation: Array.from({ length: 200 }, (_, index) => ({
				path: `src/request-${index}.ts`,
				startLine: 10,
				endLine: 40,
				score: 1,
				reason: "semantic" as const,
			})),
			tests: [],
			relations: [],
			warnings: [],
			readNext: specs.map((spec) => `${spec.path}:1-9`),
		};
		const budget = 1200;
		const output = formatKnowledgeContext(pack, budget);
		const estimatedTokens = new TokenEstimator().estimate(output);
		expect(output).toContain(`TRUNC budget=${budget}`);
		expect(estimatedTokens).toBeLessThanOrEqual(budget + 40);

		console.log(
			`KNOWLEDGE_PERF_EVAL docs=${documentCount} vectors=${vectorCount} index_ms=${elapsedMs} context_tokens=${estimatedTokens} budget=${budget}`,
		);

		await vectors.close();
		await metadata.close();
	}, 30_000);
});
