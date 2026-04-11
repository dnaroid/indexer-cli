import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
});
