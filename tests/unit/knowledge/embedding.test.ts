import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	knowledgeDocumentEmbeddingText,
	knowledgeQueryEmbeddingText,
	knowledgeSnapshotNeedsRefresh,
	writeKnowledgeIndexConfigArtifact,
} from "../../../src/knowledge/embedding.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";

describe("knowledge embedding configuration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses retrieval-specific query/document prefixes", () => {
		expect(knowledgeQueryEmbeddingText("session recovery")).toBe(
			"search_query: session recovery",
		);
		expect(knowledgeDocumentEmbeddingText("Session contract")).toBe(
			"search_document: Session contract",
		);
	});

	it("requires a document-domain refresh until the snapshot records the current config", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "idx-knowledge-embedding-"));
		tempDirs.push(root);
		const store = new SqliteMetadataStore(path.join(root, "db.sqlite"));
		await store.initialize();
		const snapshot = await store.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "head",
		});

		await expect(
			knowledgeSnapshotNeedsRefresh(store, "project", snapshot.id),
		).resolves.toBe(true);
		await writeKnowledgeIndexConfigArtifact(store, "project", snapshot.id);
		await expect(
			knowledgeSnapshotNeedsRefresh(store, "project", snapshot.id),
		).resolves.toBe(false);
		await store.close();
	});
});
