import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	SqliteVecVectorStore,
	REQUIRED_COLUMNS,
} from "../../../src/storage/vectors.js";

const { existsSyncMock, rmSyncMock } = vi.hoisted(() => ({
	existsSyncMock: vi.fn(() => false),
	rmSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: existsSyncMock,
		rmSync: rmSyncMock,
	};
});

function createStore(
	overrides: Partial<{ vectorSize: number }> = {},
): SqliteVecVectorStore {
	return new SqliteVecVectorStore({
		dbPath: ":memory:",
		vectorSize: overrides.vectorSize ?? 3,
	});
}

function createVectorRecord(index: number) {
	return {
		projectId: "project-1",
		chunkId: `chunk-${index}`,
		snapshotId: "snap-1",
		filePath: `src/file-${index}.ts`,
		startLine: index,
		endLine: index + 1,
		contentHash: `hash-${index}`,
		chunkType: index % 2 === 0 ? "impl" : undefined,
		primarySymbol: index % 2 === 0 ? `symbol${index}` : undefined,
		embedding: [index, index + 1, index + 2],
	};
}

beforeEach(() => {
	vi.useRealTimers();
	existsSyncMock.mockReturnValue(false);
	rmSyncMock.mockReset();
});

describe("SqliteVecVectorStore constants", () => {
	it("exports the required schema columns", () => {
		expect(REQUIRED_COLUMNS).toEqual([
			"project_id",
			"chunk_id",
			"snapshot_id",
			"file_path",
			"start_line",
			"end_line",
			"content_hash",
			"chunk_type",
			"primary_symbol",
			"embedding",
		]);
	});
});

describe("SqliteVecVectorStore internal logic", () => {
	it("escapes SQL literals and LIKE patterns", () => {
		const store = createStore();
		expect((store as any).escapeSqlLiteral("it's 100%")).toBe("it''s 100%");
		expect((store as any).escapeSqlLike("foo_'bar%")).toBe("foo\\_''bar\\%");
		store.close();
	});

	it("builds a prefilter with escaped snapshot, prefix, and normalized chunk types", () => {
		const store = createStore();
		const filter = (store as any).buildPrefilter({
			projectId: "project-a",
			snapshotId: "snap-'1",
			pathPrefix: "src/_private%",
			chunkTypes: [" impl ", "", "types", "need's"],
		});

		expect(filter).toBe(
			"snapshot_id = 'snap-''1' AND file_path LIKE 'src/\\_private\\%%' AND chunk_type IN ('impl', 'types', 'need''s')",
		);
		store.close();
	});

	it("prefers exact filePath over pathPrefix when building the prefilter", () => {
		const store = createStore();
		const filter = (store as any).buildPrefilter({
			projectId: "project-a",
			filePath: "src/exact.ts",
			pathPrefix: "src/ignored",
		});

		expect(filter).toBe("file_path = 'src/exact.ts'");
		store.close();
	});

	it("returns an empty prefilter when no optional conditions are present", () => {
		const store = createStore();
		expect(
			(store as any).buildPrefilter({
				projectId: "project-a",
			}),
		).toBe("");
		store.close();
	});

	it("builds prefilter with table alias prefix", () => {
		const store = createStore();
		const filter = (store as any).buildPrefilter(
			{
				projectId: "project-a",
				snapshotId: "snap-1",
			},
			"vm",
		);

		expect(filter).toBe("vm.snapshot_id = 'snap-1'");
		store.close();
	});

	it("converts embedding array to Buffer", () => {
		const store = createStore();
		const buffer = (store as any).embeddingToBuffer([1.0, 2.5, 3.0]);
		expect(buffer).toBeInstanceOf(Buffer);
		const float32 = new Float32Array(buffer.buffer);
		expect(float32[0]).toBeCloseTo(1.0);
		expect(float32[1]).toBeCloseTo(2.5);
		expect(float32[2]).toBeCloseTo(3.0);
		store.close();
	});

	it("normalizes embedding values from database (Buffer, Uint8Array, ArrayBuffer)", () => {
		const store = createStore();
		const buf = Buffer.from(new Float32Array([1, 2, 3]).buffer);

		expect((store as any).normalizeEmbeddingValue(buf)).toBe(buf);

		const uint8 = new Uint8Array(buf);
		expect((store as any).normalizeEmbeddingValue(uint8)).toBeInstanceOf(
			Buffer,
		);

		const ab = buf.buffer.slice(
			buf.byteOffset,
			buf.byteOffset + buf.byteLength,
		);
		expect((store as any).normalizeEmbeddingValue(ab)).toBeInstanceOf(Buffer);

		expect(() => (store as any).normalizeEmbeddingValue("bad")).toThrow(
			"Unsupported sqlite-vec embedding value",
		);
		store.close();
	});
});

describe("SqliteVecVectorStore lifecycle", () => {
	it("initializes and creates tables on first call, no-ops on second", async () => {
		const store = createStore();
		await store.initialize();
		expect((store as any).initialized).toBe(true);

		await store.initialize();
		expect((store as any).initialized).toBe(true);

		await store.close();
		expect((store as any).initialized).toBe(false);
		expect((store as any).db).toBeNull();
	});

	it("constructor opens database and loads sqlite-vec extension", () => {
		const store = createStore();
		expect((store as any).db).not.toBeNull();

		const db = (store as any).db;
		const version = db.prepare("SELECT vec_version() AS v").get() as {
			v: string;
		};
		expect(version.v).toBeTruthy();
		store.close();
	});
});

describe("SqliteVecVectorStore upsert", () => {
	it("skips empty batches without initializing", async () => {
		const store = createStore();
		await store.upsert([]);
		expect((store as any).initialized).toBe(false);
		store.close();
	});

	it("inserts records and retrieves them via countVectors", async () => {
		const store = createStore();
		const records = [createVectorRecord(0), createVectorRecord(1)];
		await store.upsert(records);

		const count = await store.countVectors({
			projectId: "project-1",
			snapshotId: "snap-1",
		});
		expect(count).toBe(2);
		store.close();
	});

	it("normalizes undefined chunkType and primarySymbol to empty strings", async () => {
		const store = createStore();
		await store.upsert([createVectorRecord(1)]);

		const count = await store.countVectors({
			projectId: "project-1",
			snapshotId: "snap-1",
			chunkTypes: [""],
		});
		expect(count).toBe(1);
		store.close();
	});

	it("handles upsert of 200+ records in batches", async () => {
		const store = createStore();
		const records = Array.from({ length: 201 }, (_, i) =>
			createVectorRecord(i),
		);
		await store.upsert(records);

		const count = await store.countVectors({
			projectId: "project-1",
			snapshotId: "snap-1",
		});
		expect(count).toBe(201);
		store.close();
	});

	it("replaces existing records on re-upsert", async () => {
		const store = createStore();
		await store.upsert([createVectorRecord(0)]);

		const modified = {
			...createVectorRecord(0),
			filePath: "src/updated.ts",
		};
		await store.upsert([modified]);

		const count = await store.countVectors({
			projectId: "project-1",
			snapshotId: "snap-1",
		});
		expect(count).toBe(1);

		const results = await store.search([0, 1, 2], 1, {
			projectId: "project-1",
			snapshotId: "snap-1",
		});
		expect(results[0].filePath).toBe("src/updated.ts");
		store.close();
	});
});

describe("SqliteVecVectorStore search", () => {
	it("requires a projectId filter", async () => {
		const store = createStore();
		await expect(store.search([1, 2, 3], 5, {} as any)).rejects.toThrow(
			"projectId is required in filters for search",
		);
		store.close();
	});

	it("returns results sorted by distance with correct score calculation", async () => {
		const store = createStore();
		await store.upsert([
			{
				...createVectorRecord(0),
				chunkId: "chunk-far",
				embedding: [0, 1, 0],
			},
			{
				...createVectorRecord(1),
				chunkId: "chunk-near",
				embedding: [1, 0, 0],
			},
		]);

		const results = await store.search([1, 0, 0], 1, {
			projectId: "project-1",
			snapshotId: "snap-1",
		});

		expect(results).toHaveLength(1);
		expect(results[0].chunkId).toBe("chunk-near");
		expect(results[0].distance).toBeCloseTo(0);
		expect(results[0].score).toBeCloseTo(1);
		store.close();
	});

	it("filters by snapshotId, pathPrefix, and chunkTypes", async () => {
		const store = createStore();
		await store.upsert([
			{
				...createVectorRecord(0),
				chunkId: "chunk-impl",
				chunkType: "impl",
				filePath: "src/foo.ts",
				embedding: [1, 0, 0],
			},
			{
				...createVectorRecord(1),
				chunkId: "chunk-types",
				chunkType: "types",
				filePath: "src/bar.ts",
				embedding: [0, 1, 0],
			},
			{
				...createVectorRecord(2),
				chunkId: "chunk-other-snap",
				snapshotId: "snap-2",
				chunkType: "impl",
				filePath: "src/baz.ts",
				embedding: [0, 0, 1],
			},
		]);

		const results = await store.search([1, 0, 0], 5, {
			projectId: "project-1",
			snapshotId: "snap-1",
			pathPrefix: "src/",
			chunkTypes: ["impl"],
		});

		expect(results).toHaveLength(1);
		expect(results[0].chunkId).toBe("chunk-impl");
		store.close();
	});

	it("filters by exact filePath", async () => {
		const store = createStore();
		await store.upsert([
			{
				...createVectorRecord(0),
				chunkId: "chunk-a",
				filePath: "src/exact.ts",
				embedding: [1, 0, 0],
			},
			{
				...createVectorRecord(1),
				chunkId: "chunk-b",
				filePath: "src/other.ts",
				embedding: [0, 1, 0],
			},
		]);

		const results = await store.search([1, 0, 0], 5, {
			projectId: "project-1",
			filePath: "src/exact.ts",
		});

		expect(results).toHaveLength(1);
		expect(results[0].chunkId).toBe("chunk-a");
		store.close();
	});

	it("returns empty results when no matches", async () => {
		const store = createStore();
		await store.upsert([createVectorRecord(0)]);

		const results = await store.search([0, 0, 0], 5, {
			projectId: "project-1",
			snapshotId: "nonexistent",
		});
		expect(results).toHaveLength(0);
		store.close();
	});

	it("maps result fields correctly", async () => {
		const store = createStore();
		await store.upsert([
			{
				projectId: "project-1",
				chunkId: "chunk-1",
				snapshotId: "snap-1",
				filePath: "src/test.ts",
				startLine: 3,
				endLine: 4,
				contentHash: "hash-1",
				chunkType: "impl",
				primarySymbol: "MyFunc",
				embedding: [0.25, 0.25, 0.25],
			},
		]);

		const results = await store.search([0.25, 0.25, 0.25], 1, {
			projectId: "project-1",
			snapshotId: "snap-1",
		});

		expect(results).toHaveLength(1);
		const r = results[0];
		expect(r.chunkId).toBe("chunk-1");
		expect(r.snapshotId).toBe("snap-1");
		expect(r.filePath).toBe("src/test.ts");
		expect(r.startLine).toBe(3);
		expect(r.endLine).toBe(4);
		expect(r.contentHash).toBe("hash-1");
		expect(r.chunkType).toBe("impl");
		expect(r.primarySymbol).toBe("MyFunc");
		expect(typeof r.distance).toBe("number");
		expect(r.score).toBeCloseTo(1);
		store.close();
	});

	it("returns undefined chunkType/primarySymbol for empty strings", async () => {
		const store = createStore();
		await store.upsert([
			{
				projectId: "project-1",
				chunkId: "chunk-1",
				snapshotId: "snap-1",
				filePath: "src/test.ts",
				startLine: 1,
				endLine: 2,
				contentHash: "hash-1",
				embedding: [1, 2, 3],
			},
		]);

		const results = await store.search([1, 2, 3], 1, {
			projectId: "project-1",
		});

		expect(results[0].chunkType).toBeUndefined();
		expect(results[0].primarySymbol).toBeUndefined();
		store.close();
	});
});

describe("SqliteVecVectorStore countVectors", () => {
	it("requires a projectId filter", async () => {
		const store = createStore();
		await expect(store.countVectors({} as any)).rejects.toThrow(
			"projectId is required in filters for countVectors",
		);
		store.close();
	});

	it("counts all vectors for a project", async () => {
		const store = createStore();
		await store.upsert([
			createVectorRecord(0),
			createVectorRecord(1),
			createVectorRecord(2),
		]);

		const count = await store.countVectors({ projectId: "project-1" });
		expect(count).toBe(3);
		store.close();
	});

	it("filters by snapshotId", async () => {
		const store = createStore();
		await store.upsert([
			createVectorRecord(0),
			{ ...createVectorRecord(1), snapshotId: "snap-2" },
		]);

		const count = await store.countVectors({
			projectId: "project-1",
			snapshotId: "snap-1",
		});
		expect(count).toBe(1);
		store.close();
	});

	it("filters by pathPrefix", async () => {
		const store = createStore();
		await store.upsert([
			{ ...createVectorRecord(0), filePath: "src/foo.ts" },
			{ ...createVectorRecord(1), filePath: "lib/bar.ts" },
		]);

		const count = await store.countVectors({
			projectId: "project-1",
			pathPrefix: "src/",
		});
		expect(count).toBe(1);
		store.close();
	});

	it("filters by chunkTypes", async () => {
		const store = createStore();
		await store.upsert([
			{ ...createVectorRecord(0), chunkType: "impl" },
			{ ...createVectorRecord(1), chunkType: "types" },
		]);

		const count = await store.countVectors({
			projectId: "project-1",
			chunkTypes: ["impl"],
		});
		expect(count).toBe(1);
		store.close();
	});

	it("returns 0 when no vectors match", async () => {
		const store = createStore();
		await store.upsert([createVectorRecord(0)]);

		const count = await store.countVectors({
			projectId: "project-1",
			snapshotId: "nonexistent",
		});
		expect(count).toBe(0);
		store.close();
	});
});

describe("SqliteVecVectorStore deleteBySnapshot", () => {
	it("deletes vectors for a specific snapshot", async () => {
		const store = createStore();
		await store.upsert([
			{ ...createVectorRecord(0), snapshotId: "snap-1" },
			{ ...createVectorRecord(1), snapshotId: "snap-2" },
		]);

		await store.deleteBySnapshot("project-1" as any, "snap-1" as any);

		const count1 = await store.countVectors({
			projectId: "project-1",
			snapshotId: "snap-1",
		});
		const count2 = await store.countVectors({
			projectId: "project-1",
			snapshotId: "snap-2",
		});
		expect(count1).toBe(0);
		expect(count2).toBe(1);
		store.close();
	});
});

describe("SqliteVecVectorStore copyVectors", () => {
	it("copies vectors from one snapshot to another, excluding specified files", async () => {
		const store = createStore();
		await store.upsert([
			{
				...createVectorRecord(0),
				chunkId: "chunk-keep",
				filePath: "src/keep.ts",
				snapshotId: "snap-old",
			},
			{
				...createVectorRecord(1),
				chunkId: "chunk-skip",
				filePath: "src/skip.ts",
				snapshotId: "snap-old",
			},
		]);

		await store.copyVectors(
			"project-1" as any,
			"snap-old" as any,
			"snap-new" as any,
			["src/skip.ts"],
		);

		const newCount = await store.countVectors({
			projectId: "project-1",
			snapshotId: "snap-new",
		});
		expect(newCount).toBe(1);

		const results = await store.search([0, 1, 2], 1, {
			projectId: "project-1",
			snapshotId: "snap-new",
		});
		expect(results[0].filePath).toBe("src/keep.ts");
		store.close();
	});

	it("skips add when nothing remains after exclusions", async () => {
		const store = createStore();
		await store.upsert([
			{
				...createVectorRecord(0),
				filePath: "src/skip.ts",
				snapshotId: "snap-old",
			},
		]);

		await store.copyVectors(
			"project-1" as any,
			"snap-old" as any,
			"snap-new" as any,
			["src/skip.ts"],
		);

		const count = await store.countVectors({
			projectId: "project-1",
			snapshotId: "snap-new",
		});
		expect(count).toBe(0);
		store.close();
	});

	it("copies all vectors when no exclusions", async () => {
		const store = createStore();
		await store.upsert([
			{
				...createVectorRecord(0),
				snapshotId: "snap-old",
			},
			{
				...createVectorRecord(1),
				snapshotId: "snap-old",
			},
		]);

		await store.copyVectors(
			"project-1" as any,
			"snap-old" as any,
			"snap-new" as any,
			[],
		);

		const count = await store.countVectors({
			projectId: "project-1",
			snapshotId: "snap-new",
		});
		expect(count).toBe(2);
		store.close();
	});
});

describe("SqliteVecVectorStore deleteByProject", () => {
	it("deletes all vectors for a project", async () => {
		const store = createStore();
		await store.upsert([
			{ ...createVectorRecord(0), snapshotId: "snap-1" },
			{ ...createVectorRecord(1), snapshotId: "snap-2" },
		]);

		await store.deleteByProject("project-1" as any);

		const count = await store.countVectors({ projectId: "project-1" });
		expect(count).toBe(0);
		store.close();
	});

	it("removes legacy vectors directory when present", async () => {
		const store = new SqliteVecVectorStore({
			dbPath: ":memory:",
			vectorSize: 3,
		});
		await store.initialize();

		existsSyncMock.mockReturnValue(true);
		rmSyncMock.mockReset();

		await store.deleteByProject("project-1" as any);

		expect(rmSyncMock).toHaveBeenCalledWith("vectors", {
			recursive: true,
			force: true,
		});

		existsSyncMock.mockReturnValue(false);
		store.close();
	});
});
