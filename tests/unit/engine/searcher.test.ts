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
		listSymbols: vi.fn().mockResolvedValue([]),
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

	it("prefers the most query-relevant overlapping symbol at search time", async () => {
		readFileMock.mockResolvedValue(
			[
				"class AuthController {",
				"  loginAsUser() {",
				"    return this.loginService.loginAsUser();",
				"  }",
				"",
				"  federateCallback() {",
				"    return this.authService.handleMagicLinkLogin();",
				"  }",
				"}",
			].join("\n"),
		);
		const metadata = createMetadataStoreMock();
		vi.mocked(metadata.listSymbols).mockResolvedValue([
			{
				snapshotId: "snap-1",
				id: "sym-1",
				filePath: "src/auth.controller.ts",
				kind: "method",
				name: "loginAsUser",
				exported: false,
				range: {
					start: { line: 2, character: 0 },
					end: { line: 4, character: 1 },
				},
			},
			{
				snapshotId: "snap-1",
				id: "sym-2",
				filePath: "src/auth.controller.ts",
				kind: "method",
				name: "federateCallback",
				exported: false,
				range: {
					start: { line: 6, character: 0 },
					end: { line: 8, character: 1 },
				},
			},
		]);
		const vectors = createVectorStoreMock([
			{
				chunkId: "chunk-4",
				snapshotId: "snap-1",
				filePath: "src/auth.controller.ts",
				startLine: 2,
				endLine: 8,
				contentHash: "hash-4",
				score: 0.93,
				chunkType: "impl",
				primarySymbol: "loginAsUser",
			},
		]);
		const embedder = createEmbedderMock([[0.4, 0.5, 0.6]]);
		const engine = new SearchEngine(metadata, vectors, embedder, "/repo");

		const results = await engine.search(
			"project-1",
			"snap-1",
			"magic link login",
			{ includeContent: false },
		);

		expect(results[0]?.primarySymbol).toBe("federateCallback");
		expect(readFileMock).toHaveBeenCalledWith(
			"/repo/src/auth.controller.ts",
			"utf-8",
		);
	});

	it("falls back to the indexed primary symbol when overlap scoring finds no match", async () => {
		readFileMock.mockResolvedValue(
			"export function runTask() {}\nexport function syncTask() {}",
		);
		const metadata = createMetadataStoreMock();
		vi.mocked(metadata.listSymbols).mockResolvedValue([
			{
				snapshotId: "snap-1",
				id: "sym-1",
				filePath: "src/app.ts",
				kind: "function",
				name: "runTask",
				exported: true,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 1, character: 28 },
				},
			},
			{
				snapshotId: "snap-1",
				id: "sym-2",
				filePath: "src/app.ts",
				kind: "function",
				name: "syncTask",
				exported: true,
				range: {
					start: { line: 2, character: 0 },
					end: { line: 2, character: 29 },
				},
			},
		]);
		const vectors = createVectorStoreMock([
			{
				chunkId: "chunk-5",
				snapshotId: "snap-1",
				filePath: "src/app.ts",
				startLine: 1,
				endLine: 2,
				contentHash: "hash-5",
				score: 0.88,
				chunkType: "impl",
				primarySymbol: "runTask",
			},
		]);
		const embedder = createEmbedderMock([[0.9, 0.1, 0.2]]);
		const engine = new SearchEngine(metadata, vectors, embedder, "/repo");

		const results = await engine.search("project-1", "snap-1", "payments");

		expect(results[0]?.primarySymbol).toBe("runTask");
	});

	it("filters out results below minScore after applying chunk-type penalties", async () => {
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

		expect(readFileMock).toHaveBeenCalledTimes(2);
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

	it("filters out language keywords from vector-result primarySymbol fallback", async () => {
		const metadata = createMetadataStoreMock();
		const vectors = createVectorStoreMock([
			{
				chunkId: "chunk-keyword",
				snapshotId: "snap-1",
				filePath: "src/quiz-helper.ts",
				startLine: 443,
				endLine: 524,
				contentHash: "hash-kw",
				score: 0.9,
				chunkType: "impl",
				primarySymbol: "if",
			},
		]);
		const embedder = createEmbedderMock([[1, 2, 3]]);
		const engine = new SearchEngine(metadata, vectors, embedder, "/repo");

		const results = await engine.search(
			"project-1",
			"snap-1",
			"save progress",
			{
				includeContent: false,
			},
		);

		expect(results).toHaveLength(1);
		expect(results[0]?.primarySymbol).toBeUndefined();
	});

	it("returns enclosing named function when keyword exists inside it", async () => {
		readFileMock.mockResolvedValue(
			[
				"function saveProgress(email: string) {",
				"  if (email) {",
				"    sendEmail(email);",
				"  }",
				"}",
			].join("\n"),
		);
		const metadata = createMetadataStoreMock();
		vi.mocked(metadata.listSymbols).mockResolvedValue([
			{
				snapshotId: "snap-1",
				id: "sym-save",
				filePath: "src/quiz-helper.ts",
				kind: "function",
				name: "saveProgress",
				exported: false,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 5, character: 1 },
				},
			},
		]);
		const vectors = createVectorStoreMock([
			{
				chunkId: "chunk-enclosing",
				snapshotId: "snap-1",
				filePath: "src/quiz-helper.ts",
				startLine: 1,
				endLine: 5,
				contentHash: "hash-enc",
				score: 0.92,
				chunkType: "impl",
				primarySymbol: "if",
			},
		]);
		const embedder = createEmbedderMock([[0.5, 0.6, 0.7]]);
		const engine = new SearchEngine(metadata, vectors, embedder, "/repo");

		const results = await engine.search(
			"project-1",
			"snap-1",
			"save progress email send",
		);

		expect(results).toHaveLength(1);
		expect(results[0]?.primarySymbol).toBe("saveProgress");
	});
});
