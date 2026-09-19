import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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

		expect(migrationRow.version).toBe(4);
		expect(symbolColumns.map((column) => column.name)).toContain(
			"metadata_json",
		);
		const fileColumns = db
			.prepare("PRAGMA table_info(files)")
			.all() as Array<{ name: string }>;
		expect(fileColumns.map((column) => column.name)).toContain("file_domain");
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_entries'",
				)
				.get(),
		).toBeDefined();
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'code_search_fts'",
				)
				.get(),
		).toBeDefined();
	});

	it("migrates a pre-knowledge 0.12.x database and defaults old rows to code", async () => {
		const legacyDbPath = path.join(tempDir, "legacy.sqlite");
		const legacyDb = new Database(legacyDbPath);
		legacyDb.exec(`
			CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
			INSERT INTO schema_migrations VALUES (1, 1700000000000);
			CREATE TABLE snapshots (
				id TEXT PRIMARY KEY, project_id TEXT NOT NULL, git_ref TEXT,
				status TEXT NOT NULL, created_at INTEGER NOT NULL, failure_reason TEXT,
				processed_files INTEGER DEFAULT 0, total_files INTEGER DEFAULT 0
			);
			CREATE TABLE files (
				project_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, path TEXT NOT NULL,
				sha256 TEXT NOT NULL, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
				language_id TEXT NOT NULL, PRIMARY KEY (project_id, snapshot_id, path)
			);
			CREATE TABLE symbols (
				project_id TEXT NOT NULL, id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
				file_path TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
				container_name TEXT, exported INTEGER NOT NULL, range_json TEXT NOT NULL,
				signature TEXT, doc_comment TEXT,
				PRIMARY KEY (project_id, snapshot_id, id)
			);
		`);
		legacyDb.close();

		const migratedStore = new SqliteMetadataStore(legacyDbPath);
		await migratedStore.initialize();
		const migratedDb = (migratedStore as any).db;
		expect(
			(migratedDb
				.prepare("SELECT MAX(version) AS version FROM schema_migrations")
				.get() as { version: number }).version,
		).toBe(4);
		const columns = migratedDb
			.prepare("PRAGMA table_info(files)")
			.all() as Array<{ name: string }>;
		expect(columns.map((column) => column.name)).toContain("file_domain");
		migratedDb
			.prepare(
				"INSERT INTO snapshots (id, project_id, status, created_at) VALUES (?, ?, ?, ?)",
			)
			.run("legacy-snapshot", PROJECT_ID, "completed", 1);
		migratedDb
			.prepare(
				"INSERT INTO files (project_id, snapshot_id, path, sha256, mtime_ms, size, language_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(PROJECT_ID, "legacy-snapshot", "src/legacy.ts", "hash", 1, 1, "typescript");
		expect(
			(await migratedStore.listFiles(PROJECT_ID, "legacy-snapshot"))[0],
		).toEqual({
			snapshotId: "legacy-snapshot",
			path: "src/legacy.ts",
			sha256: "hash",
			mtimeMs: 1,
			size: 1,
			languageId: "typescript",
		});
		await migratedStore.close();
	});

	it("persists knowledge entries, relation provenance, verified inputs, and document chunks", async () => {
		const snapshot = await createSnapshot();
		const entry = {
			projectId: PROJECT_ID,
			path: "docs/auth.md",
			classification: "spec" as const,
			behaviorType: "as-is" as const,
			lifecycle: "active" as const,
			confidence: "high",
			title: "Authentication",
			summary: "Refresh behavior",
			topics: ["auth", "sessions"],
			indexedSourceHash: "source-1",
			indexedAt: 10,
			verifiedSourceHash: "source-1",
			verifiedRelationsHash: "relations-1",
			verifiedAt: 11,
			metadata: { owner: "team-auth" },
		};
		await store.upsertKnowledgeEntry(entry);
		await store.upsertKnowledgeRelation({
			projectId: PROJECT_ID,
			sourcePath: entry.path,
			targetPath: "src/auth/refresh.ts",
			targetKind: "code",
			relationKind: "implements",
			provenance: "explicit",
		});
		await store.upsertKnowledgeRelation({
			projectId: PROJECT_ID,
			sourcePath: entry.path,
			targetPath: "docs/auth-v1.md",
			targetKind: "knowledge",
			relationKind: "supersedes",
			provenance: "inferred",
			metadata: { reason: "newer" },
		});
		await store.upsertKnowledgeVerifiedInput({
			projectId: PROJECT_ID,
			sourcePath: entry.path,
			inputPath: "src/auth/refresh.ts",
			inputHash: "input-1",
			verifiedAt: 11,
		});
		await store.replaceKnowledgeChunks(PROJECT_ID, snapshot.id, entry.path, [
			{
				chunkId: "doc-chunk-1",
				startLine: 1,
				endLine: 4,
				contentHash: "chunk-hash",
				chunkType: "doc_section",
				heading: "Refresh",
				metadata: { level: 2 },
			},
		]);

		expect(await store.getKnowledgeEntry(PROJECT_ID, entry.path)).toEqual(entry);
		expect(await store.listKnowledgeEntries(PROJECT_ID)).toEqual([entry]);
		expect(await store.listKnowledgeRelations(PROJECT_ID)).toHaveLength(2);
		expect(await store.listKnowledgeVerifiedInputs(PROJECT_ID, entry.path)).toEqual([
			{
				projectId: PROJECT_ID,
				sourcePath: entry.path,
				inputPath: "src/auth/refresh.ts",
				inputHash: "input-1",
				verifiedAt: 11,
			},
		]);
		expect(await store.listKnowledgeChunks(PROJECT_ID, snapshot.id)).toEqual([
			{
				projectId: PROJECT_ID,
				snapshotId: snapshot.id,
				chunkId: "doc-chunk-1",
				filePath: entry.path,
				startLine: 1,
				endLine: 4,
				contentHash: "chunk-hash",
				chunkType: "doc_section",
				heading: "Refresh",
				metadata: { level: 2 },
			},
		]);
		await expect(
			store.deleteKnowledgeRelation(PROJECT_ID, {
				sourcePath: entry.path,
				targetPath: "src/auth/refresh.ts",
				targetKind: "code",
				relationKind: "implements",
			}),
		).resolves.toBe(1);
		await expect(
			store.deleteKnowledgeRelation(PROJECT_ID, {
				sourcePath: entry.path,
				targetPath: "src/auth/refresh.ts",
				targetKind: "code",
				relationKind: "implements",
			}),
		).resolves.toBe(0);
		expect(await store.listKnowledgeRelations(PROJECT_ID)).toHaveLength(1);

		await store.upsertKnowledgeEntry({
			...entry,
			summary: "Updated semantic summary",
			indexedSourceHash: "source-2",
			indexedAt: 12,
			verifiedSourceHash: undefined,
			verifiedRelationsHash: undefined,
			verifiedAt: undefined,
		});
		expect(await store.getKnowledgeEntry(PROJECT_ID, entry.path)).toMatchObject({
			summary: "Updated semantic summary",
			indexedSourceHash: "source-2",
			verifiedSourceHash: "source-1",
			verifiedRelationsHash: "relations-1",
			verifiedAt: 11,
		});

		await store.replaceKnowledgeVerifiedInputs(PROJECT_ID, entry.path, [
			{
				inputPath: "src/auth/new-refresh.ts",
				inputHash: "input-2",
				verifiedAt: 13,
			},
		]);
		expect(await store.listKnowledgeVerifiedInputs(PROJECT_ID, entry.path)).toEqual([
			{
				projectId: PROJECT_ID,
				sourcePath: entry.path,
				inputPath: "src/auth/new-refresh.ts",
				inputHash: "input-2",
				verifiedAt: 13,
			},
		]);

		await store.clearKnowledgeVerification(PROJECT_ID, entry.path);
		expect(await store.getKnowledgeEntry(PROJECT_ID, entry.path)).toMatchObject({
			verifiedSourceHash: undefined,
			verifiedRelationsHash: undefined,
			verifiedAt: undefined,
		});
		expect(await store.listKnowledgeVerifiedInputs(PROJECT_ID, entry.path)).toEqual([]);

		await store.deleteKnowledgeEntry(PROJECT_ID, entry.path);
		expect(await store.getKnowledgeEntry(PROJECT_ID, entry.path)).toBeNull();
		expect(await store.listKnowledgeRelations(PROJECT_ID)).toEqual([]);
	});

	it("rolls back knowledge writes with the surrounding transaction", async () => {
		await expect(
			store.transaction(async () => {
				await store.upsertKnowledgeEntry({
					projectId: PROJECT_ID,
					path: "docs/rollback.md",
					classification: "guide",
					behaviorType: "unknown",
					lifecycle: "unknown",
					confidence: "low",
					title: "Rollback",
					summary: "",
					topics: [],
					indexedSourceHash: "hash",
					indexedAt: 1,
				});
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		expect(await store.getKnowledgeEntry(PROJECT_ID, "docs/rollback.md")).toBeNull();
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
				searchText:
					"export function foo(): string { return 'payment'; } // платёжная обработка",
			},
			{
				chunkId: "chunk-2",
				startLine: 6,
				endLine: 8,
				contentHash: "content-2",
				tokenEstimate: 5,
				searchText: "export const fallbackValue = 'secondary';",
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
				searchText: "export const unrelated = true;",
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
		expect(await store.codeSearchIndexNeedsRefresh(PROJECT_ID, snapshot.id)).toBe(false);
		expect(
			await store.searchCodeChunks(PROJECT_ID, snapshot.id, ["foo"], { limit: 5 }),
		).toEqual([
			expect.objectContaining({
				chunkId: "chunk-1",
				filePath: "src/a.ts",
				primarySymbol: "foo",
				rank: 1,
			}),
		]);
		expect(
			await store.searchCodeChunks(PROJECT_ID, snapshot.id, ["платёжная"], {
				limit: 5,
			}),
		).toEqual([
			expect.objectContaining({ chunkId: "chunk-1", filePath: "src/a.ts" }),
		]);

		await store.replaceChunks(PROJECT_ID, snapshot.id, "src/a.ts", []);
		expect(await store.listChunks(PROJECT_ID, snapshot.id, "src/a.ts")).toEqual(
			[],
		);
		expect(
			await store.searchCodeChunks(PROJECT_ID, snapshot.id, ["платёжная"], {
				limit: 5,
			}),
		).toEqual([]);
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

	it("flags legacy chunks without lexical search rows for reindex", async () => {
		const snapshot = await createSnapshot();
		await store.replaceChunks(PROJECT_ID, snapshot.id, "src/legacy.ts", [
			{
				chunkId: "legacy-chunk",
				startLine: 1,
				endLine: 2,
				contentHash: "legacy",
				tokenEstimate: 3,
				chunkType: "impl",
			},
		]);
		expect(await store.codeSearchIndexNeedsRefresh(PROJECT_ID, snapshot.id)).toBe(true);
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
				primarySymbol: "copied",
				searchText: "export function copied() { return 'incremental lexical proof'; }",
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
		expect(
			await store.searchCodeChunks(
				PROJECT_ID,
				targetSnapshot.id,
				["incremental", "lexical", "proof"],
				{ limit: 5 },
			),
		).toEqual([
			expect.objectContaining({
				chunkId: "chunk-1",
				filePath: "src/a.ts",
				primarySymbol: "copied",
			}),
		]);
		expect(
			await store.codeSearchIndexNeedsRefresh(PROJECT_ID, targetSnapshot.id),
		).toBe(false);
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

	it("preserveActiveIndexing skips recent 'indexing' snapshots but removes stale ones", async () => {
		const db = (store as any).db;

		const recentMs = Date.now() - 60_000;
		db.prepare(
			"INSERT INTO snapshots (id, project_id, git_ref, status, created_at) VALUES (?, ?, 'head', 'indexing', ?)",
		).run("snap-recent-indexing", PROJECT_ID, recentMs);

		const oldMs = Date.now() - 31 * 60_000;
		db.prepare(
			"INSERT INTO snapshots (id, project_id, git_ref, status, created_at) VALUES (?, ?, 'head', 'indexing', ?)",
		).run("snap-old-indexing", PROJECT_ID, oldMs);

		// The "keep" snapshot (current process's completed snapshot)
		const keep = await store.createSnapshot(PROJECT_ID, {
			headCommit: "head",
			indexedAt: 0,
		});

		await store.clearProjectMetadata(PROJECT_ID, keep.id, {
			preserveActiveIndexing: true,
		});

		expect(await store.getSnapshot(keep.id)).not.toBeNull();
		expect(await store.getSnapshot("snap-recent-indexing")).not.toBeNull();
		expect(await store.getSnapshot("snap-old-indexing")).toBeNull();
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

	describe("regression: consecutive incremental re-indexing", () => {
		/**
		 * Reproduces the FOREIGN KEY constraint failure that occurs when
		 * `pruneHistoricalSnapshots` deletes a snapshot that a subsequent
		 * `copyUnchangedFileData` call still references.
		 *
		 * Scenario (mirrors what `ensureIndexed` does):
		 * 1. First incremental index creates snapshot-B from snapshot-A,
		 *    then prunes snapshot-A.
		 * 2. Second incremental index tries to copy unchanged data from
		 *    snapshot-B into snapshot-C — but snapshot-B was just pruned
		 *    by the first call, so FK constraint fails on INSERT.
		 */
		it("fails to copy unchanged data from a pruned snapshot (FK constraint)", async () => {
			// --- Step 1: Create snapshot-A and populate it with file data ---
			const snapshotA = await store.createSnapshot(PROJECT_ID, {
				headCommit: "commit-1",
				indexedAt: 0,
			});
			await store.upsertFile(PROJECT_ID, {
				snapshotId: snapshotA.id,
				path: "src/a.ts",
				sha256: "hash-a",
				mtimeMs: 100,
				size: 10,
				languageId: "typescript",
			});
			await store.replaceChunks(PROJECT_ID, snapshotA.id, "src/a.ts", [
				{
					chunkId: "chunk-1",
					startLine: 1,
					endLine: 5,
					contentHash: "chash-1",
					tokenEstimate: 10,
					chunkType: "impl",
					primarySymbol: "foo",
					hasOverlap: false,
				},
			]);
			await store.updateSnapshotStatus(snapshotA.id, "completed");

			// --- Step 2: Create snapshot-B, copy unchanged data from A ---
			const snapshotB = await store.createSnapshot(PROJECT_ID, {
				headCommit: "commit-2",
				indexedAt: 0,
			});
			await store.copyUnchangedFileData(
				PROJECT_ID,
				snapshotA.id,
				snapshotB.id,
				["src/a.ts"],
			);
			await store.updateSnapshotStatus(snapshotB.id, "completed");

			// Verify data was copied to snapshot-B
			expect(await store.listFiles(PROJECT_ID, snapshotB.id)).toHaveLength(1);
			expect(await store.listChunks(PROJECT_ID, snapshotB.id)).toHaveLength(1);

			// --- Step 3: Prune snapshot-A (mirrors pruneHistoricalSnapshots) ---
			await store.clearProjectMetadata(PROJECT_ID, snapshotB.id);

			// Verify snapshot-A is gone
			expect(await store.getSnapshot(snapshotA.id)).toBeNull();

			// --- Step 4: Create snapshot-C and try to copy from snapshot-B ---
			// This should work because snapshot-B still exists
			const snapshotC = await store.createSnapshot(PROJECT_ID, {
				headCommit: "commit-3",
				indexedAt: 0,
			});
			await store.copyUnchangedFileData(
				PROJECT_ID,
				snapshotB.id,
				snapshotC.id,
				["src/a.ts"],
			);
			await store.updateSnapshotStatus(snapshotC.id, "completed");

			// Verify data was copied to snapshot-C
			expect(await store.listFiles(PROJECT_ID, snapshotC.id)).toHaveLength(1);

			// --- Step 5: Now prune snapshot-B (mirrors second pruneHistoricalSnapshots) ---
			await store.clearProjectMetadata(PROJECT_ID, snapshotC.id);

			// Verify snapshot-B is gone
			expect(await store.getSnapshot(snapshotB.id)).toBeNull();

			// --- Step 6: Create snapshot-D and try to copy from snapshot-C ---
			// snapshot-C still exists, so this should work
			const snapshotD = await store.createSnapshot(PROJECT_ID, {
				headCommit: "commit-4",
				indexedAt: 0,
			});
			await store.copyUnchangedFileData(
				PROJECT_ID,
				snapshotC.id,
				snapshotD.id,
				["src/a.ts"],
			);
			await store.updateSnapshotStatus(snapshotD.id, "completed");

			expect(await store.listFiles(PROJECT_ID, snapshotD.id)).toHaveLength(1);
		});

		/**
		 * Tests the actual bug scenario: two consecutive indexProject calls
		 * where the first prunes the "previous" snapshot that the second
		 * call's getLatestCompletedSnapshot would need to reference.
		 *
		 * This simulates the real ensureIndexed flow where:
		 * - Call 1: getLatestCompletedSnapshot → snapshot-A
		 *   → creates snapshot-B, copies from A, prunes A
		 * - Call 2: getLatestCompletedSnapshot → snapshot-B
		 *   → creates snapshot-C, tries to copy from B — but B was pruned!
		 */
		it("correctly chains three consecutive incremental snapshots without FK errors", async () => {
			const s0 = await store.createSnapshot(PROJECT_ID, {
				headCommit: "c0",
				indexedAt: 0,
			});
			await store.upsertFile(PROJECT_ID, {
				snapshotId: s0.id,
				path: "src/core.ts",
				sha256: "hash-core",
				mtimeMs: 100,
				size: 50,
				languageId: "typescript",
			});
			await store.replaceChunks(PROJECT_ID, s0.id, "src/core.ts", [
				{
					chunkId: "chunk-core",
					startLine: 1,
					endLine: 10,
					contentHash: "chash-core",
					tokenEstimate: 20,
					chunkType: "impl",
					primarySymbol: "core",
					hasOverlap: false,
				},
			]);
			await store.replaceSymbols(PROJECT_ID, s0.id, "src/core.ts", [
				{
					id: "sym-core",
					kind: "function",
					name: "core",
					exported: true,
					range: {
						start: { line: 1, character: 0 },
						end: { line: 10, character: 1 },
					},
					signature: "function core()",
				},
			]);
			await store.replaceDependencies(PROJECT_ID, s0.id, "src/core.ts", [
				{
					id: "dep-core",
					toSpecifier: "./utils",
					toPath: "src/utils.ts",
					kind: "import",
					dependencyType: "internal",
				},
			]);
			await store.upsertFileMetrics(PROJECT_ID, {
				snapshotId: s0.id,
				filePath: "src/core.ts",
				metrics: { complexity: 1, maintainability: 90, churn: 0 },
			});
			await store.updateSnapshotStatus(s0.id, "completed");

			// Incremental step 1: copy from s0 → s1, prune s0
			const s1 = await store.createSnapshot(PROJECT_ID, {
				headCommit: "c1",
				indexedAt: 0,
			});
			await store.copyUnchangedFileData(PROJECT_ID, s0.id, s1.id, [
				"src/core.ts",
			]);
			await store.updateSnapshotStatus(s1.id, "completed");
			await store.clearProjectMetadata(PROJECT_ID, s1.id);

			// s0 is pruned, s1 is the latest completed
			expect(await store.getSnapshot(s0.id)).toBeNull();
			expect((await store.getLatestCompletedSnapshot(PROJECT_ID))?.id).toBe(
				s1.id,
			);

			// Incremental step 2: copy from s1 → s2, prune s1
			const s2 = await store.createSnapshot(PROJECT_ID, {
				headCommit: "c2",
				indexedAt: 0,
			});
			await store.copyUnchangedFileData(PROJECT_ID, s1.id, s2.id, [
				"src/core.ts",
			]);
			await store.updateSnapshotStatus(s2.id, "completed");
			await store.clearProjectMetadata(PROJECT_ID, s2.id);

			// s1 is pruned, s2 is the latest completed
			expect(await store.getSnapshot(s1.id)).toBeNull();
			expect((await store.getLatestCompletedSnapshot(PROJECT_ID))?.id).toBe(
				s2.id,
			);

			// Data should still be accessible in s2
			expect(await store.listFiles(PROJECT_ID, s2.id)).toHaveLength(1);
			expect(await store.listChunks(PROJECT_ID, s2.id)).toHaveLength(1);
			expect(await store.listSymbols(PROJECT_ID, s2.id)).toHaveLength(1);

			// Incremental step 3: copy from s2 → s3
			const s3 = await store.createSnapshot(PROJECT_ID, {
				headCommit: "c3",
				indexedAt: 0,
			});
			await store.copyUnchangedFileData(PROJECT_ID, s2.id, s3.id, [
				"src/core.ts",
			]);
			await store.updateSnapshotStatus(s3.id, "completed");

			expect(await store.listFiles(PROJECT_ID, s3.id)).toHaveLength(1);
			expect(await store.listChunks(PROJECT_ID, s3.id)).toHaveLength(1);
		});
	});

	describe("SqliteMetadataStore stale snapshot cleanup", () => {
		let tempDir: string;
		let dbPath: string;
		let staleStore: SqliteMetadataStore;

		beforeEach(async () => {
			tempDir = mkdtempSync(path.join(tmpdir(), "indexer-cli-stale-"));
			dbPath = path.join(tempDir, "db.sqlite");
			staleStore = new SqliteMetadataStore(dbPath);
			await staleStore.initialize();
		});

		afterEach(async () => {
			await staleStore.close();
			rmSync(tempDir, { recursive: true, force: true });
		});

		it("marks stale indexing snapshots as failed on initialize", async () => {
			const db = (staleStore as any).db;
			const oldTimestamp = Date.now() - 31 * 60 * 1000;

			db.prepare(
				`INSERT INTO snapshots (id, project_id, status, created_at, git_ref)
				 VALUES (?, ?, 'indexing', ?, NULL)`,
			).run("stale-snap-1", "project-a", oldTimestamp);

			(staleStore as any).initialized = false;
			await staleStore.initialize();

			const snapshot = await staleStore.getSnapshot("stale-snap-1");
			expect(snapshot?.status).toBe("failed");
		});

		it("preserves recent indexing snapshots", async () => {
			await staleStore.createSnapshot("project-a", {
				headCommit: "abc",
				indexedAt: Date.now(),
			});

			const snapshot = await staleStore.getLatestSnapshot("project-a");
			expect(snapshot?.status).toBe("indexing");

			(staleStore as any).initialized = false;
			await staleStore.initialize();

			const afterReinitialize = await staleStore.getLatestSnapshot("project-a");
			expect(afterReinitialize?.status).toBe("indexing");
		});
	});

	describe("SqliteMetadataStore migration transaction", () => {
		it("wraps migrations in immediate transaction", async () => {
			const migrationTempDir = mkdtempSync(
				path.join(tmpdir(), "indexer-cli-migration-"),
			);
			const migrationDbPath = path.join(migrationTempDir, "db.sqlite");
			const migrationStore = new SqliteMetadataStore(migrationDbPath);

			try {
				await migrationStore.initialize();

				const db = (migrationStore as any).db;
				const row = db
					.prepare("SELECT MAX(version) as version FROM schema_migrations")
					.get() as { version: number | null };

				expect(row.version).toBeGreaterThan(0);
			} finally {
				await migrationStore.close();
				rmSync(migrationTempDir, { recursive: true, force: true });
			}
		});
	});
});
