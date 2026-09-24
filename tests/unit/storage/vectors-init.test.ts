import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteVecVectorStore } from "../../../src/storage/vectors.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";

function runInitializerProcess(scriptPath: string, dbPath: string): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", scriptPath, dbPath], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stderr }));
	});
}

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

	it("lets separate query processes initialize with an active snapshot membership gap while an index writer holds the database", async () => {
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		const scriptPath = path.join(tempDir, "initialize-query.ts");
		try {
			await metadata.initialize();
			await vectors.initialize();
			const completedSnapshot = await metadata.createSnapshot("project-1" as any, {
				headCommit: "completed",
				indexedAt: Date.now(),
			});
			await metadata.replaceChunks("project-1" as any, completedSnapshot.id, "src/shared.ts", [{
				chunkId: "shared-chunk",
				startLine: 1,
				endLine: 1,
				contentHash: "shared-hash",
				tokenEstimate: 1,
				chunkType: "full_file",
				primarySymbol: "shared",
				hasOverlap: false,
			}]);
			await metadata.updateSnapshotStatus(completedSnapshot.id, "completed");
			await vectors.upsert([{
				chunkId: "shared-chunk" as any,
				projectId: "project-1" as any,
				snapshotId: completedSnapshot.id,
				filePath: "src/shared.ts",
				startLine: 1,
				endLine: 1,
				contentHash: "shared-hash",
				embedding: [1, 0, 0],
			}]);
			const activeSnapshot = await metadata.createSnapshot("project-1" as any, {
				headCommit: "indexing",
				indexedAt: Date.now(),
			});
			await metadata.replaceChunks("project-1" as any, activeSnapshot.id, "src/shared.ts", [{
				chunkId: "shared-chunk",
				startLine: 1,
				endLine: 1,
				contentHash: "shared-hash",
				tokenEstimate: 1,
				chunkType: "full_file",
				primarySymbol: "shared",
				hasOverlap: false,
			}]);
			await metadata.updateSnapshotStatus(activeSnapshot.id, "indexing");
			await writeFile(scriptPath, `
import { SqliteMetadataStore } from ${JSON.stringify(pathToFileURL(path.resolve("src/storage/sqlite.ts")).href)};
import { SqliteVecVectorStore } from ${JSON.stringify(pathToFileURL(path.resolve("src/storage/vectors.ts")).href)};
const dbPath = process.argv[2];
void (async () => {
  const metadata = new SqliteMetadataStore(dbPath);
  const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
  await Promise.all([metadata.initialize(), vectors.initialize()]);
  await Promise.all([metadata.close(), vectors.close()]);
})();
`);

			const writer = new Database(dbPath);
			writer.exec("BEGIN IMMEDIATE");
			try {
				const results = await Promise.race([
					Promise.all([
						runInitializerProcess(scriptPath, dbPath),
						runInitializerProcess(scriptPath, dbPath),
					]),
					new Promise<never>((_, reject) => setTimeout(() => reject(new Error("query initialization blocked on writer")), 4_000)),
				]);
				expect(results).toEqual([
					{ code: 0, stderr: "" },
					{ code: 0, stderr: "" },
				]);
			} finally {
				writer.exec("ROLLBACK");
				writer.close();
			}
		} finally {
			await Promise.allSettled([metadata.close(), vectors.close()]);
		}
	});

	it("repairs a missing membership for a completed snapshot", async () => {
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		let repair: SqliteVecVectorStore | undefined;
		try {
			await metadata.initialize();
			await vectors.initialize();
			const snapshot = await metadata.createSnapshot("project-1" as any, {
				headCommit: "completed",
				indexedAt: Date.now(),
			});
			await metadata.replaceChunks("project-1" as any, snapshot.id, "src/missing.ts", [{
				chunkId: "missing-membership",
				startLine: 1,
				endLine: 1,
				contentHash: "missing-hash",
				tokenEstimate: 1,
				chunkType: "full_file",
				primarySymbol: "missing",
				hasOverlap: false,
			}]);
			await metadata.updateSnapshotStatus(snapshot.id, "completed");
			const db = (vectors as any).db;
			db.prepare("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)")
				.run("missing-membership", new Float32Array([1, 0, 0]));
			await vectors.close();
			repair = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });

			await repair.initialize();

			expect(await repair.countVectors({
				projectId: "project-1",
				snapshotId: snapshot.id,
			})).toBe(1);
		} finally {
			await Promise.allSettled([metadata.close(), vectors.close(), repair?.close()]);
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

	it("rejects an existing vector table with a different configured dimension", async () => {
		const original = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await original.initialize();
		await original.close();

		const mismatched = new SqliteVecVectorStore({ dbPath, vectorSize: 4 });
		try {
			await expect(mismatched.initialize()).rejects.toThrow(
				"Vector storage dimension mismatch: database uses 3, config expects 4",
			);
		} finally {
			await mismatched.close();
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
