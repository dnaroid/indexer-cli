import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingProvider, KnowledgeVerificationReceipt } from "../../../src/core/types.js";
import { DocumentIndexer } from "../../../src/knowledge/document-indexer.js";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { SqliteVecVectorStore } from "../../../src/storage/vectors.js";

class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly id = "fake";
	async initialize(): Promise<void> {}
	async close(): Promise<void> {}
	getDimension(): number {
		return 3;
	}
	async embed(texts: string[]): Promise<number[][]> {
		return texts.map((text, index) => [1, Math.max(1, text.length % 11), index + 1]);
	}
}

async function verify(service: KnowledgeService, path: string) {
	const prepared = await service.prepareVerification(path);
	const receipt: KnowledgeVerificationReceipt = {
		version: 1, sourcePath: prepared.sourcePath, sourceHash: prepared.sourceHash,
		relationsHash: prepared.relationsHash, inputs: prepared.inputs, preparedAt: 1,
		reviewer: "maintenance-test", rationale: "Reviewed recorded behavior against prepared source.",
		assertionReferences: ["recorded behavior"], evidenceReferences: ["prepared source"],
		assertionBindings: [{ path: prepared.sourcePath, hash: prepared.sourceHash, assertion: "recorded behavior" }],
		evidenceBindings: [{ path: prepared.sourcePath, hash: prepared.sourceHash }],
		limitations: ["No command was executed."],
		...(prepared.inputs.length === 0 ? { zeroTrackedInputsAcknowledged: true } : {}),
	};
	return service.verify(path, receipt);
}

describe("knowledge maintenance lifecycle", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), "idx-knowledge-maintenance-"));
		tempDirs.push(dir);
		return dir;
	}

	it("updates deterministic document snapshots without silently re-recording or re-verifying semantic state", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/session.ts"), "export const retry = 1;\n");
		await writeFile(
			path.join(root, "docs/session.md"),
			"# Session contract\n\n## Behavior\nRetry once.\n\n`src/session.ts`\n",
		);

		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		const embedder = new FakeEmbeddingProvider();
		const indexer = new DocumentIndexer(root, metadata, metadata, vectors, embedder);
		const service = new KnowledgeService("project", root, metadata, metadata);

		const first = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "one",
		});
		await indexer.indexFull("project", first.id);
		await service.record({
			path: "docs/session.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "Session retry contract.",
		});
		const verified = await verify(service, "docs/session.md");
		expect((await service.getStatus(verified)).status).toBe("fresh");

		await writeFile(
			path.join(root, "docs/session.md"),
			"# Session contract\n\n## Behavior\nRetry twice.\n\n`src/session.ts`\n",
		);
		const second = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "two",
		});
		const plan = await indexer.planIncremental("project", first.id, {
			added: [],
			modified: ["docs/session.md"],
			deleted: [],
		});
		await indexer.copyUnchanged("project", first.id, second.id, plan.unchanged);
		await vectors.copyVectors("project", first.id, second.id, ["docs/session.md"]);
		await indexer.indexIncremental("project", second.id, plan);

		const semanticEntry = await metadata.getKnowledgeEntry("project", "docs/session.md");
		expect(semanticEntry?.indexedSourceHash).toBe(verified.indexedSourceHash);
		expect(semanticEntry?.verifiedSourceHash).toBe(verified.verifiedSourceHash);
		expect((await service.getStatus(semanticEntry!)).status).toBe("spec-changed");
		expect(
			await metadata.listFiles("project", second.id, { domain: "document" }),
		).toEqual([expect.objectContaining({ path: "docs/session.md", domain: "document" })]);

		await vectors.close();
		await metadata.close();
	});

	it("keeps moved primary metadata stale until the new source is explicitly classified", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "contracts"), { recursive: true });
		await writeFile(path.join(root, "docs/job.md"), "# Job\n\n## Behavior\nCancel.\n");

		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		const indexer = new DocumentIndexer(
			root,
			metadata,
			metadata,
			vectors,
			new FakeEmbeddingProvider(),
		);
		const service = new KnowledgeService("project", root, metadata, metadata);
		const first = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "one",
		});
		await indexer.indexFull("project", first.id);
		await service.record({
			path: "docs/job.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "Job cancellation contract.",
		});

		await rename(path.join(root, "docs/job.md"), path.join(root, "contracts/job.md"));
		const second = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "two",
		});
		const plan = await indexer.planIncremental("project", first.id, {
			added: ["contracts/job.md"],
			modified: [],
			deleted: ["docs/job.md"],
		});
		await indexer.copyUnchanged("project", first.id, second.id, plan.unchanged);
		await vectors.copyVectors("project", first.id, second.id, [
			"contracts/job.md",
			"docs/job.md",
		]);
		await indexer.indexIncremental("project", second.id, plan);

		const oldEntry = await metadata.getKnowledgeEntry("project", "docs/job.md");
		expect((await service.getStatus(oldEntry!)).status).toBe("missing-source");
		expect(await metadata.getKnowledgeEntry("project", "contracts/job.md")).toBeNull();
		expect((await service.discover()).map((candidate) => candidate.path)).toContain(
			"contracts/job.md",
		);

		await vectors.close();
		await metadata.close();
	});
});
