import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "../../../src/core/types.js";
import { KnowledgeSearchEngine } from "../../../src/knowledge/search.js";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { SqliteVecVectorStore } from "../../../src/storage/vectors.js";

class QueryEmbeddingProvider implements EmbeddingProvider {
	readonly id = "query-test";
	async initialize(): Promise<void> {}
	async close(): Promise<void> {}
	getDimension(): number {
		return 3;
	}
	async embed(texts: string[]): Promise<number[][]> {
		return texts.map((text) => {
			const value = text.toLowerCase();
			if (
				value.includes("провайдер") ||
				value.includes("provider") ||
				value.includes("cache")
			) {
				return [1, 0, 0];
			}
			if (value.includes("task") || value.includes("задач")) {
				return [0, 1, 0];
			}
			return [0, 0, 1];
		});
	}
}

class UnavailableEmbeddingProvider extends QueryEmbeddingProvider {
	override async embed(): Promise<number[][]> { throw new Error("provider offline"); }
}

describe("KnowledgeSearchEngine", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), "idx-knowledge-search-"));
		tempDirs.push(dir);
		return dir;
	}

	it("combines multilingual semantic retrieval with metadata and relation evidence", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/cache.ts"), "export const cache = true;\n");
		await writeFile(
			path.join(root, "docs/cache.md"),
			"# Provider cache stability\n\n## Behavior\nProvider-visible tool results remain stable.\n",
		);
		await writeFile(
			path.join(root, "docs/tasks.md"),
			"# Task storage\n\n## Behavior\nTasks persist locally.\n",
		);

		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		const service = new KnowledgeService("project", root, metadata, metadata);
		await service.record({
			path: "docs/cache.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "Provider cache prefix and tool-result stability contract.",
			topics: ["provider cache", "tool result retention"],
		});
		await service.relate({
			sourcePath: "docs/cache.md",
			targetPath: "src/cache.ts",
			targetKind: "code",
			relationKind: "implements",
			action: "add",
		});
		await service.record({
			path: "docs/tasks.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "Project task storage contract.",
			topics: ["tasks", "persistence"],
		});

		const snapshot = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "head",
		});
		await vectors.upsert([
			{
				projectId: "project",
				snapshotId: snapshot.id,
				chunkId: "cache",
				filePath: "docs/cache.md",
				startLine: 1,
				endLine: 5,
				contentHash: "cache",
				embedding: [1, 0, 0],
				domain: "document",
			},
			{
				projectId: "project",
				snapshotId: snapshot.id,
				chunkId: "tasks",
				filePath: "docs/tasks.md",
				startLine: 1,
				endLine: 5,
				contentHash: "tasks",
				embedding: [0, 1, 0],
				domain: "document",
			},
		]);

		const search = new KnowledgeSearchEngine(
			"project",
			snapshot.id,
			metadata,
			metadata,
			vectors,
			new QueryEmbeddingProvider(),
			service,
		);
		await metadata.replaceKnowledgeChunks("project", snapshot.id, "docs/cache.md", [{
			chunkId: "body-cache", startLine: 3, endLine: 4, contentHash: "body-cache", chunkType: "doc_section",
			metadata: { searchText: "The quasarlock nonce is retained until provider delivery." },
		}]);
		const russian = await search.search(
			"почему результат нельзя удалить до отправки провайдеру",
		);
		expect(russian[0]?.path).toBe("docs/cache.md");
		expect(russian[0]?.reasonCodes).toContain("semantic");
		const semanticOnly = await search.search("provider cache", { mode: "semantic" });
		expect(semanticOnly[0]).toMatchObject({ path: "docs/cache.md", lexicalScore: 0 });
		expect(semanticOnly[0]?.reasonCodes.some((reason) => reason.startsWith("body:") || reason.startsWith("title:"))).toBe(false);

		const realVectorSearch = vectors.search.bind(vectors);
		const weakVectorSearch = vi.spyOn(vectors, "search").mockImplementation(async (...args) =>
			(await realVectorSearch(...args)).map((hit) => ({ ...hit, score: 0.1 })));
		const exactRelation = await search.search("src/cache.ts");
		expect(exactRelation[0]?.path).toBe("docs/cache.md");
		expect(exactRelation[0]?.reasonCodes).toContain("exact-relation-path");
		// Orthogonal vector neighbors abstain; they must not supply read-next ranges.
		expect(exactRelation[0]?.reasonCodes).not.toContain("semantic");
		expect(exactRelation[0]?.bestRanges).toEqual([]);
		weakVectorSearch.mockRestore();
		const bodyOnly = await search.search("quasarlock", { mode: "lexical" });
		expect(bodyOnly[0]).toMatchObject({ path: "docs/cache.md" });
		expect(bodyOnly[0]?.reasonCodes.some((reason) => reason.startsWith("body:"))).toBe(true);

		const fallback = new KnowledgeSearchEngine("project", snapshot.id, metadata, metadata, vectors, new UnavailableEmbeddingProvider(), service);
		expect((await fallback.search("quasarlock"))[0]?.path).toBe("docs/cache.md");
		expect(fallback.getDiagnostics()).toMatchObject({ semanticAvailable: false, lexicalCandidates: 1, note: expect.stringContaining("degraded to lexical") });
		expect(await fallback.search("unrelatedterm", { mode: "lexical" })).toEqual([]);
		expect(await search.search("unrelatedterm", { mode: "hybrid" })).toEqual([]);
		const statusBatch = vi.spyOn(service, "getStatuses");
		const vectorLookup = vi.spyOn(vectors, "search");
		await search.search("contract", { mode: "lexical", limit: 1 });
		expect(statusBatch).toHaveBeenCalledOnce();
		expect(statusBatch.mock.calls[0]?.[0]).toHaveLength(1);
		expect(vectorLookup).not.toHaveBeenCalled();
		statusBatch.mockRestore();
		vectorLookup.mockRestore();

		await vectors.close();
		await metadata.close();
	});

	it("keeps design-only references out unless explicitly requested", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "architecture"), { recursive: true });
		await writeFile(path.join(root, "architecture/design.md"), "# Cache design\n");
		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		const service = new KnowledgeService("project", root, metadata, metadata);
		await service.record({
			path: "architecture/design.md",
			classification: "design-only",
			summary: "Provider cache design alternatives.",
			topics: ["cache"],
		});
		const snapshot = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "head",
		});
		await vectors.upsert([
			{
				projectId: "project",
				snapshotId: snapshot.id,
				chunkId: "design",
				filePath: "architecture/design.md",
				startLine: 1,
				endLine: 1,
				contentHash: "design",
				embedding: [1, 0, 0],
				domain: "document",
			},
		]);
		const search = new KnowledgeSearchEngine(
			"project",
			snapshot.id,
			metadata,
			metadata,
			vectors,
			new QueryEmbeddingProvider(),
			service,
		);
		expect(await search.search("provider cache")).toEqual([]);
		expect(
			(await search.search("provider cache", { includeSecondary: true }))[0]?.path,
		).toBe("architecture/design.md");
		await vectors.close();
		await metadata.close();
	});

	it("uses indexed unclassified documents as fallback without registering them", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(
			path.join(root, "docs/draft.md"),
			"# Draft recovery notes\n\n## Behavior\nOrphan protocol retries the local lease once.\n",
		);
		await writeFile(
			path.join(root, "docs/primary.md"),
			"# Primary recovery contract\n\n## Behavior\nOrphan protocol retries the reviewed lease once.\n",
		);
		await writeFile(
			path.join(root, "docs/draft-two.md"),
			"# Backup recovery notes\n\n## Behavior\nOrphan protocol keeps a backup lease journal.\n",
		);

		const dbPath = path.join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		const service = new KnowledgeService("project", root, metadata, metadata);
		const snapshot = await metadata.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "head",
		});
		await metadata.replaceKnowledgeChunks("project", snapshot.id, "docs/draft.md", [{
			chunkId: "draft-body",
			startLine: 3,
			endLine: 4,
			contentHash: "draft-body",
			chunkType: "doc_section",
			heading: "Behavior",
			metadata: { searchText: "Orphan protocol retries the local lease once." },
		}]);
		await metadata.replaceKnowledgeChunks("project", snapshot.id, "docs/draft-two.md", [{
			chunkId: "draft-two-body",
			startLine: 3,
			endLine: 4,
			contentHash: "draft-two-body",
			chunkType: "doc_section",
			heading: "Behavior",
			metadata: { searchText: "Orphan protocol keeps a backup lease journal." },
		}]);
		await vectors.upsert([{
			projectId: "project",
			snapshotId: snapshot.id,
			chunkId: "draft-vector",
			filePath: "docs/draft.md",
			startLine: 3,
			endLine: 4,
			contentHash: "draft-body",
			chunkType: "doc_section",
			primarySymbol: "Behavior",
			embedding: [0, 0, 1],
			domain: "document",
		}]);

		const search = new KnowledgeSearchEngine(
			"project",
			snapshot.id,
			metadata,
			metadata,
			vectors,
			new QueryEmbeddingProvider(),
			service,
		);
		const fallback = await search.search("local lease", { mode: "lexical" });
		expect(fallback[0]).toMatchObject({
			path: "docs/draft.md",
			authority: "unreviewed-indexed",
			classification: "unclassified",
			status: "unreviewed",
			trust: "default",
			title: "Behavior",
			summary: "Orphan protocol retries the local lease once.",
		});
		expect(fallback[0]?.reasonCodes).toContain("unreviewed-indexed");
		expect(await metadata.getKnowledgeEntry("project", "docs/draft.md")).toBeNull();
		const bootstrapFallback = await search.search("orphan protocol", { mode: "lexical", limit: 3 });
		expect(bootstrapFallback).toHaveLength(2);
		expect(bootstrapFallback.map((result) => result.path).sort()).toEqual([
			"docs/draft-two.md",
			"docs/draft.md",
		].sort());
		expect(bootstrapFallback.every((result) => result.trust === "default")).toBe(true);
		const semanticFallback = await search.search("orphan protocol", { mode: "semantic" });
		expect(semanticFallback[0]).toMatchObject({
			path: "docs/draft.md",
			authority: "unreviewed-indexed",
			semanticScore: 1,
			lexicalScore: 0,
		});

		await service.record({
			path: "docs/primary.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "Reviewed orphan protocol recovery contract.",
			topics: ["orphan protocol", "recovery"],
		});
		await metadata.replaceKnowledgeChunks("project", snapshot.id, "docs/primary.md", [{
			chunkId: "primary-body",
			startLine: 3,
			endLine: 4,
			contentHash: "primary-body",
			chunkType: "doc_section",
			heading: "Behavior",
			metadata: { searchText: "Orphan protocol retries the reviewed lease once." },
		}]);
		await vectors.upsert([{
			projectId: "project",
			snapshotId: snapshot.id,
			chunkId: "primary-vector",
			filePath: "docs/primary.md",
			startLine: 3,
			endLine: 4,
			contentHash: "primary-body",
			chunkType: "doc_section",
			primarySymbol: "Behavior",
			embedding: [0, 0, 1],
			domain: "document",
		}]);

		const primaryOnly = await search.search("orphan protocol", { mode: "lexical", limit: 1 });
		expect(primaryOnly).toHaveLength(1);
		expect(primaryOnly[0]).toMatchObject({
			path: "docs/primary.md",
			authority: "registered",
			classification: "spec",
			status: "unverified",
			trust: "default",
		});
		await service.trust("docs/primary.md", { rationale: "Trust imported project knowledge." });
		const explicitlyTrusted = await search.search("orphan protocol", { mode: "lexical", limit: 1 });
		expect(explicitlyTrusted[0]).toMatchObject({
			path: "docs/primary.md",
			status: "unverified",
			trust: "explicit",
		});
		const primaryWithFallback = await search.search("orphan protocol", {
			mode: "lexical",
			limit: 2,
		});
		expect(primaryWithFallback[0]).toMatchObject({
			path: "docs/primary.md",
			authority: "registered",
		});
		expect(primaryWithFallback[1]).toMatchObject({
			authority: "unreviewed-indexed",
			trust: "default",
		});

		await vectors.close();
		await metadata.close();
	});
});
