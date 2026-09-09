import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
		const russian = await search.search(
			"почему результат нельзя удалить до отправки провайдеру",
		);
		expect(russian[0]?.path).toBe("docs/cache.md");
		expect(russian[0]?.reasonCodes).toContain("semantic");

		const exactRelation = await search.search("src/cache.ts");
		expect(exactRelation[0]?.path).toBe("docs/cache.md");
		expect(exactRelation[0]?.reasonCodes).toContain("exact-relation-path");

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
});

