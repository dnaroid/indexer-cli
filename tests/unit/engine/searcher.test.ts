import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	EmbeddingProvider,
	MetadataStore,
	VectorSearchResult,
	VectorStore,
} from "../../../src/core/types.js";

const { readFileMock } = vi.hoisted(() => ({
	readFileMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
	readFile: readFileMock,
}));

import { SearchEngine } from "../../../src/engine/searcher.js";

function createMetadataStoreMock(): MetadataStore {
	return {
		initialize: vi.fn(),
		close: vi.fn(),
		transaction: vi.fn(),
		createSnapshot: vi.fn(),
		getSnapshot: vi.fn(),
		getLatestSnapshot: vi.fn(),
		getLatestCompletedSnapshot: vi.fn(),
		listSnapshots: vi.fn(),
		updateSnapshotStatus: vi.fn(),
		updateSnapshotProgress: vi.fn(),
		upsertFile: vi.fn(),
		listFiles: vi.fn(),
		getFile: vi.fn(),
		replaceChunks: vi.fn(),
		listChunks: vi.fn(),
		replaceSymbols: vi.fn(),
		listSymbols: vi.fn(),
		searchSymbols: vi.fn(),
		replaceDependencies: vi.fn(),
		listDependencies: vi.fn(),
		getDependents: vi.fn(),
		upsertFileMetrics: vi.fn(),
		getFileMetrics: vi.fn(),
		listFileMetrics: vi.fn(),
		upsertArtifact: vi.fn(),
		getArtifact: vi.fn(),
		listArtifacts: vi.fn(),
		copyUnchangedFileData: vi.fn(),
		clearProjectMetadata: vi.fn(),
		upsertFileEnrichment: vi.fn(),
		getFileEnrichment: vi.fn(),
		listFileEnrichments: vi.fn(),
		upsertSymbolEnrichment: vi.fn(),
		getSymbolEnrichment: vi.fn(),
		listSymbolEnrichments: vi.fn(),
	};
}

function createVectorStoreMock(results: VectorSearchResult[]): VectorStore {
	return {
		initialize: vi.fn(),
		close: vi.fn(),
		upsert: vi.fn(),
		search: vi.fn().mockResolvedValue(results),
		countVectors: vi.fn(),
		deleteBySnapshot: vi.fn(),
		copyVectors: vi.fn(),
		deleteByProject: vi.fn(),
	};
}

function createEmbedderMock(embeddings: number[][]): EmbeddingProvider {
	return {
		id: "mock-embedder",
		initialize: vi.fn(),
		close: vi.fn(),
		getDimension: vi.fn().mockReturnValue(3),
		embed: vi.fn().mockResolvedValue(embeddings),
	};
}

describe("SearchEngine", () => {
	beforeEach(() => {
		readFileMock.mockReset();
	});

	it("embeds the query, forwards vector filters, and returns sliced file content", async () => {
		readFileMock.mockResolvedValue("line 1\nline 2\nline 3\nline 4");
		const metadata = createMetadataStoreMock();
		const vectors = createVectorStoreMock([
			{
				chunkId: "chunk-1",
				snapshotId: "snap-1",
				filePath: "src/app.ts",
				startLine: 2,
				endLine: 3,
				contentHash: "hash",
				score: 0.95,
				chunkType: "impl",
				primarySymbol: "run",
			},
		]);
		const embedder = createEmbedderMock([[0.1, 0.2, 0.3]]);
		const engine = new SearchEngine(metadata, vectors, embedder, "/repo");

		const results = await engine.search("project-1", "snap-1", "find app", {
			topK: 5,
			pathPrefix: "src",
			chunkTypes: ["impl", "types"],
			filePath: "src/app.ts",
		});

		expect(embedder.embed).toHaveBeenCalledWith(["find app"]);
		expect(vectors.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], 5, {
			projectId: "project-1",
			snapshotId: "snap-1",
			filePath: "src/app.ts",
			pathPrefix: "src",
			chunkTypes: ["impl", "types"],
		});
		expect(readFileMock).toHaveBeenCalledWith("/repo/src/app.ts", "utf-8");
		expect(results).toEqual([
			{
				filePath: "src/app.ts",
				startLine: 2,
				endLine: 3,
				score: 0.95,
				chunkType: "impl",
				primarySymbol: "run",
				content: "line 2\nline 3",
			},
		]);
	});

	it("uses the default topK and tolerates file read failures", async () => {
		readFileMock.mockRejectedValue(new Error("missing"));
		const metadata = createMetadataStoreMock();
		const vectors = createVectorStoreMock([
			{
				chunkId: "chunk-2",
				snapshotId: "snap-1",
				filePath: "src/missing.ts",
				startLine: 1,
				endLine: 2,
				contentHash: "hash-2",
				score: 0.5,
			},
		]);
		const embedder = createEmbedderMock([[1, 2, 3]]);
		const engine = new SearchEngine(metadata, vectors, embedder, "/repo");

		const results = await engine.search("project-1", "snap-1", "missing file");

		expect(vectors.search).toHaveBeenCalledWith([1, 2, 3], 10, {
			projectId: "project-1",
			snapshotId: "snap-1",
			filePath: undefined,
			pathPrefix: undefined,
			chunkTypes: undefined,
		});
		expect(results).toEqual([
			{
				filePath: "src/missing.ts",
				startLine: 1,
				endLine: 2,
				score: 0.5,
				chunkType: undefined,
				primarySymbol: undefined,
				content: "",
			},
		]);
	});

	it("skips file reads when content is not requested", async () => {
		const metadata = createMetadataStoreMock();
		const vectors = createVectorStoreMock([
			{
				chunkId: "chunk-3",
				snapshotId: "snap-1",
				filePath: "src/app.ts",
				startLine: 4,
				endLine: 6,
				contentHash: "hash-3",
				score: 0.9,
			},
		]);
		const embedder = createEmbedderMock([[4, 5, 6]]);
		const engine = new SearchEngine(metadata, vectors, embedder, "/repo");

		const results = await engine.search("project-1", "snap-1", "compact", {
			includeContent: false,
		});

		expect(readFileMock).not.toHaveBeenCalled();
		expect(results).toEqual([
			{
				filePath: "src/app.ts",
				startLine: 4,
				endLine: 6,
				score: 0.9,
				chunkType: undefined,
				primarySymbol: undefined,
			},
		]);
	});

	it("filters out results below minScore before reading content", async () => {
		readFileMock.mockResolvedValue("line 1\nline 2");
		const metadata = createMetadataStoreMock();
		const vectors = createVectorStoreMock([
			{
				chunkId: "chunk-low",
				snapshotId: "snap-1",
				filePath: "src/low.ts",
				startLine: 1,
				endLine: 1,
				contentHash: "hash-low",
				score: 0.3,
			},
			{
				chunkId: "chunk-high",
				snapshotId: "snap-1",
				filePath: "src/high.ts",
				startLine: 2,
				endLine: 2,
				contentHash: "hash-high",
				score: 0.8,
			},
		]);
		const embedder = createEmbedderMock([[7, 8, 9]]);
		const engine = new SearchEngine(metadata, vectors, embedder, "/repo");

		const results = await engine.search("project-1", "snap-1", "threshold", {
			minScore: 0.5,
		});

		expect(readFileMock).toHaveBeenCalledTimes(1);
		expect(readFileMock).toHaveBeenCalledWith("/repo/src/high.ts", "utf-8");
		expect(results).toEqual([
			{
				filePath: "src/high.ts",
				startLine: 2,
				endLine: 2,
				score: 0.8,
				chunkType: undefined,
				primarySymbol: undefined,
				content: "line 2",
			},
		]);
	});

	it("throws when embedding generation returns no query vector", async () => {
		const metadata = createMetadataStoreMock();
		const vectors = createVectorStoreMock([]);
		const embedder = createEmbedderMock([]);
		const engine = new SearchEngine(metadata, vectors, embedder, "/repo");

		await expect(
			engine.search("project-1", "snap-1", "no embedding"),
		).rejects.toThrow("Failed to generate query embedding");
		expect(vectors.search).not.toHaveBeenCalled();
	});
});
