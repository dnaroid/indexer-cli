import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { SearchEngine } from "../../../src/engine/searcher.js";
import type {
	EmbeddingProvider,
	MetadataStore,
	SymbolRecord,
	VectorSearchResult,
	VectorStore,
} from "../../../src/core/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadInternals<T>(
	filePath: string,
	matcher: RegExp,
	exportNames: string[],
): Promise<T> {
	const source = readFileSync(path.resolve(__dirname, filePath), "utf8");
	const match = source.match(matcher);
	if (!match) {
		throw new Error(`Unable to extract internals from ${filePath}`);
	}

	const transpiled = ts.transpileModule(
		`${match[0]}\nexport { ${exportNames.join(", ")} };`,
		{
			compilerOptions: {
				module: ts.ModuleKind.ES2022,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText;

	const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
	return (await import(moduleUrl)) as T;
}

type ArchitectureSnapshotLike = {
	file_stats?: Record<string, number>;
	entrypoints?: string[];
	dependency_map?: {
		internal?: Record<string, string[]>;
		external?: Record<string, string[]>;
		builtin?: Record<string, string[]>;
		unresolved?: Record<string, string[]>;
	};
};

type TreeNodeLike = {
	files: Set<string>;
	directories: Map<string, TreeNodeLike>;
};

const searcherInternals = await loadInternals<{
	isTestFile: (p: string) => boolean;
}>(
	"../../../src/engine/searcher.ts",
	/const TEST_PATH_PATTERNS[\s\S]*?(?=\nexport class SearchEngine)/,
	["isTestFile"],
);

const architecture = await loadInternals<{
	formatPlain: (architecture: ArchitectureSnapshotLike) => void;
}>(
	"../../../src/cli/commands/architecture.ts",
	/function summarizeExternalDependencies[\s\S]*?(?=export function registerArchitectureCommand)/,
	["formatPlain"],
);

const structure = await loadInternals<{
	createNode: () => TreeNodeLike;
	insertPath: (root: TreeNodeLike, filePath: string) => void;
	printTree: (
		node: TreeNodeLike,
		indent: string,
		prefix: string,
		symbolsByFile: Map<string, SymbolRecord[]>,
		depth: number,
		maxDepth?: number,
		fileCounter?: { printed: number; hidden: number },
		maxFiles?: number,
		includeInternal?: boolean,
	) => void;
}>(
	"../../../src/cli/commands/structure.ts",
	/type TreeNode = [\s\S]*?(?=export function registerStructureCommand)/,
	["createNode", "insertPath", "printTree"],
);

function createMetadataStoreMock(): MetadataStore {
	return {
		initialize: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
		transaction: async <T>(callback: () => Promise<T>) => callback(),
		createSnapshot: vi.fn(async () => {
			throw new Error("not implemented");
		}),
		getSnapshot: vi.fn(async () => null),
		getLatestSnapshot: vi.fn(async () => null),
		getLatestCompletedSnapshot: vi.fn(async () => null),
		listSnapshots: vi.fn(async () => []),
		updateSnapshotStatus: vi.fn(async () => undefined),
		updateSnapshotProgress: vi.fn(async () => undefined),
		upsertFile: vi.fn(async () => undefined),
		listFiles: vi.fn(async () => []),
		getFile: vi.fn(async () => null),
		replaceChunks: vi.fn(async () => undefined),
		listChunks: vi.fn(async () => []),
		replaceSymbols: vi.fn(async () => undefined),
		listSymbols: vi.fn(async () => []),
		searchSymbols: vi.fn(async () => []),
		replaceDependencies: vi.fn(async () => undefined),
		listDependencies: vi.fn(async () => []),
		getDependents: vi.fn(async () => []),
		upsertFileMetrics: vi.fn(async () => undefined),
		getFileMetrics: vi.fn(async () => null),
		listFileMetrics: vi.fn(async () => []),
		upsertArtifact: vi.fn(async () => undefined),
		getArtifact: vi.fn(async () => null),
		listArtifacts: vi.fn(async () => []),
		copyUnchangedFileData: vi.fn(async () => undefined),
		clearProjectMetadata: vi.fn(async () => undefined),
	};
}

function createVectorStoreMock(results: VectorSearchResult[]): VectorStore {
	return {
		initialize: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
		upsert: vi.fn(async () => undefined),
		search: vi.fn(async () => results),
		countVectors: vi.fn(async () => 0),
		deleteBySnapshot: vi.fn(async () => undefined),
		copyVectors: vi.fn(async () => undefined),
		deleteByProject: vi.fn(async () => undefined),
	};
}

function createEmbedderMock(): EmbeddingProvider {
	return {
		id: "test-embedder",
		initialize: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
		getDimension: vi.fn(() => 2),
		embed: vi.fn(async () => [[0.1, 0.2]]),
	};
}

describe("CLI quality fixes", () => {
	describe("SearchEngine import/preamble penalty", () => {
		function createEngine(results: VectorSearchResult[]): SearchEngine {
			return new SearchEngine(
				createMetadataStoreMock(),
				createVectorStoreMock(results),
				createEmbedderMock(),
				"/tmp",
			);
		}

		const vectorResults: VectorSearchResult[] = [
			{
				chunkId: "1",
				snapshotId: "s1",
				filePath: "src/a.ts",
				startLine: 1,
				endLine: 50,
				contentHash: "x",
				score: 0.5,
				chunkType: "imports",
			},
			{
				chunkId: "2",
				snapshotId: "s1",
				filePath: "src/b.ts",
				startLine: 100,
				endLine: 200,
				contentHash: "y",
				score: 0.48,
				chunkType: "impl",
				primarySymbol: "myFunc",
			},
			{
				chunkId: "3",
				snapshotId: "s1",
				filePath: "src/c.ts",
				startLine: 1,
				endLine: 30,
				contentHash: "z",
				score: 0.52,
				chunkType: "preamble",
			},
		];

		it("excludes imports/preamble by default and includes them when opted in", async () => {
			const engine = createEngine(vectorResults);

			const defaultResults = await engine.search("default", "s1", "query", {
				includeContent: false,
				minScore: 0,
			});
			expect(defaultResults.map((result) => result.filePath)).toEqual([
				"src/b.ts",
			]);

			const withImports = await engine.search("default", "s1", "query", {
				includeContent: false,
				minScore: 0,
				includeImportChunks: true,
			});
			expect(withImports.map((result) => result.filePath)).toEqual([
				"src/b.ts",
				"src/c.ts",
				"src/a.ts",
			]);
			expect(withImports.map((result) => result.score)).toEqual([
				0.48, 0.364, 0.25,
			]);
			expect(withImports[0]?.chunkType).toBe("impl");
			expect(withImports[0]?.primarySymbol).toBe("myFunc");
		});

		it("filters results using adjusted scores when includeImportChunks is set", async () => {
			const engine = createEngine(vectorResults);

			const strictResults = await engine.search("default", "s1", "query", {
				includeContent: false,
				minScore: 0.45,
				includeImportChunks: true,
			});
			expect(strictResults.map((result) => result.filePath)).toEqual([
				"src/b.ts",
			]);

			const relaxedResults = await engine.search("default", "s1", "query", {
				includeContent: false,
				minScore: 0.25,
				includeImportChunks: true,
			});
			expect(relaxedResults.map((result) => result.filePath)).toEqual([
				"src/b.ts",
				"src/c.ts",
				"src/a.ts",
			]);
		});

		it("penalizes test files with an additional score multiplier", async () => {
			const engine = createEngine([
				{
					chunkId: "prod-1",
					snapshotId: "s1",
					filePath: "src/engine/searcher.ts",
					startLine: 1,
					endLine: 30,
					contentHash: "h1",
					score: 0.6,
					chunkType: "impl",
					primarySymbol: "search",
				},
				{
					chunkId: "test-1",
					snapshotId: "s1",
					filePath: "tests/unit/engine/searcher.test.ts",
					startLine: 1,
					endLine: 30,
					contentHash: "h2",
					score: 0.6,
					chunkType: "impl",
				},
			]);

			const results = await engine.search("default", "s1", "query", {
				includeContent: false,
				minScore: 0,
			});

			expect(results).toHaveLength(2);
			expect(results[0]?.filePath).toBe("src/engine/searcher.ts");
			expect(results[0]?.score).toBe(0.6);
			expect(results[1]?.filePath).toBe("tests/unit/engine/searcher.test.ts");
			expect(results[1]?.score).toBeCloseTo(0.6 * 0.75, 10);
		});

		it("stacks test-file and imports penalties", async () => {
			const engine = createEngine([
				{
					chunkId: "both",
					snapshotId: "s1",
					filePath: "tests/unit/a.test.ts",
					startLine: 1,
					endLine: 10,
					contentHash: "h",
					score: 0.8,
					chunkType: "imports",
				},
			]);

			const results = await engine.search("default", "s1", "query", {
				includeContent: false,
				minScore: 0,
				includeImportChunks: true,
			});

			expect(results).toHaveLength(1);
			expect(results[0]?.score).toBeCloseTo(0.8 * 0.5 * 0.75, 10);
		});
	});

	describe("isTestFile detection across languages", () => {
		const isTestFile = searcherInternals.isTestFile;

		const testCases: Array<[string, boolean]> = [
			["tests/unit/engine/searcher.test.ts", true],
			["src/__tests__/app.ts", true],
			["test/helper.rb", true],
			["spec/models/user_spec.rb", true],
			["tests/test_parser.py", true],
			["tests/parser_test.py", true],
			["src/Services/UserTests.cs", true],
			["src/services/user.test.gd", true],
			["src/cli/commands/search.ts", false],
			["src/core/types.ts", false],
			["src/engine/searcher.ts", false],
			["src/utils.py", false],
			["src/App.cs", false],
			["src/player.gd", false],
		];

		for (const [path, expected] of testCases) {
			it(`${expected ? "detects" : "ignores"} ${path}`, () => {
				expect(isTestFile(path)).toBe(expected);
			});
		}
	});

	describe("architecture plain output", () => {
		let logs: string[];

		beforeEach(() => {
			logs = [];
			vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
				logs.push(args.join(" "));
			});
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("reports cyclic dependencies when two modules depend on each other", () => {
			architecture.formatPlain({
				file_stats: {},
				entrypoints: [],
				dependency_map: {
					internal: {
						"src/cli": ["src/core"],
						"src/core": ["src/cli"],
					},
					external: {},
					builtin: {},
					unresolved: {},
				},
			});

			expect(logs).toContain("\n⚠ Cyclic dependencies detected:");
			expect(logs).toContain("  src/cli <-> src/core");
		});

		it("does not print a cycle warning when the graph is acyclic", () => {
			architecture.formatPlain({
				file_stats: { typescript: 2 },
				entrypoints: ["src/index.ts"],
				dependency_map: {
					internal: {
						"src/cli": ["src/core"],
						"src/core": ["src/engine"],
					},
					external: {},
					builtin: {},
					unresolved: {},
				},
			});

			expect(
				logs.some((line) => line.includes("Cyclic dependencies detected")),
			).toBe(false);
		});

		it("uses singular and plural external dependency labels", () => {
			architecture.formatPlain({
				file_stats: {},
				entrypoints: [],
				dependency_map: {
					internal: {},
					external: {
						"src/a.ts": ["chalk", "react"],
						"src/b.ts": ["react"],
					},
					builtin: {},
					unresolved: {},
				},
			});

			expect(logs).toContain("  chalk: 1 file");
			expect(logs).toContain("  react: 2 files");
		});
	});

	describe("structure plain output", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("prints files without a no-symbols annotation", () => {
			const logs: string[] = [];
			vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
				logs.push(args.join(" "));
			});

			const root = structure.createNode();
			structure.insertPath(root, "src/empty.ts");

			structure.printTree(
				root,
				"",
				"",
				new Map<string, SymbolRecord[]>(),
				0,
				undefined,
				undefined,
				undefined,
				false,
			);

			expect(logs).toEqual(["src/", "  empty.ts"]);
		});

		it("collapses single-child directory chains and groups internal symbols inline", () => {
			const logs: string[] = [];
			vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
				logs.push(args.join(" "));
			});
			const structureFilePath = "src/cli/commands/structure.ts";
			const range = {
				start: { line: 1, character: 0 },
				end: { line: 1, character: 1 },
			};

			const root = structure.createNode();
			structure.insertPath(root, structureFilePath);
			structure.insertPath(root, "src/cli/commands/index.ts");

			structure.printTree(
				root,
				"",
				"",
				new Map<string, SymbolRecord[]>([
					[
						structureFilePath,
						[
							{
								snapshotId: "s",
								id: "1",
								filePath: structureFilePath,
								name: "registerStructureCommand",
								kind: "function",
								exported: true,
								range,
							},
							{
								snapshotId: "s",
								id: "2",
								filePath: structureFilePath,
								name: "parseMaxDepth",
								kind: "function",
								exported: false,
								range,
							},
							{
								snapshotId: "s",
								id: "3",
								filePath: structureFilePath,
								name: "parseMaxFiles",
								kind: "function",
								exported: false,
								range,
							},
						],
					],
				]),
				0,
				undefined,
				undefined,
				undefined,
				true,
			);

			expect(logs).toEqual([
				"src/cli/commands/",
				"  index.ts",
				"  structure.ts — function: registerStructureCommand; function (internal): parseMaxDepth, parseMaxFiles",
			]);
		});
	});
});
