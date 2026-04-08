import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import {
	DEFAULT_LANGUAGE_PLUGIN_IDS,
	IndexerEngine,
	createDefaultLanguagePlugins,
} from "../../../src/engine/indexer.js";
import { config } from "../../../src/core/config.js";
import type {
	ChunkRecord,
	DependencyRecord,
	FileRecord,
	SymbolRecord,
} from "../../../src/core/types.js";

async function loadInternalFunction<T>(
	filePath: string,
	matcher: RegExp,
	exportName: string,
): Promise<T> {
	const source = readFileSync(filePath, "utf8");
	const match = source.match(matcher);
	if (!match) {
		throw new Error(`Unable to load internal function: ${exportName}`);
	}

	const transpiled = ts.transpileModule(
		`${match[0]}\nexport { ${exportName} };`,
		{
			compilerOptions: {
				module: ts.ModuleKind.ES2022,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText;

	const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
	const loaded = (await import(moduleUrl)) as Record<string, T>;
	return loaded[exportName];
}

function createMockOptions(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "project-id",
		repoRoot: "/repo",
		metadata: {
			initialize: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			transaction: vi.fn(async (callback: () => Promise<unknown>) =>
				callback(),
			),
			createSnapshot: vi.fn().mockResolvedValue({ id: "snapshot-1" }),
			getSnapshot: vi.fn().mockResolvedValue(null),
			getLatestSnapshot: vi.fn().mockResolvedValue(null),
			getLatestCompletedSnapshot: vi.fn().mockResolvedValue(null),
			listSnapshots: vi.fn().mockResolvedValue([]),
			updateSnapshotStatus: vi.fn().mockResolvedValue(undefined),
			updateSnapshotProgress: vi.fn().mockResolvedValue(undefined),
			upsertFile: vi.fn().mockResolvedValue(undefined),
			listFiles: vi.fn().mockResolvedValue([]),
			getFile: vi.fn().mockResolvedValue(null),
			replaceChunks: vi.fn().mockResolvedValue(undefined),
			listChunks: vi.fn().mockResolvedValue([]),
			replaceSymbols: vi.fn().mockResolvedValue(undefined),
			listSymbols: vi.fn().mockResolvedValue([]),
			searchSymbols: vi.fn().mockResolvedValue([]),
			replaceDependencies: vi.fn().mockResolvedValue(undefined),
			listDependencies: vi.fn().mockResolvedValue([]),
			getDependents: vi.fn().mockResolvedValue([]),
			upsertFileMetrics: vi.fn().mockResolvedValue(undefined),
			getFileMetrics: vi.fn().mockResolvedValue(null),
			listFileMetrics: vi.fn().mockResolvedValue([]),
			upsertArtifact: vi.fn().mockResolvedValue(undefined),
			getArtifact: vi.fn().mockResolvedValue(null),
			listArtifacts: vi.fn().mockResolvedValue([]),
			copyUnchangedFileData: vi.fn().mockResolvedValue(undefined),
			clearProjectMetadata: vi.fn().mockResolvedValue(undefined),
		} as any,
		vectors: {
			initialize: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			upsert: vi.fn().mockResolvedValue(undefined),
			search: vi.fn().mockResolvedValue([]),
			countVectors: vi.fn().mockResolvedValue(0),
			deleteBySnapshot: vi.fn().mockResolvedValue(undefined),
			copyVectors: vi.fn().mockResolvedValue(undefined),
			deleteByProject: vi.fn().mockResolvedValue(undefined),
		} as any,
		embedder: {
			id: "mock-embedder",
			initialize: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			getDimension: vi.fn().mockReturnValue(3),
			embed: vi.fn().mockResolvedValue([]),
		} as any,
		git: {
			getHeadCommit: vi.fn().mockResolvedValue("head-commit"),
			getChangedFiles: vi.fn().mockResolvedValue({
				added: [],
				modified: [],
				deleted: [],
			}),
			getChurnByFile: vi.fn().mockResolvedValue({}),
			isDirty: vi.fn().mockResolvedValue(false),
		} as any,
		...overrides,
	};
}

function createMockLanguagePlugin(overrides: Record<string, unknown> = {}) {
	return {
		id: "typescript",
		fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"],
		parse: vi.fn(({ content }: { content: string }) => ({
			languageId: "typescript",
			content,
		})),
		extractSymbols: vi.fn(() => [
			{
				id: "symbol-1",
				kind: "function",
				name: "runTask",
				containerName: undefined,
				exported: true,
				range: {
					startLine: 2,
					startCol: 0,
					endLine: 3,
					endCol: 1,
				},
				signature: "function runTask(): void",
				docComment: "Runs the task",
				metadata: { role: "test" },
			},
		]),
		extractImports: vi.fn(() => [
			{ id: "dep-1", spec: "./dep", kind: "require" },
			{ id: "dep-2", spec: "pkg", kind: "dynamic_import" },
		]),
		splitIntoChunks: vi.fn(() => [
			{
				content: "import { dep } from './dep';",
				range: { startLine: 1, endLine: 1 },
				metadata: { chunkType: "imports" },
			},
			{
				content: "export function runTask() {}",
				range: { startLine: 2, endLine: 2 },
				metadata: { chunkType: "unknown", primarySymbol: "runTask" },
			},
		]),
		...overrides,
	} as any;
}

function setPrivateField(target: object, key: string, value: unknown) {
	Object.defineProperty(target, key, {
		value,
		configurable: true,
		writable: true,
	});
}

function createPreparedFileData(
	filePath: string,
	overrides: Partial<{
		languageId: string;
		chunkRecords: ChunkRecord[];
		chunksContent: Map<string, string>;
		symbolRecords: SymbolRecord[];
		dependencyRecords: DependencyRecord[];
		metrics: {
			complexity: number;
			maintainability: number;
			churn: number;
			testCoverage?: number;
		};
	}> = {},
) {
	const chunkRecords =
		overrides.chunkRecords ??
		([
			{
				snapshotId: "snapshot-1",
				chunkId: `${filePath}-chunk-1`,
				filePath,
				startLine: 1,
				endLine: 3,
				contentHash: `${filePath}-hash-1`,
				tokenEstimate: 10,
				chunkType: "impl",
				primarySymbol: "runTask",
				hasOverlap: false,
			},
		] satisfies ChunkRecord[]);

	const chunksContent =
		overrides.chunksContent ??
		new Map(
			chunkRecords.map((chunk) => [chunk.chunkId, `${filePath} content`]),
		);

	return {
		filePath,
		content: `${filePath} source`,
		fileRecord: {
			snapshotId: "snapshot-1",
			path: filePath,
			sha256: `${filePath}-sha`,
			mtimeMs: 123,
			size: 42,
			languageId: overrides.languageId ?? "typescript",
		} satisfies FileRecord,
		chunkRecords,
		chunksContent,
		symbolRecords: overrides.symbolRecords ?? [],
		dependencyRecords: overrides.dependencyRecords ?? [],
		metrics: overrides.metrics ?? {
			complexity: 0,
			maintainability: 100,
			churn: 0,
			testCoverage: undefined,
		},
	};
}

function mockConfig(values: Partial<Record<string, unknown>> = {}) {
	const defaults: Record<string, unknown> = {
		embeddingProvider: "mock",
		embeddingModel: "test-model",
		embeddingContextSize: 8192,
		vectorSize: 3,
		ollamaBaseUrl: "http://127.0.0.1:11434",
		ollamaNumCtx: 512,
		indexConcurrency: 5,
		indexBatchSize: 8,
		logLevel: "error",
		...values,
	};

	return vi
		.spyOn(config, "get")
		.mockImplementation((key: keyof typeof defaults) => defaults[key] as never);
}

const indexerPath =
	"/Volumes/128GBSSD/Projects/indexer-cli/src/engine/indexer.ts";
const normalizeImportKind = await loadInternalFunction<
	(kind: string) => "import" | "require" | "dynamic_import"
>(
	indexerPath,
	/function normalizeImportKind\([\s\S]*?\n}\n/,
	"normalizeImportKind",
);

let tempDirs: string[] = [];

beforeEach(() => {
	tempDirs = [];
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempRepo() {
	const dir = mkdtempSync(join(tmpdir(), "indexer-engine-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("IndexerEngine internals", () => {
	describe("normalizeImportKind", () => {
		it("normalizes supported kinds and falls back to import", () => {
			expect(normalizeImportKind("require")).toBe("require");
			expect(normalizeImportKind("dynamic_import")).toBe("dynamic_import");
			expect(normalizeImportKind("import")).toBe("import");
			expect(normalizeImportKind("unknown")).toBe("import");
		});
	});

	describe("createDefaultLanguagePlugins", () => {
		it("creates all default plugins when no ids are provided", () => {
			const plugins = createDefaultLanguagePlugins();

			expect(plugins).toHaveLength(4);
			expect(plugins.map((plugin) => plugin.id)).toEqual([
				...DEFAULT_LANGUAGE_PLUGIN_IDS,
			]);
		});

		it("creates only the requested built-in plugins", () => {
			const plugins = createDefaultLanguagePlugins(["python", "gdscript"]);

			expect(plugins.map((plugin) => plugin.id)).toEqual([
				"python",
				"gdscript",
			]);
		});

		it("uses defaults when given an empty array", () => {
			const plugins = createDefaultLanguagePlugins([]);

			expect(plugins.map((plugin) => plugin.id)).toEqual([
				...DEFAULT_LANGUAGE_PLUGIN_IDS,
			]);
		});

		it("throws for unknown plugin ids", () => {
			expect(() => createDefaultLanguagePlugins(["ruby"])).toThrow(
				"Unsupported language plugin id: ruby",
			);
		});
	});

	describe("constructor", () => {
		it("registers default plugins when custom plugins are not provided", () => {
			const engine = new IndexerEngine(createMockOptions());

			expect(
				(engine as any).languagePluginRegistry
					.list()
					.map((plugin: any) => plugin.id),
			).toEqual([...DEFAULT_LANGUAGE_PLUGIN_IDS]);
			expect((engine as any).indexingOptions.codeExtensions).toEqual([
				".ts",
				".tsx",
				".mts",
				".cts",
				".js",
				".jsx",
				".py",
				".pyi",
				".cs",
				".gd",
			]);
		});

		it("uses custom plugins when provided", () => {
			const engine = new IndexerEngine(
				createMockOptions({
					languagePlugins: createDefaultLanguagePlugins(["python"]),
				}),
			);

			expect(
				(engine as any).languagePluginRegistry
					.list()
					.map((plugin: any) => plugin.id),
			).toEqual(["python"]);
			expect((engine as any).indexingOptions.codeExtensions).toEqual([
				".py",
				".pyi",
			]);
		});

		it("normalizes custom indexing options", () => {
			const engine = new IndexerEngine(
				createMockOptions({
					indexingOptions: {
						codeExtensions: [".TS", ".Py"],
						skipImportChunksInVectors: true,
					},
					languagePlugins: [createMockLanguagePlugin()],
				}),
			);

			expect((engine as any).indexingOptions).toEqual({
				codeExtensions: [".ts", ".py"],
				skipImportChunksInVectors: true,
			});
		});
	});

	describe("getLanguageIdFromPath", () => {
		const engine = new IndexerEngine(createMockOptions());

		it.each([
			["file.ts", "typescript"],
			["file.tsx", "typescript"],
			["file.mts", "typescript"],
			["file.cts", "typescript"],
			["file.js", "typescript"],
			["file.jsx", "typescript"],
			["file.mjs", "typescript"],
			["file.cjs", "typescript"],
			["file.py", "python"],
			["file.pyi", "python"],
			["file.cs", "csharp"],
			["file.gd", "gdscript"],
			["file.txt", "plaintext"],
		])("maps %s to %s", (filePath, expected) => {
			expect((engine as any).getLanguageIdFromPath(filePath)).toBe(expected);
		});
	});

	describe("normalizeChunkType", () => {
		const engine = new IndexerEngine(createMockOptions());

		it.each([
			["imports", "imports"],
			["types", "types"],
			["impl", "impl"],
			["preamble", "preamble"],
			["declaration", "declaration"],
			["module_section", "module_section"],
			["full_file", "full_file"],
		])("returns %s for known chunk type %s", (value, expected) => {
			expect(
				(engine as any).normalizeChunkType(value, "const value = 1;"),
			).toBe(expected);
		});

		it("falls back to impl for unknown chunk type values", () => {
			expect(
				(engine as any).normalizeChunkType("unknown", "const value = 1;"),
			).toBe("impl");
		});

		it("infers chunk type from primary symbols, imports, types, and empty content", () => {
			expect(
				(engine as any).normalizeChunkType(
					undefined,
					"const value = 1;",
					"runTask",
				),
			).toBe("impl");
			expect((engine as any).normalizeChunkType(undefined, "   ")).toBe(
				"full_file",
			);
			expect(
				(engine as any).normalizeChunkType(
					undefined,
					"import x from 'a';\nexport { y } from 'b';\nimport z from 'c';",
				),
			).toBe("imports");
			expect(
				(engine as any).normalizeChunkType(
					undefined,
					"export interface User {}",
				),
			).toBe("types");
		});
	});

	describe("shouldIndexChunkInVectors", () => {
		it("keeps import chunks when skipping is disabled", () => {
			const engine = new IndexerEngine(createMockOptions());

			expect(
				(engine as any).shouldIndexChunkInVectors({ chunkType: "imports" }),
			).toBe(true);
		});

		it("skips only import chunks when configured", () => {
			const engine = new IndexerEngine(
				createMockOptions({
					indexingOptions: { skipImportChunksInVectors: true },
				}),
			);

			expect(
				(engine as any).shouldIndexChunkInVectors({ chunkType: "imports" }),
			).toBe(false);
			expect(
				(engine as any).shouldIndexChunkInVectors({ chunkType: "impl" }),
			).toBe(true);
		});
	});

	describe("normalizePath", () => {
		it("converts windows separators to forward slashes", () => {
			const engine = new IndexerEngine(createMockOptions());

			expect((engine as any).normalizePath("src\\nested\\file.ts")).toBe(
				"src/nested/file.ts",
			);
		});
	});

	describe("trimToTokenBudget", () => {
		it("returns content unchanged for empty or non-positive budgets", () => {
			const engine = new IndexerEngine(createMockOptions());

			expect((engine as any).trimToTokenBudget("abcdef", 0)).toBe("abcdef");
			expect((engine as any).trimToTokenBudget("", 10)).toBe("");
		});

		it("trims content until the estimated token budget fits", () => {
			const engine = new IndexerEngine(createMockOptions());
			setPrivateField(engine, "tokenEstimator", {
				estimate: vi.fn((value: string) => Math.ceil(value.length / 10)),
			});

			const original = "x".repeat(200);
			const trimmed = (engine as any).trimToTokenBudget(original, 5);

			expect(trimmed.length).toBeGreaterThanOrEqual(32);
			expect(trimmed.length).toBeLessThan(original.length);
		});
	});

	describe("splitHeuristicChunks", () => {
		it("splits TypeScript imports and declarations into semantic chunks", () => {
			const engine = new IndexerEngine(createMockOptions());
			const content = [
				"import { dep } from './dep';",
				"",
				"export class User {}",
				"export function runTask() {}",
			].join("\n");

			expect(
				(engine as any).splitHeuristicChunks(content, "typescript"),
			).toEqual([
				{
					content: "import { dep } from './dep';",
					startLine: 1,
					endLine: 1,
					chunkType: "imports",
				},
				{
					content: "export class User {}",
					startLine: 3,
					endLine: 3,
					chunkType: "types",
					primarySymbol: "User",
				},
				{
					content: "export function runTask() {}",
					startLine: 4,
					endLine: 4,
					chunkType: "impl",
					primarySymbol: "runTask",
				},
			]);
		});

		it("falls back to a single implementation chunk when no definitions are found", () => {
			const engine = new IndexerEngine(createMockOptions());
			const content = ["import os", "", "print('hi')"].join("\n");

			expect((engine as any).splitHeuristicChunks(content, "python")).toEqual([
				{
					content: "import os",
					startLine: 1,
					endLine: 1,
					chunkType: "imports",
				},
				{
					content: "print('hi')",
					startLine: 2,
					endLine: 3,
					chunkType: "impl",
				},
			]);
		});

		it("returns no heuristic chunks for unsupported languages", () => {
			const engine = new IndexerEngine(createMockOptions());

			expect(
				(engine as any).splitHeuristicChunks("hello", "plaintext"),
			).toEqual([]);
		});
	});

	describe("initialize and close", () => {
		it("initializes and closes all backing services", async () => {
			const options = createMockOptions();
			const engine = new IndexerEngine(options as any);

			await engine.initialize();
			await engine.close();

			expect(options.metadata.initialize).toHaveBeenCalledOnce();
			expect(options.vectors.initialize).toHaveBeenCalledOnce();
			expect(options.embedder.initialize).toHaveBeenCalledOnce();
			expect(options.metadata.close).toHaveBeenCalledOnce();
			expect(options.vectors.close).toHaveBeenCalledOnce();
			expect(options.embedder.close).toHaveBeenCalledOnce();
		});
	});

	describe("prepareFileRecords", () => {
		it("builds file, chunk, symbol, dependency, and churn records from a language plugin", async () => {
			const plugin = createMockLanguagePlugin();
			const engine = new IndexerEngine(
				createMockOptions({
					repoRoot: "/repo",
					languagePlugins: [plugin],
				}),
			);
			setPrivateField(engine, "churnByFile", new Map([["src/file.ts", 7]]));

			const result = await (engine as any).prepareFileRecords({
				snapshotId: "snapshot-1",
				projectId: "project-id",
				filePath: "src/file.ts",
				content: "import { dep } from './dep';\nexport function runTask() {}",
				gitRef: "head-commit",
				knownFiles: new Set(["src/dep.ts"]),
			});

			expect(result.fileRecord.path).toBe("src/file.ts");
			expect(result.fileRecord.languageId).toBe("typescript");
			expect(result.symbolRecords).toHaveLength(1);
			expect(result.symbolRecords[0]).toMatchObject({
				filePath: "src/file.ts",
				name: "runTask",
				kind: "function",
			});
			expect(result.dependencyRecords).toHaveLength(2);
			expect(
				result.dependencyRecords.map((dependency: any) => dependency.kind),
			).toEqual(["require", "dynamic_import"]);
			expect(result.chunkRecords).toHaveLength(2);
			expect(
				result.chunkRecords.map((chunk: ChunkRecord) => chunk.chunkType),
			).toEqual(["imports", "impl"]);
			expect(result.chunkRecords[1]?.primarySymbol).toBe("runTask");
			expect(result.metrics.churn).toBe(7);
		});

		it("falls back to generic chunking for unknown file extensions", async () => {
			const engine = new IndexerEngine(createMockOptions());
			setPrivateField(engine, "chunker", {
				chunk: vi.fn(() => [
					{
						content: "plain content",
						startLine: 1,
						endLine: 1,
						type: "unknown",
						primarySymbol: undefined,
					},
				]),
			});

			const result = await (engine as any).prepareFileRecords({
				snapshotId: "snapshot-1",
				projectId: "project-id",
				filePath: "README.txt",
				content: "plain content",
				gitRef: "head-commit",
				knownFiles: new Set(),
			});

			expect(result.fileRecord.languageId).toBe("plaintext");
			expect(result.symbolRecords).toEqual([]);
			expect(result.dependencyRecords).toEqual([]);
			expect(result.chunkRecords).toHaveLength(1);
			expect(result.chunkRecords[0]?.chunkType).toBe("impl");
		});
	});

	describe("indexFile", () => {
		it("writes metadata and embeddings for vector-indexed chunks", async () => {
			const options = createMockOptions({
				languagePlugins: [createMockLanguagePlugin()],
			});
			options.embedder.embed.mockResolvedValue([
				[0.1, 0.2, 0.3],
				[0.4, 0.5, 0.6],
			]);
			const engine = new IndexerEngine(options as any);

			await engine.indexFile({
				snapshotId: "snapshot-1",
				projectId: "project-id",
				filePath: "src/file.ts",
				content: "import { dep } from './dep';\nexport function runTask() {}",
				gitRef: "head-commit",
				knownFiles: new Set(["src/dep.ts"]),
			});

			expect(options.metadata.upsertFile).toHaveBeenCalledOnce();
			expect(options.metadata.replaceChunks).toHaveBeenCalledOnce();
			expect(options.metadata.replaceSymbols).toHaveBeenCalledOnce();
			expect(options.metadata.replaceDependencies).toHaveBeenCalledOnce();
			expect(options.metadata.upsertFileMetrics).toHaveBeenCalledOnce();
			expect(options.embedder.embed).toHaveBeenCalledWith([
				"import { dep } from './dep';",
				"export function runTask() {}",
			]);
			expect(options.vectors.upsert).toHaveBeenCalledOnce();
			expect(options.vectors.upsert.mock.calls[0]?.[0]).toHaveLength(2);
			expect(options.vectors.upsert.mock.calls[0]?.[0][0]).toMatchObject({
				projectId: "project-id",
				filePath: "src/file.ts",
				chunkType: "imports",
				embedding: [0.1, 0.2, 0.3],
			});
			expect(options.vectors.upsert.mock.calls[0]?.[0][1]).toMatchObject({
				projectId: "project-id",
				filePath: "src/file.ts",
				chunkType: "impl",
				primarySymbol: "runTask",
				embedding: [0.4, 0.5, 0.6],
			});
		});

		it("skips vector storage for import chunks when configured", async () => {
			const importOnlyPlugin = createMockLanguagePlugin({
				splitIntoChunks: vi.fn(() => [
					{
						content: "import { dep } from './dep';",
						range: { startLine: 1, endLine: 1 },
						metadata: { chunkType: "imports" },
					},
				]),
			});
			const options = createMockOptions({
				languagePlugins: [importOnlyPlugin],
				indexingOptions: { skipImportChunksInVectors: true },
			});
			const engine = new IndexerEngine(options as any);

			await engine.indexFile({
				snapshotId: "snapshot-1",
				projectId: "project-id",
				filePath: "src/file.ts",
				content: "import { dep } from './dep';",
				gitRef: "head-commit",
				knownFiles: new Set(["src/dep.ts"]),
			});

			expect(options.embedder.embed).not.toHaveBeenCalled();
			expect(options.vectors.upsert).not.toHaveBeenCalled();
		});
	});

	describe("embedWithContextGuard", () => {
		it("retries with trimmed content after an ollama context overflow", async () => {
			mockConfig({
				embeddingProvider: "ollama",
				ollamaNumCtx: 100,
				embeddingModel: "jina-8k",
			});
			const options = createMockOptions();
			options.embedder.embed
				.mockRejectedValueOnce(
					new Error("input length exceeds the context length"),
				)
				.mockResolvedValueOnce([[1, 2, 3]]);
			const engine = new IndexerEngine(options as any);
			setPrivateField(engine, "tokenEstimator", {
				estimate: vi.fn((value: string) => Math.ceil(value.length / 5)),
			});

			const content = "x".repeat(500);
			const embeddings = await (engine as any).embedWithContextGuard(
				[content],
				"test operation",
			);

			expect(embeddings).toEqual([[1, 2, 3]]);
			expect(options.embedder.embed).toHaveBeenCalledTimes(2);
			expect(options.embedder.embed.mock.calls[1]?.[0][0].length).toBeLessThan(
				content.length,
			);
		});
	});

	describe("loadChurnByFile", () => {
		it("normalizes churn keys from git output", async () => {
			const options = createMockOptions();
			options.git.getChurnByFile.mockResolvedValue({
				"./src\\file.ts": 4,
				"nested/util.py": 2,
			});
			const engine = new IndexerEngine(options as any);

			await (engine as any).loadChurnByFile("/repo");

			expect(Array.from((engine as any).churnByFile.entries())).toEqual([
				["src/file.ts", 4],
				["nested/util.py", 2],
			]);
		});

		it("falls back to an empty churn map when git fails", async () => {
			const options = createMockOptions();
			options.git.getChurnByFile.mockRejectedValue(new Error("boom"));
			const engine = new IndexerEngine(options as any);

			await (engine as any).loadChurnByFile("/repo");

			expect((engine as any).churnByFile).toEqual(new Map());
		});
	});

	describe("prepareIncrementalSnapshot", () => {
		it("copies unchanged metadata and vectors from the previous snapshot", async () => {
			const options = createMockOptions();
			options.metadata.listFiles.mockResolvedValue([
				{ path: "src/keep.ts" },
				{ path: "src/change.ts" },
				{ path: "src/delete.ts" },
			]);
			const engine = new IndexerEngine(options as any);

			await (engine as any).prepareIncrementalSnapshot({
				projectId: "project-id",
				prevSnapshotId: "snapshot-prev",
				newSnapshotId: "snapshot-next",
				diff: {
					added: ["src/new.ts"],
					modified: ["src/change.ts"],
					deleted: ["src/delete.ts"],
				},
			});

			expect(options.metadata.copyUnchangedFileData).toHaveBeenCalledWith(
				"project-id",
				"snapshot-prev",
				"snapshot-next",
				["src/keep.ts"],
			);
			expect(options.vectors.copyVectors).toHaveBeenCalledWith(
				"project-id",
				"snapshot-prev",
				"snapshot-next",
				["src/change.ts", "src/delete.ts", "src/new.ts"],
			);
		});

		it("returns early when no unchanged files remain", async () => {
			const options = createMockOptions();
			options.metadata.listFiles.mockResolvedValue([{ path: "src/change.ts" }]);
			const engine = new IndexerEngine(options as any);

			await (engine as any).prepareIncrementalSnapshot({
				projectId: "project-id",
				prevSnapshotId: "snapshot-prev",
				newSnapshotId: "snapshot-next",
				diff: { added: [], modified: ["src/change.ts"], deleted: [] },
			});

			expect(options.metadata.copyUnchangedFileData).not.toHaveBeenCalled();
			expect(options.vectors.copyVectors).not.toHaveBeenCalled();
		});
	});

	describe("deleteProjectVectorsWithRetry", () => {
		it("retries transient delete errors before succeeding", async () => {
			vi.useFakeTimers();
			const options = createMockOptions();
			options.vectors.deleteByProject
				.mockRejectedValueOnce(new Error("Commit conflict for version 1"))
				.mockResolvedValueOnce(undefined);
			const engine = new IndexerEngine(options as any);

			const deletePromise = (engine as any).deleteProjectVectorsWithRetry(
				"project-id",
			);
			await vi.runAllTimersAsync();
			await deletePromise;

			expect(options.vectors.deleteByProject).toHaveBeenCalledTimes(2);
		});

		it("throws immediately for non-transient delete errors", async () => {
			const options = createMockOptions();
			options.vectors.deleteByProject.mockRejectedValue(new Error("fatal"));
			const engine = new IndexerEngine(options as any);

			await expect(
				(engine as any).deleteProjectVectorsWithRetry("project-id"),
			).rejects.toThrow("fatal");
		});
	});

	describe("indexPreparedFiles", () => {
		it("reads files, stores metadata, embeds vector chunks, and records errors", async () => {
			mockConfig({ indexBatchSize: 1 });
			const repoRoot = createTempRepo();
			writeFileSync(
				join(repoRoot, "good.ts"),
				"export const good = 1;",
				"utf8",
			);

			const options = createMockOptions({ repoRoot });
			options.embedder.embed.mockResolvedValue([[0.1, 0.2, 0.3]]);
			const engine = new IndexerEngine(options as any);
			const prepareSpy = vi
				.spyOn(engine as any, "prepareFileRecords")
				.mockImplementation(async (...args: any[]) =>
					createPreparedFileData(args[0].filePath),
				);
			const onProgress = vi.fn();
			const errors: string[] = [];

			await (engine as any).indexPreparedFiles({
				projectId: "project-id",
				repoRoot,
				gitRef: "head-commit",
				snapshotId: "snapshot-1",
				filesToIndex: ["good.ts", "missing.ts"],
				knownFiles: new Set(["good.ts"]),
				totalFiles: 2,
				onProgress,
				errors,
				operation: "batch indexing",
			});

			expect(prepareSpy).toHaveBeenCalledTimes(1);
			expect(options.metadata.transaction).toHaveBeenCalledOnce();
			expect(options.metadata.upsertFile).toHaveBeenCalledOnce();
			expect(options.metadata.replaceChunks).toHaveBeenCalledOnce();
			expect(options.metadata.replaceSymbols).toHaveBeenCalledOnce();
			expect(options.metadata.replaceDependencies).toHaveBeenCalledOnce();
			expect(options.metadata.upsertFileMetrics).toHaveBeenCalledOnce();
			expect(options.embedder.embed).toHaveBeenCalledWith(["good.ts content"]);
			expect(options.vectors.upsert).toHaveBeenCalledOnce();
			expect(errors).toHaveLength(1);
			expect(errors[0]).toContain("Failed to prepare missing.ts");
			expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2);
			expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2);
			expect(options.metadata.updateSnapshotProgress).toHaveBeenCalledWith(
				"snapshot-1",
				0,
				2,
			);
		});
	});

	describe("indexProject", () => {
		it("runs a full reindex when no previous snapshot exists", async () => {
			const options = createMockOptions();
			options.metadata.getLatestSnapshot.mockResolvedValue(null);
			const engine = new IndexerEngine(options as any);
			vi.spyOn(engine as any, "scanFiles").mockResolvedValue([]);
			const generateSpy = vi
				.spyOn((engine as any).architectureGenerator, "generate")
				.mockResolvedValue(undefined);

			const result = await engine.indexProject({ isFullReindex: false });

			expect(result).toEqual({
				snapshotId: "snapshot-1",
				filesIndexed: 0,
				errors: [],
			});
			expect(options.git.getHeadCommit).toHaveBeenCalledWith("/repo");
			expect(options.metadata.clearProjectMetadata).toHaveBeenCalledWith(
				"project-id",
				"snapshot-1",
			);
			expect(options.vectors.deleteByProject).toHaveBeenCalledWith(
				"project-id",
			);
			expect(options.metadata.updateSnapshotStatus).toHaveBeenCalledWith(
				"snapshot-1",
				"completed",
			);
			expect(generateSpy).toHaveBeenCalledWith("project-id", "snapshot-1");
		});

		it("scans and processes files during a populated full reindex", async () => {
			const repoRoot = createTempRepo();
			writeFileSync(join(repoRoot, "src.ts"), "export const src = 1;", "utf8");
			writeFileSync(join(repoRoot, "notes.md"), "ignored", "utf8");
			const options = createMockOptions({ repoRoot });
			options.metadata.getLatestSnapshot.mockResolvedValue(null);
			const engine = new IndexerEngine(options as any);
			const indexPreparedFilesSpy = vi
				.spyOn(engine as any, "indexPreparedFiles")
				.mockResolvedValue(undefined);
			const generateSpy = vi
				.spyOn((engine as any).architectureGenerator, "generate")
				.mockResolvedValue(undefined);

			const result = await engine.indexProject({ isFullReindex: true });

			expect(result).toEqual({
				snapshotId: "snapshot-1",
				filesIndexed: 1,
				errors: [],
			});
			expect(indexPreparedFilesSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					filesToIndex: ["src.ts"],
					totalFiles: 1,
					operation: "full reindex batch indexing",
				}),
			);
			expect(generateSpy).toHaveBeenCalledWith("project-id", "snapshot-1");
			expect(options.metadata.updateSnapshotStatus).toHaveBeenCalledWith(
				"snapshot-1",
				"completed",
			);
		});

		it("completes incremental indexing without reprocessing when changed files are unsupported", async () => {
			const options = createMockOptions();
			options.metadata.getLatestSnapshot.mockResolvedValue({
				id: "snapshot-prev",
			});
			options.metadata.listFiles
				.mockResolvedValueOnce([{ path: "src/existing.ts" }])
				.mockResolvedValueOnce([{ path: "src/existing.ts" }])
				.mockResolvedValueOnce([{ path: "src/existing.ts" }]);
			const engine = new IndexerEngine(options as any);
			const generateSpy = vi
				.spyOn((engine as any).architectureGenerator, "generate")
				.mockResolvedValue(undefined);

			const result = await engine.indexProject({
				isFullReindex: false,
				changedFiles: { added: [], modified: ["README.md"], deleted: [] },
			});

			expect(result).toEqual({
				snapshotId: "snapshot-1",
				filesIndexed: 1,
				errors: [],
			});
			expect(options.metadata.copyUnchangedFileData).toHaveBeenCalledWith(
				"project-id",
				"snapshot-prev",
				"snapshot-1",
				["src/existing.ts"],
			);
			expect(options.metadata.updateSnapshotProgress).toHaveBeenCalledWith(
				"snapshot-1",
				1,
				1,
			);
			expect(generateSpy).toHaveBeenCalledWith("project-id", "snapshot-1");
		});

		it("processes incremental code changes and returns indexed file count", async () => {
			const options = createMockOptions();
			options.metadata.getLatestSnapshot.mockResolvedValue({
				id: "snapshot-prev",
			});
			options.metadata.listFiles.mockResolvedValue([
				{ path: "src/existing.ts" },
				{ path: "src/changed.ts" },
			]);
			const engine = new IndexerEngine(options as any);
			vi.spyOn(engine as any, "prepareIncrementalSnapshot").mockResolvedValue(
				undefined,
			);
			const indexPreparedFilesSpy = vi
				.spyOn(engine as any, "indexPreparedFiles")
				.mockResolvedValue(undefined);
			vi.spyOn(
				(engine as any).architectureGenerator,
				"generate",
			).mockResolvedValue(undefined);

			const result = await engine.indexProject({
				isFullReindex: false,
				changedFiles: { added: [], modified: ["src/changed.ts"], deleted: [] },
			});

			expect(result).toEqual({
				snapshotId: "snapshot-1",
				filesIndexed: 1,
				errors: [],
			});
			expect(indexPreparedFilesSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					filesToIndex: ["src/changed.ts"],
					totalFiles: 2,
					operation: "incremental batch indexing",
				}),
			);
			expect(options.metadata.updateSnapshotStatus).toHaveBeenCalledWith(
				"snapshot-1",
				"completed",
			);
		});

		it("marks the snapshot as failed when incremental indexing throws", async () => {
			const options = createMockOptions();
			options.metadata.getLatestSnapshot.mockResolvedValue({
				id: "snapshot-prev",
			});
			options.metadata.listFiles.mockResolvedValue([
				{ path: "src/changed.ts" },
			]);
			const engine = new IndexerEngine(options as any);
			vi.spyOn(engine as any, "prepareIncrementalSnapshot").mockResolvedValue(
				undefined,
			);
			vi.spyOn(engine as any, "indexPreparedFiles").mockRejectedValue(
				new Error("index failed"),
			);

			await expect(
				engine.indexProject({
					isFullReindex: false,
					changedFiles: {
						added: [],
						modified: ["src/changed.ts"],
						deleted: [],
					},
				}),
			).rejects.toThrow("index failed");

			expect(options.metadata.updateSnapshotStatus).toHaveBeenCalledWith(
				"snapshot-1",
				"failed",
				"index failed",
			);
		});

		it("marks the snapshot as failed when full reindex indexing throws", async () => {
			const repoRoot = createTempRepo();
			writeFileSync(join(repoRoot, "src.ts"), "export const src = 1;", "utf8");
			const options = createMockOptions({ repoRoot });
			options.metadata.getLatestSnapshot.mockResolvedValue(null);
			const engine = new IndexerEngine(options as any);
			vi.spyOn(engine as any, "indexPreparedFiles").mockRejectedValue(
				new Error("full reindex failed"),
			);

			await expect(
				engine.indexProject({ isFullReindex: true }),
			).rejects.toThrow("full reindex failed");

			expect(options.metadata.updateSnapshotStatus).toHaveBeenCalledWith(
				"snapshot-1",
				"failed",
				"full reindex failed",
			);
		});
	});

	describe("config-driven helpers", () => {
		it("uses configured batch and concurrency values when valid", () => {
			mockConfig({ indexBatchSize: 3, indexConcurrency: 7 });
			const engine = new IndexerEngine(createMockOptions());

			expect((engine as any).getBatchSize()).toBe(3);
			expect((engine as any).getIndexConcurrency()).toBe(7);
		});

		it("falls back to defaults when configured batch and concurrency are invalid", () => {
			mockConfig({ indexBatchSize: 0, indexConcurrency: -1 });
			const engine = new IndexerEngine(createMockOptions());

			expect((engine as any).getBatchSize()).toBe(50);
			expect((engine as any).getIndexConcurrency()).toBe(5);
		});
	});
});
