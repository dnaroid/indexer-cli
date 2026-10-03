import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../../../src/core/types.js";
import { DocumentIndexer } from "../../../src/knowledge/document-indexer.js";
import * as documentScanner from "../../../src/knowledge/document-scanner.js";
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
		return texts.map((text, index) => [
			1,
			Math.max(1, text.length % 17),
			index + 1,
		]);
	}
}

describe("DocumentIndexer", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), "idx-doc-index-"));
		tempDirs.push(dir);
		return dir;
	}

	it("prunes from a complete scan, not a selected subset, and skips incomplete or failed runs", async () => {
		const root = tempDir();
		await writeFile(path.join(root, "keep.md"), "# Keep\n");
		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		try {
			const snapshot = await metadata.createSnapshot("project", { indexedAt: 1 });
			const indexer = new DocumentIndexer(root, metadata, metadata, vectors, new FakeEmbeddingProvider());
			await metadata.setDocumentMetadataCache("project", "keep.md", "key", "{}");
			await metadata.setDocumentMetadataCache("project", "gone.md", "key", "{}");
			await metadata.setDocumentMetadataCache("other", "gone.md", "key", "{}");

			// A selected subset is not an authoritative deletion list.
			await indexer.indexFull("project", snapshot.id, { paths: [] });
			expect(await metadata.getDocumentMetadataCache("project", "keep.md", "key")).toBe("{}");
			expect(await metadata.getDocumentMetadataCache("project", "gone.md", "key")).toBeNull();
			expect(await metadata.getDocumentMetadataCache("other", "gone.md", "key")).toBe("{}");
			await metadata.setDocumentMetadataCache("project", "gone.md", "key", "{}");

			const scan = vi.spyOn(documentScanner, "scanProjectDocuments").mockImplementation(async (_root, options) => {
				options?.onWarning?.({ path: "docs", code: "EACCES", message: "Unavailable" });
				return [];
			});
			await indexer.indexFull("project", snapshot.id, { paths: [] });
			expect(await metadata.getDocumentMetadataCache("project", "gone.md", "key")).toBe("{}");
			scan.mockRejectedValueOnce(new Error("scan failed"));
			await indexer.indexFull("project", snapshot.id, { paths: [] });
			expect(await metadata.getDocumentMetadataCache("project", "gone.md", "key")).toBe("{}");
			scan.mockRestore();

			const failed = await indexer.indexFull("project", snapshot.id, { paths: ["missing.md"] });
			expect(failed.errors).toHaveLength(1);
			expect(await metadata.getDocumentMetadataCache("project", "gone.md", "key")).toBe("{}");
			await rm(path.join(root, "keep.md"));
			await indexer.indexIncremental("project", snapshot.id, {
				currentPaths: [], added: [], modified: [], deleted: ["keep.md"], unchanged: [],
			});
			expect(await metadata.getDocumentMetadataCache("project", "keep.md", "key")).toBeNull();
			expect(await metadata.getDocumentMetadataCache("project", "gone.md", "key")).toBeNull();
		} finally {
			await vectors.close();
			await metadata.close();
		}
	});

	it("indexes documents into a separate file/vector domain", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(
			path.join(root, "docs/auth.md"),
			"# Authentication\n\n## Behavior\nRefresh retries once.\n",
			"utf8",
		);

		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		const snapshot = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "head",
		});
		const indexer = new DocumentIndexer(
			root,
			metadata,
			metadata,
			vectors,
			new FakeEmbeddingProvider(),
		);

		const result = await indexer.indexFull("project", snapshot.id);
		expect(result.errors).toEqual([]);
		expect(result.indexed).toBe(1);
		expect(await metadata.listFiles("project", snapshot.id)).toEqual([]);
		expect(
			await metadata.listFiles("project", snapshot.id, { domain: "document" }),
		).toMatchObject([
			{
				path: "docs/auth.md",
				languageId: "document",
				domain: "document",
			},
		]);
		const chunks = await metadata.listKnowledgeChunks("project", snapshot.id);
		expect(chunks).not.toEqual([]);
		expect(chunks[0]?.metadata?.searchText).toContain("Authentication");
		expect(await vectors.countVectors({ projectId: "project" })).toBe(0);
		expect(
			await vectors.countVectors({ projectId: "project", domain: "document" }),
		).toBeGreaterThan(0);

		const search = await vectors.search([1, 1, 1], 5, {
			projectId: "project",
			snapshotId: snapshot.id,
			domain: "document",
		});
		expect(search[0]).toMatchObject({
			filePath: "docs/auth.md",
			domain: "document",
		});

		await vectors.close();
		await metadata.close();
	});

	it("plans incremental document changes and copies unchanged document metadata", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(path.join(root, "docs/a.md"), "# A\n\nFirst.\n", "utf8");
		await writeFile(path.join(root, "docs/b.md"), "# B\n\nStable.\n", "utf8");

		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		const first = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "one",
		});
		const indexer = new DocumentIndexer(
			root,
			metadata,
			metadata,
			vectors,
			new FakeEmbeddingProvider(),
		);
		await indexer.indexFull("project", first.id);

		await writeFile(path.join(root, "docs/a.md"), "# A\n\nChanged.\n", "utf8");
		const second = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "two",
		});
		const plan = await indexer.planIncremental("project", first.id, {
			added: [],
			modified: ["docs/a.md"],
			deleted: [],
		});
		expect(plan.modified).toEqual(["docs/a.md"]);
		expect(plan.unchanged).toEqual(["docs/b.md"]);

		await indexer.copyUnchanged("project", first.id, second.id, plan.unchanged);
		await vectors.copyVectors("project", first.id, second.id, ["docs/a.md"]);
		await indexer.indexIncremental("project", second.id, plan);

		expect(
			(await metadata.listFiles("project", second.id, { domain: "document" })).map(
				(file) => file.path,
			),
		).toEqual(["docs/a.md", "docs/b.md"]);
		expect(
			await vectors.countVectors({
				projectId: "project",
				snapshotId: second.id,
				domain: "document",
			}),
		).toBeGreaterThanOrEqual(2);
		expect(
			(await metadata.listKnowledgeChunks("project", second.id, "docs/b.md"))
				.length,
		).toBeGreaterThan(0);

		await vectors.close();
		await metadata.close();
	});

	it("records oversized documents in the snapshot without embedding them", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(
			path.join(root, "docs/huge.md"),
			`# Huge\n\n${"x".repeat(530_000)}\n`,
			"utf8",
		);

		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		const snapshot = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "head",
		});
		const indexer = new DocumentIndexer(
			root,
			metadata,
			metadata,
			vectors,
			new FakeEmbeddingProvider(),
		);

		await indexer.indexFull("project", snapshot.id);
		expect(
			await metadata.getFile("project", snapshot.id, "docs/huge.md", {
				domain: "document",
			}),
		).toMatchObject({ path: "docs/huge.md", domain: "document" });
		expect(
			await metadata.listKnowledgeChunks("project", snapshot.id, "docs/huge.md"),
		).toEqual([]);
		expect(
			await vectors.countVectors({
				projectId: "project",
				snapshotId: snapshot.id,
				domain: "document",
			}),
		).toBe(0);

		await vectors.close();
		await metadata.close();
	});
});
