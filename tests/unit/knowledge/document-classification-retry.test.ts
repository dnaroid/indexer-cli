import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../../../src/core/types.js";
import {
	DocumentIndexer,
	documentClassificationNeedsRefresh,
} from "../../../src/knowledge/document-indexer.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { SqliteVecVectorStore } from "../../../src/storage/vectors.js";

class CountingEmbeddingProvider implements EmbeddingProvider {
	readonly id = "counting";
	calls = 0;
	async initialize(): Promise<void> {}
	async close(): Promise<void> {}
	getDimension(): number { return 3; }
	async embed(texts: string[]): Promise<number[][]> {
		this.calls += texts.length;
		return texts.map((_, index) => [1, 1, index + 1]);
	}
}

const decision = (kind: string, status: string) => new Response(JSON.stringify({
	answers: {
		kind: { choice: kind, confidence: 0.99, probabilities: { [kind]: 0.99 } },
		status: { choice: status, confidence: 0.99, probabilities: { [status]: 0.99 } },
	},
}), { status: 200 });

describe("document classification retry", () => {
	const tempDirs: string[] = [];
	const savedEnv = { ...process.env };
	let classifierUp = false;
	let classifierCalls = 0;

	beforeEach(() => {
		const configHome = mkdtempSync(path.join(os.tmpdir(), "idx-classifier-config-"));
		tempDirs.push(configHome);
		process.env.XDG_CONFIG_HOME = configHome;
		process.env.OPENROUTER_API_KEY = "test-key";
		delete process.env.IDX_JEV_MODEL;
		classifierUp = false;
		classifierCalls = 0;
		vi.stubGlobal("fetch", async () => {
			classifierCalls += 1;
			return classifierUp ? decision("spec", "active") : new Response("unavailable", { status: 503 });
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.env = { ...savedEnv };
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function setup() {
		const root = mkdtempSync(path.join(os.tmpdir(), "idx-classifier-retry-"));
		tempDirs.push(root);
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(path.join(root, "docs/contract.md"), "# Contract\n\nRefresh retries once.\n", "utf8");
		await writeFile(path.join(root, "docs/explicit.md"), "---\nkind: guide\nstatus: active\n---\n# Guide\n", "utf8");
		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		const embedder = new CountingEmbeddingProvider();
		const indexer = (retryClassification: boolean) =>
			new DocumentIndexer(root, metadata, metadata, vectors, embedder, { retryClassification });
		const first = await metadata.createSnapshot("project", { indexedAt: Date.now(), headCommit: "one" });
		const full = await indexer(true).indexFull("project", first.id);
		const next = async (previousId: string, retryClassification: boolean) => {
			const snapshot = await metadata.createSnapshot("project", { indexedAt: Date.now(), headCommit: "one" });
			const documents = indexer(retryClassification);
			const plan = await documents.planIncremental("project", previousId, { added: [], modified: [], deleted: [] });
			await documents.copyUnchanged("project", previousId, snapshot.id, plan.unchanged);
			const result = await documents.indexIncremental("project", snapshot.id, plan);
			return { snapshotId: snapshot.id, result };
		};
		const storedKind = async (snapshotId: string) =>
			((await metadata.listKnowledgeChunks("project", snapshotId, "docs/contract.md"))[0]?.metadata?.document as { kind?: string } | undefined)?.kind;
		const close = async () => { await vectors.close(); await metadata.close(); };
		return { metadata, embedder, first: first.id, full, next, storedKind, close };
	}

	it("reclassifies unchanged documents after an outage without re-embedding them", async () => {
		const project = await setup();
		try {
			expect(project.full.classification).toMatchObject({ attempted: 1, degraded: 1, pending: 1 });
			expect(await project.storedKind(project.first)).toBe("unknown");
			expect(await documentClassificationNeedsRefresh(project.metadata, "project", project.first)).toBe(true);

			classifierUp = true;
			const embeddedBefore = project.embedder.calls;
			const retried = await project.next(project.first, true);
			expect(retried.result.errors).toEqual([]);
			expect(retried.result.classification).toMatchObject({ attempted: 1, degraded: 0, pending: 0 });
			expect(await project.storedKind(retried.snapshotId)).toBe("spec");
			expect(project.embedder.calls).toBe(embeddedBefore);
			expect(await documentClassificationNeedsRefresh(project.metadata, "project", retried.snapshotId)).toBe(false);
		} finally {
			await project.close();
		}
	});

	it("carries pending documents through automatic refreshes that do not retry", async () => {
		const project = await setup();
		try {
			classifierUp = true;
			const callsBefore = classifierCalls;
			const auto = await project.next(project.first, false);
			expect(classifierCalls).toBe(callsBefore);
			expect(auto.result.classification.pending).toBe(1);
			expect(await project.storedKind(auto.snapshotId)).toBe("unknown");
			expect(await documentClassificationNeedsRefresh(project.metadata, "project", auto.snapshotId)).toBe(true);

			const explicit = await project.next(auto.snapshotId, true);
			expect(await project.storedKind(explicit.snapshotId)).toBe("spec");
		} finally {
			await project.close();
		}
	});

	it("reclassifies all unchanged documents when classifier settings change", async () => {
		const project = await setup();
		try {
			classifierUp = true;
			const settled = await project.next(project.first, true);
			expect(await documentClassificationNeedsRefresh(project.metadata, "project", settled.snapshotId)).toBe(false);

			process.env.IDX_JEV_MODEL = "~typesafe/jev-next";
			expect(await documentClassificationNeedsRefresh(project.metadata, "project", settled.snapshotId)).toBe(true);
			const callsBefore = classifierCalls;
			const reclassified = await project.next(settled.snapshotId, true);
			// Explicit frontmatter needs no classifier call; only the inferred document is re-asked.
			expect(classifierCalls - callsBefore).toBe(1);
			expect(await documentClassificationNeedsRefresh(project.metadata, "project", reclassified.snapshotId)).toBe(false);
		} finally {
			await project.close();
		}
	});

	it("does not request a retry when no classifier credentials are available", async () => {
		const project = await setup();
		try {
			delete process.env.OPENROUTER_API_KEY;
			expect(await documentClassificationNeedsRefresh(project.metadata, "project", project.first)).toBe(false);
		} finally {
			await project.close();
		}
	});
});
