import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";

const PROJECT_ID = "project-a";

describe("SqliteMetadataStore", () => {
	let tempDir: string;
	let dbPath: string;
	let store: SqliteMetadataStore;

	beforeEach(async () => {
		tempDir = mkdtempSync(path.join(tmpdir(), "indexer-cli-sqlite-"));
		dbPath = path.join(tempDir, "db.sqlite");
		store = new SqliteMetadataStore(dbPath);
		await store.initialize();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await store.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("initializes schema and applies migrations", async () => {
		const db = (store as any).db;
		const migrationRow = db
			.prepare("SELECT MAX(version) AS version FROM schema_migrations")
			.get() as { version: number | null };
		const symbolColumns = db
			.prepare("PRAGMA table_info(symbols)")
			.all() as Array<{ name: string }>;

		expect(migrationRow.version).toBe(1);
		expect(symbolColumns.map((column) => column.name)).toContain(
			"metadata_json",
		);
	});

	it("creates, updates, reads, and lists snapshots", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
		const first = await store.createSnapshot(PROJECT_ID, {
			headCommit: "abc123",
			indexedAt: 0,
		});

		vi.setSystemTime(new Date("2024-01-01T00:00:01.000Z"));
		const second = await store.createSnapshot(PROJECT_ID, {
			headCommit: "def456",
			indexedAt: 0,
		});

		expect(first.status).toBe("indexing");
		expect(first.meta.indexedAt).toBe(first.createdAt);

		await store.updateSnapshotProgress(first.id, 2, 5);
		await store.updateSnapshotStatus(first.id, "failed", "boom");
		await store.updateSnapshotStatus(second.id, "completed");

		const fetchedFirst = await store.getSnapshot(first.id);
		const latest = await store.getLatestSnapshot(PROJECT_ID);
		const latestCompleted = await store.getLatestCompletedSnapshot(PROJECT_ID);
		const snapshots = await store.listSnapshots(PROJECT_ID, {
			limit: 1,
			offset: 1,
		});

		expect(fetchedFirst).toMatchObject({
			id: first.id,
			projectId: PROJECT_ID,
			status: "failed",
			processedFiles: 2,
			totalFiles: 5,
			error: "boom",
			meta: {
				headCommit: "abc123",
				indexedAt: first.createdAt,
			},
		});
		expect(latest?.id).toBe(second.id);
		expect(latestCompleted?.id).toBe(second.id);
		expect(snapshots.map((snapshot) => snapshot.id)).toEqual([first.id]);

		vi.useRealTimers();
	});

	it("upserts and queries files with path prefix filtering", async () => {
		const snapshot = await createSnapshot();

		await store.upsertFile(PROJECT_ID, {
			snapshotId: snapshot.id,
			path: "src/a.ts",
			sha256: "hash-a-1",
			mtimeMs: 100,
			size: 10,
			languageId: "typescript",
		});
		await store.upsertFile(PROJECT_ID, {
			snapshotId: snapshot.id,
			path: "src/a.ts",
			sha256: "hash-a-2",
			mtimeMs: 200,
			size: 20,
			languageId: "typescript",
		});
		await store.upsertFile(PROJECT_ID, {
			snapshotId: snapshot.id,
			path: "src/nested/b.ts",
			sha256: "hash-b",
			mtimeMs: 300,
			size: 30,
			languageId: "typescript",
		});

		expect(await store.getFile(PROJECT_ID, snapshot.id, "src/a.ts")).toEqual({
			snapshotId: snapshot.id,
			path: "src/a.ts",
			sha256: "hash-a-2",
			mtimeMs: 200,
			size: 20,
			languageId: "typescript",
		});
		expect(
			await store.getFile(PROJECT_ID, snapshot.id, "missing.ts"),
		).toBeNull();
		expect(await store.listFiles(PROJECT_ID, snapshot.id)).toHaveLength(2);
		expect(
			await store.listFiles(PROJECT_ID, snapshot.id, { pathPrefix: "src/" }),
		).toHaveLength(2);
		expect(
			await store.listFiles(PROJECT_ID, snapshot.id, {
				pathPrefix: "src/nested",
			}),
		).toEqual([
			{
				snapshotId: snapshot.id,
				path: "src/nested/b.ts",
				sha256: "hash-b",
				mtimeMs: 300,
				size: 30,
				languageId: "typescript",
			},
		]);
	});

	it("replaces and lists chunks", async () => {
		const snapshot = await createSnapshot();

		await store.replaceChunks(PROJECT_ID, snapshot.id, "src/a.ts", [
			{
				chunkId: "chunk-1",
				startLine: 1,
				endLine: 5,
				contentHash: "content-1",
				tokenEstimate: 10,
				chunkType: "impl",
				primarySymbol: "foo",
				hasOverlap: true,
			},
			{
				chunkId: "chunk-2",
				startLine: 6,
				endLine: 8,
				contentHash: "content-2",
				tokenEstimate: 5,
			},
		]);

		await store.replaceChunks(PROJECT_ID, snapshot.id, "src/b.ts", [
			{
				chunkId: "chunk-3",
				startLine: 1,
				endLine: 2,
				contentHash: "content-3",
				tokenEstimate: 3,
				chunkType: "full_file",
			},
		]);

		expect(await store.listChunks(PROJECT_ID, snapshot.id, "src/a.ts")).toEqual(
			[
				{
					snapshotId: snapshot.id,
					chunkId: "chunk-1",
					filePath: "src/a.ts",
					startLine: 1,
					endLine: 5,
					contentHash: "content-1",
					tokenEstimate: 10,
					chunkType: "impl",
					primarySymbol: "foo",
					hasOverlap: true,
				},
				{
					snapshotId: snapshot.id,
					chunkId: "chunk-2",
					filePath: "src/a.ts",
					startLine: 6,
					endLine: 8,
					contentHash: "content-2",
					tokenEstimate: 5,
					chunkType: "full_file",
					primarySymbol: undefined,
					hasOverlap: false,
				},
			],
		);
		expect(await store.listChunks(PROJECT_ID, snapshot.id)).toHaveLength(3);

		await store.replaceChunks(PROJECT_ID, snapshot.id, "src/a.ts", []);
		expect(await store.listChunks(PROJECT_ID, snapshot.id, "src/a.ts")).toEqual(
			[],
		);
		expect(await store.getChunk(PROJECT_ID, snapshot.id, "chunk-3")).toEqual({
			snapshotId: snapshot.id,
			chunkId: "chunk-3",
			filePath: "src/b.ts",
			startLine: 1,
			endLine: 2,
			contentHash: "content-3",
			tokenEstimate: 3,
			chunkType: "full_file",
			primarySymbol: undefined,
			hasOverlap: false,
		});
		expect(await store.getChunk(PROJECT_ID, snapshot.id, "missing")).toBeNull();
	});

	it("replaces, lists, and searches symbols", async () => {
		const snapshot = await createSnapshot();

		await store.replaceSymbols(PROJECT_ID, snapshot.id, "src/a.ts", [
			{
				id: "sym-1",
				kind: "function",
				name: "alpha",
				containerName: "ModuleA",
				exported: true,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 4, character: 1 },
				},
				signature: "alpha(): void",
				docComment: "docs",
				metadata: { stable: true },
			},
			{
				id: "sym-2",
				kind: "class",
				name: "Beta",
				exported: false,
				range: {
					start: { line: 5, character: 0 },
					end: { line: 10, character: 1 },
				},
			},
		]);

		await store.replaceSymbols(PROJECT_ID, snapshot.id, "src/b.ts", [
			{
				id: "sym-3",
				kind: "function",
				name: "alphabet",
				exported: true,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 2, character: 0 },
				},
			},
		]);

		const symbols = await store.listSymbols(
			PROJECT_ID,
			snapshot.id,
			"src/a.ts",
		);
		const matches = await store.searchSymbols(PROJECT_ID, snapshot.id, "alpha");

		expect(symbols).toEqual([
			{
				snapshotId: snapshot.id,
				id: "sym-2",
				filePath: "src/a.ts",
				kind: "class",
				name: "Beta",
				containerName: undefined,
				exported: false,
				range: {
					start: { line: 5, character: 0 },
					end: { line: 10, character: 1 },
				},
				signature: undefined,
				docComment: undefined,
				metadata: undefined,
			},
			{
				snapshotId: snapshot.id,
				id: "sym-1",
				filePath: "src/a.ts",
				kind: "function",
				name: "alpha",
				containerName: "ModuleA",
				exported: true,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 4, character: 1 },
				},
				signature: "alpha(): void",
				docComment: "docs",
				metadata: { stable: true },
			},
		]);
		expect(matches.map((symbol) => symbol.name)).toEqual(["alpha", "alphabet"]);

		await store.replaceSymbols(PROJECT_ID, snapshot.id, "src/a.ts", []);
		expect(
			await store.listSymbols(PROJECT_ID, snapshot.id, "src/a.ts"),
		).toEqual([]);
	});

	it("replaces dependencies and returns list plus dependents", async () => {
		const snapshot = await createSnapshot();

		await store.replaceDependencies(PROJECT_ID, snapshot.id, "src/a.ts", [
			{
				id: "dep-1",
				toSpecifier: "./b",
				toPath: "src/b.ts",
				kind: "import",
				dependencyType: "internal",
			},
			{
				id: "dep-2",
				toSpecifier: "fs",
				kind: "require",
				dependencyType: "builtin",
			},
		]);

		await store.replaceDependencies(PROJECT_ID, snapshot.id, "src/c.ts", [
			{
				id: "dep-3",
				toSpecifier: "./b",
				toPath: "src/b.ts",
				kind: "dynamic_import",
				dependencyType: "internal",
			},
		]);

		expect(
			await store.listDependencies(PROJECT_ID, snapshot.id, "src/a.ts"),
		).toEqual([
			{
				snapshotId: snapshot.id,
				id: "dep-1",
				fromPath: "src/a.ts",
				toSpecifier: "./b",
				toPath: "src/b.ts",
				kind: "import",
				dependencyType: "internal",
			},
			{
				snapshotId: snapshot.id,
				id: "dep-2",
				fromPath: "src/a.ts",
				toSpecifier: "fs",
				toPath: undefined,
				kind: "require",
				dependencyType: "builtin",
			},
		]);
		expect(await store.listDependencies(PROJECT_ID, snapshot.id)).toHaveLength(
			3,
		);
		expect(
			await store.getDependents(PROJECT_ID, snapshot.id, "src/b.ts"),
		).toEqual([
			{
				snapshotId: snapshot.id,
				id: "dep-1",
				fromPath: "src/a.ts",
				toSpecifier: "./b",
				toPath: "src/b.ts",
				kind: "import",
				dependencyType: "internal",
			},
			{
				snapshotId: snapshot.id,
				id: "dep-3",
				fromPath: "src/c.ts",
				toSpecifier: "./b",
				toPath: "src/b.ts",
				kind: "dynamic_import",
				dependencyType: "internal",
			},
		]);

		await store.replaceDependencies(PROJECT_ID, snapshot.id, "src/a.ts", []);
		expect(
			await store.listDependencies(PROJECT_ID, snapshot.id, "src/a.ts"),
		).toEqual([]);
	});

	it("upserts file metrics, artifacts, and copies unchanged file data", async () => {
		const sourceSnapshot = await createSnapshot();
		const targetSnapshot = await createSnapshot();

		await store.upsertFile(PROJECT_ID, {
			snapshotId: sourceSnapshot.id,
			path: "src/a.ts",
			sha256: "hash-a",
			mtimeMs: 1,
			size: 100,
			languageId: "typescript",
		});
		await store.replaceChunks(PROJECT_ID, sourceSnapshot.id, "src/a.ts", [
			{
				chunkId: "chunk-1",
				startLine: 1,
				endLine: 2,
				contentHash: "chunk-hash",
				tokenEstimate: 8,
				chunkType: "impl",
			},
		]);
		await store.replaceSymbols(PROJECT_ID, sourceSnapshot.id, "src/a.ts", [
			{
				id: "sym-1",
				kind: "function",
				name: "copied",
				exported: true,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 2, character: 0 },
				},
			},
		]);
		await store.replaceDependencies(PROJECT_ID, sourceSnapshot.id, "src/a.ts", [
			{
				id: "dep-1",
				toSpecifier: "./dep",
				toPath: "src/dep.ts",
				kind: "import",
				dependencyType: "internal",
			},
		]);
		await store.upsertFileMetrics(PROJECT_ID, {
			snapshotId: sourceSnapshot.id,
			filePath: "src/a.ts",
			metrics: {
				complexity: 3,
				maintainability: 80,
				churn: 1,
				testCoverage: 90,
			},
		});
		await store.upsertArtifact(PROJECT_ID, {
			projectId: PROJECT_ID,
			snapshotId: sourceSnapshot.id,
			artifactType: "architecture",
			scope: "project",
			dataJson: '{"nodes":1}',
		});
		await store.upsertArtifact(PROJECT_ID, {
			projectId: PROJECT_ID,
			snapshotId: sourceSnapshot.id,
			artifactType: "summary",
			scope: "src/a.ts",
			dataJson: '{"text":"ok"}',
		});

		await store.copyUnchangedFileData(
			PROJECT_ID,
			sourceSnapshot.id,
			targetSnapshot.id,
			["src/a.ts"],
		);

		expect(
			await store.getFileMetrics(PROJECT_ID, sourceSnapshot.id, "src/a.ts"),
		).toEqual({
			snapshotId: sourceSnapshot.id,
			filePath: "src/a.ts",
			metrics: {
				complexity: 3,
				maintainability: 80,
				churn: 1,
				testCoverage: 90,
			},
		});
		expect(await store.listFileMetrics(PROJECT_ID, sourceSnapshot.id)).toEqual([
			{
				snapshotId: sourceSnapshot.id,
				filePath: "src/a.ts",
				metrics: {
					complexity: 3,
					maintainability: 80,
					churn: 1,
					testCoverage: 90,
				},
			},
		]);
		expect(await store.listFiles(PROJECT_ID, targetSnapshot.id)).toHaveLength(
			1,
		);
		expect(await store.listChunks(PROJECT_ID, targetSnapshot.id)).toHaveLength(
			1,
		);
		expect(await store.listSymbols(PROJECT_ID, targetSnapshot.id)).toHaveLength(
			1,
		);
		expect(
			await store.listDependencies(PROJECT_ID, targetSnapshot.id),
		).toHaveLength(1);
		expect(await store.listFileMetrics(PROJECT_ID, targetSnapshot.id)).toEqual([
			{
				snapshotId: targetSnapshot.id,
				filePath: "src/a.ts",
				metrics: {
					complexity: 3,
					maintainability: 80,
					churn: 1,
					testCoverage: 90,
				},
			},
		]);

		const architectureArtifact = await store.getArtifact(
			PROJECT_ID,
			sourceSnapshot.id,
			"architecture",
			"project",
		);
		const summaryArtifacts = await store.listArtifacts(
			PROJECT_ID,
			sourceSnapshot.id,
			"summary",
		);

		expect(architectureArtifact).toMatchObject({
			projectId: PROJECT_ID,
			snapshotId: sourceSnapshot.id,
			artifactType: "architecture",
			scope: "project",
			dataJson: '{"nodes":1}',
		});
		expect(typeof architectureArtifact?.updatedAt).toBe("number");
		expect(summaryArtifacts).toHaveLength(1);
		expect(summaryArtifacts[0]).toMatchObject({
			artifactType: "summary",
			scope: "src/a.ts",
		});
	});

	it("returns null for missing artifacts, ignores empty copy lists, and defaults invalid metrics json", async () => {
		const sourceSnapshot = await createSnapshot();
		const targetSnapshot = await createSnapshot();
		const db = (store as any).db;

		await store.copyUnchangedFileData(
			PROJECT_ID,
			sourceSnapshot.id,
			targetSnapshot.id,
			[],
		);
		expect(await store.listFiles(PROJECT_ID, targetSnapshot.id)).toEqual([]);

		db.prepare(
			"INSERT INTO file_metrics (project_id, snapshot_id, file_path, metrics_json, updated_at) VALUES (?, ?, ?, ?, ?)",
		).run(PROJECT_ID, sourceSnapshot.id, "src/bad.ts", "{bad json", Date.now());

		expect(
			await store.getArtifact(
				PROJECT_ID,
				sourceSnapshot.id,
				"missing",
				"project",
			),
		).toBeNull();
		expect(
			await store.getFileMetrics(PROJECT_ID, sourceSnapshot.id, "src/bad.ts"),
		).toEqual({
			snapshotId: sourceSnapshot.id,
			filePath: "src/bad.ts",
			metrics: {
				complexity: 0,
				maintainability: 0,
				churn: 0,
				testCoverage: undefined,
			},
		});
	});

	it("clears project metadata while optionally keeping a snapshot", async () => {
		const keep = await createSnapshot();
		const remove = await createSnapshot();

		await store.upsertFile(PROJECT_ID, {
			snapshotId: keep.id,
			path: "src/keep.ts",
			sha256: "keep",
			mtimeMs: 1,
			size: 1,
			languageId: "typescript",
		});
		await store.upsertFile(PROJECT_ID, {
			snapshotId: remove.id,
			path: "src/remove.ts",
			sha256: "remove",
			mtimeMs: 2,
			size: 2,
			languageId: "typescript",
		});

		await store.clearProjectMetadata(PROJECT_ID, keep.id);

		expect(await store.getSnapshot(keep.id)).not.toBeNull();
		expect(await store.getSnapshot(remove.id)).toBeNull();
		expect(await store.listFiles(PROJECT_ID, keep.id)).toHaveLength(1);

		await store.clearProjectMetadata(PROJECT_ID);
		expect(await store.getSnapshot(keep.id)).toBeNull();
	});

	it("keeps retained snapshot data usable for the next incremental copy after cleanup", async () => {
		const keep = await createSnapshot();
		const remove = await createSnapshot();

		await store.upsertFile(PROJECT_ID, {
			snapshotId: keep.id,
			path: "src/keep.ts",
			sha256: "keep",
			mtimeMs: 1,
			size: 10,
			languageId: "typescript",
		});
		await store.replaceChunks(PROJECT_ID, keep.id, "src/keep.ts", [
			{
				chunkId: "keep-chunk-1",
				startLine: 1,
				endLine: 2,
				contentHash: "keep-chunk-hash",
				tokenEstimate: 5,
				chunkType: "impl",
			},
		]);
		await store.replaceSymbols(PROJECT_ID, keep.id, "src/keep.ts", [
			{
				id: "keep-symbol-1",
				kind: "function",
				name: "kept",
				exported: true,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 2, character: 0 },
				},
			},
		]);
		await store.replaceDependencies(PROJECT_ID, keep.id, "src/keep.ts", [
			{
				id: "keep-dep-1",
				toSpecifier: "./dep",
				toPath: "src/dep.ts",
				kind: "import",
				dependencyType: "internal",
			},
		]);
		await store.upsertFileMetrics(PROJECT_ID, {
			snapshotId: keep.id,
			filePath: "src/keep.ts",
			metrics: {
				complexity: 2,
				maintainability: 95,
				churn: 1,
				testCoverage: 100,
			},
		});

		await store.upsertFile(PROJECT_ID, {
			snapshotId: remove.id,
			path: "src/remove.ts",
			sha256: "remove",
			mtimeMs: 2,
			size: 20,
			languageId: "typescript",
		});

		await store.clearProjectMetadata(PROJECT_ID, keep.id);

		const next = await createSnapshot();
		await store.copyUnchangedFileData(PROJECT_ID, keep.id, next.id, [
			"src/keep.ts",
		]);

		expect(await store.getSnapshot(keep.id)).not.toBeNull();
		expect(await store.getSnapshot(remove.id)).toBeNull();
		expect(await store.getFile(PROJECT_ID, keep.id, "src/keep.ts")).toEqual({
			snapshotId: keep.id,
			path: "src/keep.ts",
			sha256: "keep",
			mtimeMs: 1,
			size: 10,
			languageId: "typescript",
		});
		expect(
			await store.listChunks(PROJECT_ID, keep.id, "src/keep.ts"),
		).toHaveLength(1);
		expect(
			await store.listSymbols(PROJECT_ID, keep.id, "src/keep.ts"),
		).toHaveLength(1);
		expect(
			await store.listDependencies(PROJECT_ID, keep.id, "src/keep.ts"),
		).toHaveLength(1);
		expect(await store.listFileMetrics(PROJECT_ID, keep.id)).toEqual([
			{
				snapshotId: keep.id,
				filePath: "src/keep.ts",
				metrics: {
					complexity: 2,
					maintainability: 95,
					churn: 1,
					testCoverage: 100,
				},
			},
		]);
		expect(await store.listFiles(PROJECT_ID, next.id)).toEqual([
			{
				snapshotId: next.id,
				path: "src/keep.ts",
				sha256: "keep",
				mtimeMs: 1,
				size: 10,
				languageId: "typescript",
			},
		]);
		expect(await store.listChunks(PROJECT_ID, next.id)).toHaveLength(1);
		expect(await store.listSymbols(PROJECT_ID, next.id)).toHaveLength(1);
		expect(await store.listDependencies(PROJECT_ID, next.id)).toHaveLength(1);
		expect(await store.listFileMetrics(PROJECT_ID, next.id)).toEqual([
			{
				snapshotId: next.id,
				filePath: "src/keep.ts",
				metrics: {
					complexity: 2,
					maintainability: 95,
					churn: 1,
					testCoverage: 100,
				},
			},
		]);
	});

	it("rolls back a failed top-level transaction", async () => {
		await expect(
			store.transaction(async () => {
				await store.createSnapshot(PROJECT_ID, { indexedAt: 0 });
				throw new Error("fail");
			}),
		).rejects.toThrow("fail");

		expect(await store.listSnapshots(PROJECT_ID)).toEqual([]);
	});

	it("uses savepoints for nested transactions", async () => {
		const snapshot = await createSnapshot();

		await store.transaction(async () => {
			await store.upsertFile(PROJECT_ID, {
				snapshotId: snapshot.id,
				path: "src/outer.ts",
				sha256: "outer",
				mtimeMs: 1,
				size: 1,
				languageId: "typescript",
			});

			await expect(
				store.transaction(async () => {
					await store.upsertFile(PROJECT_ID, {
						snapshotId: snapshot.id,
						path: "src/inner.ts",
						sha256: "inner",
						mtimeMs: 2,
						size: 2,
						languageId: "typescript",
					});
					throw new Error("inner failure");
				}),
			).rejects.toThrow("inner failure");
		});

		expect(
			await store.getFile(PROJECT_ID, snapshot.id, "src/outer.ts"),
		).not.toBeNull();
		expect(
			await store.getFile(PROJECT_ID, snapshot.id, "src/inner.ts"),
		).toBeNull();
	});

	async function createSnapshot() {
		return store.createSnapshot(PROJECT_ID, {
			headCommit: "head",
			indexedAt: 0,
		});
	}
});
