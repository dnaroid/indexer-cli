import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock, existsSyncMock, rmSyncMock } = vi.hoisted(() => ({
	connectMock: vi.fn(),
	existsSyncMock: vi.fn(),
	rmSyncMock: vi.fn(),
}));

vi.mock("vectordb", () => ({
	connect: connectMock,
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: existsSyncMock,
		rmSync: rmSyncMock,
	};
});

import {
	LanceDbVectorStore,
	REQUIRED_COLUMNS,
} from "../../../src/storage/vectors.js";

function createStore(
	overrides: Partial<{
		dbPath: string;
		vectorSize: number;
		tableName: string;
		cacheTTL: number;
	}> = {},
) {
	return new LanceDbVectorStore({
		dbPath: "/tmp/fake-lancedb",
		vectorSize: 3,
		...overrides,
	});
}

function createQueryChain(rows: any[]) {
	return {
		where: vi.fn().mockReturnThis(),
		limit: vi.fn().mockReturnThis(),
		select: vi.fn().mockReturnThis(),
		toArray: vi.fn().mockResolvedValue(rows),
	};
}

function createFilterChain(rows: any[]) {
	return {
		limit: vi.fn().mockReturnThis(),
		select: vi.fn().mockReturnThis(),
		execute: vi.fn().mockResolvedValue(rows),
	};
}

function createSearchChain(rows: any[]) {
	return {
		limit: vi.fn().mockReturnThis(),
		where: vi.fn().mockReturnThis(),
		execute: vi.fn().mockResolvedValue(rows),
	};
}

function createMockTable(overrides: Record<string, any> = {}): any {
	return {
		getSchema: vi.fn().mockResolvedValue({
			fields: REQUIRED_COLUMNS.map((name) => ({ name })),
		}),
		add: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function createMockDb({
	tableNames = ["vectors"],
	table = createMockTable(),
	overrides = {},
}: {
	tableNames?: string[];
	table?: any;
	overrides?: Record<string, any>;
} = {}) {
	return {
		tableNames: vi.fn().mockResolvedValue(tableNames),
		createTable: vi.fn().mockResolvedValue(table),
		openTable: vi.fn().mockResolvedValue(table),
		dropTable: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
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
	connectMock.mockReset();
	existsSyncMock.mockReset();
	rmSyncMock.mockReset();
	vi.useRealTimers();
});

describe("LanceDbVectorStore internal logic", () => {
	const store = new LanceDbVectorStore({
		dbPath: "/tmp/fake-lancedb",
		vectorSize: 3,
	});

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
			"vector",
		]);
	});

	it("computes euclidean distance using the overlapping vector length", () => {
		expect((store as any).euclideanDistance([0, 0], [3, 4])).toBe(5);
		expect((store as any).euclideanDistance([1, 2, 99], [4, 6])).toBe(5);
	});

	it("escapes SQL literals and LIKE patterns", () => {
		expect((store as any).escapeSqlLiteral("it's 100%")).toBe("it''s 100%");
		expect((store as any).escapeSqlLike("foo_'bar%")).toBe("foo\\_''bar\\%");
	});

	it("builds a prefilter with escaped snapshot, prefix, and normalized chunk types", async () => {
		const filter = await (store as any).buildPrefilter({
			projectId: "project-a",
			snapshotId: "snap-'1",
			pathPrefix: "src/_private%",
			chunkTypes: [" impl ", "", "types", "need's"],
		});

		expect(filter).toBe(
			"snapshot_id = 'snap-''1' AND file_path LIKE 'src/\\_private\\%%' AND chunk_type IN ('impl', 'types', 'need''s')",
		);
	});

	it("prefers exact filePath over pathPrefix when building the prefilter", async () => {
		const filter = await (store as any).buildPrefilter({
			projectId: "project-a",
			filePath: "src/exact.ts",
			pathPrefix: "src/ignored",
		});

		expect(filter).toBe("file_path = 'src/exact.ts'");
	});

	it("returns an empty prefilter when no optional conditions are present", async () => {
		expect(
			await (store as any).buildPrefilter({
				projectId: "project-a",
			}),
		).toBe("");
	});

	it("validates schema fields against REQUIRED_COLUMNS", () => {
		expect(
			(store as any).hasRequiredSchema({
				fields: REQUIRED_COLUMNS.map((name) => ({ name })),
			}),
		).toBe(true);
		expect(
			(store as any).hasRequiredSchema({
				fields: REQUIRED_COLUMNS.filter((name) => name !== "vector").map(
					(name) => ({
						name,
					}),
				),
			}),
		).toBe(false);
		expect((store as any).hasRequiredSchema(undefined)).toBe(false);
	});
});

describe("LanceDbVectorStore public methods", () => {
	it("applies constructor defaults and custom options", () => {
		const defaults = createStore();
		const custom = createStore({
			dbPath: "/tmp/custom-db",
			vectorSize: 8,
			tableName: "custom_vectors",
			cacheTTL: 1234,
		});

		expect((defaults as any).dbPath).toBe("/tmp/fake-lancedb");
		expect((defaults as any).vectorSize).toBe(3);
		expect((defaults as any).tableName).toBe("vectors");
		expect((defaults as any).cacheTTL).toBe(5 * 60 * 1000);
		expect((custom as any).dbPath).toBe("/tmp/custom-db");
		expect((custom as any).vectorSize).toBe(8);
		expect((custom as any).tableName).toBe("custom_vectors");
		expect((custom as any).cacheTTL).toBe(1234);
	});

	it("initialize creates a table when it does not exist", async () => {
		const table = createMockTable();
		const db = createMockDb({ tableNames: [], table });
		connectMock.mockResolvedValue(db);
		const store = createStore();

		await store.initialize();

		expect(connectMock).toHaveBeenCalledWith("/tmp/fake-lancedb");
		expect(db.tableNames).toHaveBeenCalledTimes(1);
		expect(db.createTable).toHaveBeenCalledWith("vectors", [
			{
				project_id: "",
				chunk_id: "",
				snapshot_id: "",
				file_path: "",
				start_line: 0,
				end_line: 0,
				content_hash: "",
				chunk_type: "",
				primary_symbol: "",
				vector: [0, 0, 0],
			},
		]);
		expect((store as any).initialized).toBe(true);
		expect((store as any).table).toBe(table);
	});

	it("initialize opens an existing valid table only once", async () => {
		const table = createMockTable();
		const db = createMockDb({ tableNames: ["custom_vectors"], table });
		connectMock.mockResolvedValue(db);
		const store = createStore({ tableName: "custom_vectors" });

		await store.initialize();
		await store.initialize();

		expect(db.openTable).toHaveBeenCalledWith("custom_vectors");
		expect(db.createTable).not.toHaveBeenCalled();
		expect(connectMock).toHaveBeenCalledTimes(1);
	});

	it("initialize recreates a table when the schema is missing required columns", async () => {
		const table = createMockTable({
			getSchema: vi.fn().mockResolvedValue({
				fields: REQUIRED_COLUMNS.filter((name) => name !== "vector").map(
					(name) => ({
						name,
					}),
				),
			}),
		});
		const replacementTable = createMockTable();
		const db = createMockDb({
			tableNames: ["vectors"],
			table,
			overrides: {
				createTable: vi.fn().mockResolvedValue(replacementTable),
			},
		});
		connectMock.mockResolvedValue(db);
		const store = createStore();

		await store.initialize();

		expect(db.dropTable).toHaveBeenCalledWith("vectors");
		expect(db.createTable).toHaveBeenCalledTimes(1);
		expect((store as any).table).toBe(replacementTable);
	});

	it("initialize surfaces connection errors", async () => {
		const error = new Error("connection failed");
		connectMock.mockRejectedValue(error);

		await expect(createStore().initialize()).rejects.toThrow(
			"connection failed",
		);
	});

	it("close resets the internal connection state", async () => {
		const store = createStore();
		(store as any).initialized = true;
		(store as any).db = { openTable: vi.fn() };
		(store as any).table = { add: vi.fn() };

		await store.close();

		expect((store as any).initialized).toBe(false);
		expect((store as any).db).toBeNull();
		expect((store as any).table).toBeNull();
	});

	it("upsert skips empty batches without initializing", async () => {
		const store = createStore();

		await store.upsert([]);

		expect(connectMock).not.toHaveBeenCalled();
		expect((store as any).initialized).toBe(false);
	});

	it("upsert initializes lazily, batches records, and normalizes payloads", async () => {
		const table = createMockTable();
		const db = createMockDb({ tableNames: [], table });
		connectMock.mockResolvedValue(db);
		const store = createStore();
		const vectors = Array.from({ length: 201 }, (_, index) =>
			createVectorRecord(index),
		);

		await store.upsert(vectors);

		expect(table.add).toHaveBeenCalledTimes(2);
		expect(table.add).toHaveBeenNthCalledWith(
			1,
			expect.arrayContaining([
				expect.objectContaining({
					project_id: "project-1",
					chunk_id: "chunk-0",
					snapshot_id: "snap-1",
					file_path: "src/file-0.ts",
					start_line: 0,
					end_line: 1,
					content_hash: "hash-0",
					chunk_type: "impl",
					primary_symbol: "symbol0",
					vector: [0, 1, 2],
				}),
				expect.objectContaining({
					chunk_id: "chunk-1",
					chunk_type: "",
					primary_symbol: "",
					vector: [1, 2, 3],
				}),
			]),
		);
		expect((table.add as any).mock.calls[1][0]).toHaveLength(1);
	});

	it("upsert retries once after a transient IO error", async () => {
		const transientError = new Error(
			"LanceError(IO): Not found: /tmp/fake-lancedb/vectors.lance/data/file",
		);
		const firstTable = createMockTable({
			add: vi.fn().mockRejectedValueOnce(transientError),
		});
		const secondTable = createMockTable();
		const firstDb = createMockDb({ tableNames: [], table: firstTable });
		const secondDb = createMockDb({ tableNames: [], table: secondTable });
		connectMock.mockResolvedValueOnce(firstDb).mockResolvedValueOnce(secondDb);
		const store = createStore();

		await store.upsert([createVectorRecord(1)]);

		expect(connectMock).toHaveBeenCalledTimes(2);
		expect(firstTable.add).toHaveBeenCalledTimes(1);
		expect(secondTable.add).toHaveBeenCalledTimes(1);
		await expect(
			(store as any).withTransientIoRetry("test", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});

	it("search requires a projectId filter", async () => {
		await expect(createStore().search([1, 2, 3], 5, {} as any)).rejects.toThrow(
			"projectId is required in filters for search",
		);
	});

	it("search uses the exhaustive query path with prefilters and maps sorted results", async () => {
		const rows = [
			{
				chunk_id: "chunk-far",
				snapshot_id: "snap-1",
				file_path: "src/far.ts",
				start_line: 20,
				end_line: 30,
				content_hash: "hash-far",
				chunk_type: "types",
				primary_symbol: "Far",
				vector: [5, 5, 5],
			},
			{
				chunk_id: "chunk-near",
				snapshot_id: "snap-1",
				file_path: "src/near.ts",
				start_line: 1,
				end_line: 2,
				content_hash: "hash-near",
				chunk_type: "impl",
				primary_symbol: "Near",
				vector: [1, 1, 1],
			},
		];
		const queryChain = createQueryChain(rows);
		const table = createMockTable({
			query: vi.fn(() => queryChain),
		});
		const db = createMockDb({ tableNames: ["vectors"], table });
		connectMock.mockResolvedValue(db);
		const store = createStore();

		const results = await store.search([0, 0, 0], 1, {
			projectId: "project-1",
			snapshotId: "snap-1",
			pathPrefix: "src",
			chunkTypes: ["impl", "types"],
		});

		expect(queryChain.where).toHaveBeenCalledWith(
			"snapshot_id = 'snap-1' AND file_path LIKE 'src%' AND chunk_type IN ('impl', 'types')",
		);
		expect(results).toEqual([
			{
				chunkId: "chunk-near",
				snapshotId: "snap-1",
				filePath: "src/near.ts",
				startLine: 1,
				endLine: 2,
				contentHash: "hash-near",
				chunkType: "impl",
				primarySymbol: "Near",
				score: 1 / (1 + Math.sqrt(3)),
				distance: Math.sqrt(3),
			},
		]);
	});

	it("search falls back to table.search and reopens the table when cache TTL expires immediately", async () => {
		const searchChain = createSearchChain([
			{
				chunk_id: "chunk-1",
				snapshot_id: "snap-1",
				file_path: "src/exact.ts",
				start_line: 3,
				end_line: 4,
				content_hash: "hash-1",
				chunk_type: null,
				primary_symbol: null,
				_distance: 0.25,
			},
		]);
		const table = createMockTable({
			search: vi.fn(() => searchChain),
		});
		const db = createMockDb({ tableNames: ["vectors"], table });
		connectMock.mockResolvedValue(db);
		const store = createStore({ cacheTTL: 0 });

		const results = await store.search([1, 2, 3], 2, {
			projectId: "project-1",
			filePath: "src/exact.ts",
		});

		expect(db.openTable).toHaveBeenCalledTimes(2);
		expect(searchChain.where).toHaveBeenCalledWith(
			"file_path = 'src/exact.ts'",
		);
		expect(results).toEqual([
			{
				chunkId: "chunk-1",
				snapshotId: "snap-1",
				filePath: "src/exact.ts",
				startLine: 3,
				endLine: 4,
				contentHash: "hash-1",
				chunkType: undefined,
				primarySymbol: undefined,
				score: 0.8,
				distance: 0.25,
			},
		]);
	});

	it("countVectors uses countRows when available", async () => {
		const table = createMockTable({
			countRows: vi.fn().mockResolvedValue(7),
		});
		const db = createMockDb({ tableNames: ["vectors"], table });
		connectMock.mockResolvedValue(db);

		await expect(
			createStore().countVectors({
				projectId: "project-1",
				snapshotId: "snap-1",
			}),
		).resolves.toBe(7);
		expect(table.countRows).toHaveBeenCalledWith("snapshot_id = 'snap-1'");
	});

	it("countVectors falls back to filter-based counting", async () => {
		const filterChain = createFilterChain([
			{ chunk_id: "a" },
			{ chunk_id: "b" },
		]);
		const table = createMockTable({
			filter: vi.fn(() => filterChain),
		});
		const db = createMockDb({ tableNames: ["vectors"], table });
		connectMock.mockResolvedValue(db);

		await expect(
			createStore().countVectors({
				projectId: "project-1",
				pathPrefix: "src/",
			}),
		).resolves.toBe(2);
		expect(table.filter).toHaveBeenCalledWith("file_path LIKE 'src/%'");
	});

	it("countVectors falls back to query-based counting", async () => {
		const queryChain = createQueryChain([
			{ chunk_id: "a" },
			{ chunk_id: "b" },
			{ chunk_id: "c" },
		]);
		const table = createMockTable({
			query: vi.fn(() => queryChain),
		});
		const db = createMockDb({ tableNames: ["vectors"], table });
		connectMock.mockResolvedValue(db);

		await expect(
			createStore().countVectors({ projectId: "project-1" }),
		).resolves.toBe(3);
		expect(queryChain.where).not.toHaveBeenCalled();
	});

	it("countVectors validates filters and throws when exhaustive APIs are unavailable", async () => {
		const store = createStore();
		await expect(store.countVectors({} as any)).rejects.toThrow(
			"projectId is required in filters for countVectors",
		);

		const table = createMockTable();
		const db = createMockDb({ tableNames: ["vectors"], table });
		connectMock.mockResolvedValue(db);

		await expect(
			store.countVectors({ projectId: "project-1" }),
		).rejects.toThrow(
			"countVectors requires countRows(), filter(), or query() support",
		);
	});

	it("deleteBySnapshot initializes lazily and escapes snapshot IDs", async () => {
		const table = createMockTable();
		const db = createMockDb({ tableNames: ["vectors"], table });
		connectMock.mockResolvedValue(db);

		await createStore().deleteBySnapshot("project-1" as any, "snap-'1" as any);

		expect(table.delete).toHaveBeenCalledWith("snapshot_id = 'snap-''1'");
	});

	it("copyVectors copies filtered rows and rewrites snapshot IDs", async () => {
		const queryChain = createQueryChain([
			{
				project_id: undefined,
				chunk_id: "chunk-1",
				snapshot_id: "snap-old",
				file_path: "src/keep.ts",
				start_line: 1,
				end_line: 2,
				content_hash: "hash-1",
				chunk_type: "impl",
				primary_symbol: "Keep",
				vector: [1, 2, 3],
			},
			{
				project_id: "project-1",
				chunk_id: "chunk-2",
				snapshot_id: "snap-old",
				file_path: "src/skip.ts",
				start_line: 3,
				end_line: 4,
				content_hash: "hash-2",
				chunk_type: "types",
				primary_symbol: "Skip",
				vector: [4, 5, 6],
			},
		]);
		const table = createMockTable({
			query: vi.fn(() => queryChain),
		});
		const db = createMockDb({ tableNames: ["vectors"], table });
		connectMock.mockResolvedValue(db);

		await createStore().copyVectors(
			"project-1" as any,
			"snap-old" as any,
			"snap-new" as any,
			["src/skip.ts"],
		);

		expect(queryChain.where).toHaveBeenCalledWith("snapshot_id = 'snap-old'");
		expect(table.add).toHaveBeenCalledWith([
			{
				project_id: "project-1",
				chunk_id: "chunk-1",
				snapshot_id: "snap-new",
				file_path: "src/keep.ts",
				start_line: 1,
				end_line: 2,
				content_hash: "hash-1",
				chunk_type: "impl",
				primary_symbol: "Keep",
				vector: [1, 2, 3],
			},
		]);
	});

	it("copyVectors falls back to vector search and skips add when nothing remains", async () => {
		const searchChain = createSearchChain([
			{
				chunk_id: "chunk-1",
				file_path: "src/skip.ts",
				start_line: 1,
				end_line: 2,
				content_hash: "hash-1",
				chunk_type: "impl",
				primary_symbol: "Skip",
				vector: [1, 2, 3],
			},
		]);
		const table = createMockTable({
			search: vi.fn(() => searchChain),
		});
		const db = createMockDb({ tableNames: ["vectors"], table });
		connectMock.mockResolvedValue(db);

		await createStore().copyVectors(
			"project-1" as any,
			"snap-old" as any,
			"snap-new" as any,
			["src/skip.ts"],
		);

		expect(table.search).toHaveBeenCalledWith([0, 0, 0]);
		expect(table.add).not.toHaveBeenCalled();
	});

	it("deleteByProject closes the store and removes the database directory when present", async () => {
		existsSyncMock.mockReturnValue(true);
		const store = createStore();
		(store as any).initialized = true;
		(store as any).db = { openTable: vi.fn() };
		(store as any).table = { add: vi.fn() };

		await store.deleteByProject("project-1" as any);

		expect((store as any).initialized).toBe(false);
		expect((store as any).db).toBeNull();
		expect((store as any).table).toBeNull();
		expect(existsSyncMock).toHaveBeenCalledWith("/tmp/fake-lancedb");
		expect(rmSyncMock).toHaveBeenCalledWith("/tmp/fake-lancedb", {
			recursive: true,
			force: true,
		});
	});

	it("deleteByProject skips deletion when the directory does not exist", async () => {
		existsSyncMock.mockReturnValue(false);

		await createStore().deleteByProject("project-1" as any);

		expect(rmSyncMock).not.toHaveBeenCalled();
	});
});
