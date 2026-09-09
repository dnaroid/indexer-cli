import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteVecVectorStore } from "../../../src/storage/vectors.js";

describe("SqliteVecVectorStore initialization safety", () => {
	let tempDir: string;
	let dbPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "indexer-cli-vec-"));
		dbPath = path.join(tempDir, "db.sqlite");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("sets WAL mode on connection", async () => {
		const store = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });

		try {
			await store.initialize();
			const db = (store as any).db;
			const mode = db.pragma("journal_mode", { simple: true });

			expect(mode).toBe("wal");
		} finally {
			await store.close();
		}
	});

	it("sets busy_timeout on connection", async () => {
		const store = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });

		try {
			await store.initialize();
			const db = (store as any).db;
			const timeout = db.pragma("busy_timeout", { simple: true });

			expect(timeout).toBe(5000);
		} finally {
			await store.close();
		}
	});

	it("handles concurrent initialize() calls without errors", async () => {
		const store1 = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		const store2 = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });

		try {
			await Promise.all([store1.initialize(), store2.initialize()]);

			expect((store1 as any).initialized).toBe(true);
			expect((store2 as any).initialized).toBe(true);
		} finally {
			await Promise.allSettled([store1.close(), store2.close()]);
		}
	});

	it("creates tables and vec_chunks virtual table", async () => {
		const store = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });

		try {
			await store.initialize();
			const db = (store as any).db;
			const vectorMetaTable = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vector_meta'",
				)
				.get();
			const vecChunksTable = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'",
				)
				.get();

			expect(vectorMetaTable).toBeDefined();
			expect(vecChunksTable).toBeDefined();
		} finally {
			await store.close();
		}
	});

	it("migrates an existing vector_meta table and keeps old rows in code", async () => {
		const legacyDb = new Database(dbPath);
		sqliteVec.load(legacyDb);
		legacyDb.exec(`
			CREATE TABLE vector_meta (
				chunk_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
				snapshot_id TEXT NOT NULL, file_path TEXT NOT NULL,
				start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
				content_hash TEXT NOT NULL, chunk_type TEXT NOT NULL DEFAULT '',
				primary_symbol TEXT NOT NULL DEFAULT ''
			);
			CREATE VIRTUAL TABLE vec_chunks USING vec0(
				chunk_id TEXT PRIMARY KEY, embedding float[3]
			);
		`);
		legacyDb
			.prepare(
				"INSERT INTO vector_meta (chunk_id, project_id, snapshot_id, file_path, start_line, end_line, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("legacy", "project-1", "snapshot-1", "src/legacy.ts", 1, 2, "hash");
		legacyDb
			.prepare("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)")
			.run("legacy", new Float32Array([1, 0, 0]));
		legacyDb.close();

		const store = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		try {
			await store.initialize();
			expect(await store.countVectors({ projectId: "project-1" })).toBe(1);
			expect(await store.countVectors({ projectId: "project-1", domain: "document" })).toBe(0);
		} finally {
			await store.close();
		}
	});
});
