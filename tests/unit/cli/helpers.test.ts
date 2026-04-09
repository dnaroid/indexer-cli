import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

async function loadInternals<T>(
	filePath: string,
	matcher: RegExp,
	exportNames: string[],
): Promise<T> {
	const source = readFileSync(filePath, "utf8");
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

const cliIndex = await loadInternals<{
	countChangedFiles: (diff: {
		added: string[];
		modified: string[];
		deleted: string[];
	}) => number;
	buildFileTree: (filePaths: string[]) => {
		dirs: Map<string, unknown>;
		files: Set<string>;
	};
}>(
	"/Volumes/128GBSSD/Projects/indexer-cli/src/cli/commands/index.ts",
	/function countChangedFiles[\s\S]*?(?=function printFileTree)/,
	["countChangedFiles", "buildFileTree"],
);

const architecture = await loadInternals<{
	summarizeExternalDependencies: (
		values: Record<string, string[]>,
	) => Record<string, number>;
}>(
	"/Volumes/128GBSSD/Projects/indexer-cli/src/cli/commands/architecture.ts",
	/function summarizeExternalDependencies[\s\S]*?(?=function formatPlain)/,
	["summarizeExternalDependencies"],
);

const search = await loadInternals<{
	parseSearchFields: (input?: string) => string[];
	parseMinScore: (input?: string) => number | undefined;
	projectSearchResult: (
		result: {
			filePath: string;
			startLine: number;
			endLine: number;
			score: number;
			primarySymbol?: string;
			content?: string;
		},
		fields: string[],
	) => Record<string, number | string | null>;
}>(
	"/Volumes/128GBSSD/Projects/indexer-cli/src/cli/commands/search.ts",
	/const SEARCH_FIELDS[\s\S]*?(?=export function registerSearchCommand)/,
	["parseSearchFields", "parseMinScore", "projectSearchResult"],
);

const context = await loadInternals<{
	parseMaxDeps: (input?: string) => number | undefined;
	limitDependencies: (
		dependencies: Record<string, string[]>,
		maxDeps: number | undefined,
	) => {
		dependencies: Record<string, string[]>;
		shown: number;
		total: number;
		truncated: boolean;
	};
}>(
	"/Volumes/128GBSSD/Projects/indexer-cli/src/cli/commands/context.ts",
	/type ContextData = [\s\S]*?(?=export function registerContextCommand)/,
	["parseMaxDeps", "limitDependencies"],
);

const structure = await loadInternals<{
	parseMaxDepth: (value?: string) => number | undefined;
	createNode: () => {
		files: Set<string>;
		directories: Map<string, unknown>;
	};
	insertPath: (root: any, filePath: string) => void;
	summarizeHiddenChildren: (node: any) => string;
	treeToJson: (
		root: any,
		prefix: string,
		symbolsByFile: Map<
			string,
			Array<{ name: string; kind: string; exported: boolean }>
		>,
		depth: number,
		maxDepth?: number,
	) => object[];
}>(
	"/Volumes/128GBSSD/Projects/indexer-cli/src/cli/commands/structure.ts",
	/type TreeNode = [\s\S]*?(?=export function registerStructureCommand)/,
	[
		"parseMaxDepth",
		"createNode",
		"insertPath",
		"summarizeHiddenChildren",
		"treeToJson",
	],
);

describe("CLI helper functions", () => {
	describe("countChangedFiles", () => {
		it("counts added, modified, and deleted files", () => {
			expect(
				cliIndex.countChangedFiles({
					added: ["a.ts", "b.ts"],
					modified: ["c.ts"],
					deleted: ["d.ts", "e.ts"],
				}),
			).toBe(5);
		});
	});

	describe("buildFileTree", () => {
		it("builds nested directories and file sets", () => {
			const tree = cliIndex.buildFileTree([
				"src/index.ts",
				"src/utils/math.ts",
				"README.md",
			]);

			expect(Array.from(tree.files)).toEqual(["README.md"]);
			expect(Array.from(tree.dirs.keys())).toEqual(["src"]);

			const src = tree.dirs.get("src") as any;
			expect(Array.from(src.files).sort()).toEqual(["index.ts"]);
			expect(Array.from(src.dirs.keys())).toEqual(["utils"]);

			const utils = src.dirs.get("utils") as any;
			expect(Array.from(utils.files)).toEqual(["math.ts"]);
		});
	});

	describe("summarizeExternalDependencies", () => {
		it("aggregates dependency usage across files", () => {
			expect(
				architecture.summarizeExternalDependencies({
					"src/a.ts": ["react", "zod"],
					"src/b.ts": ["react", "chalk"],
					"src/c.ts": ["chalk"],
				}),
			).toEqual({ chalk: 2, react: 2, zod: 1 });
		});
	});

	describe("search helpers", () => {
		it("parses and validates requested output fields", () => {
			expect(search.parseSearchFields()).toEqual([
				"filePath",
				"startLine",
				"endLine",
				"score",
				"primarySymbol",
				"content",
			]);
			expect(search.parseSearchFields("score,filePath,score")).toEqual([
				"filePath",
				"score",
			]);
			expect(() => search.parseSearchFields("filePath,unknown")).toThrow(
				/Invalid --fields value/i,
			);
		});

		it("parses min-score thresholds", () => {
			expect(search.parseMinScore()).toBeUndefined();
			expect(search.parseMinScore("0.4")).toBe(0.4);
			expect(() => search.parseMinScore("2")).toThrow(/--min-score/i);
		});

		it("projects only the requested result fields", () => {
			expect(
				search.projectSearchResult(
					{
						filePath: "src/app.ts",
						startLine: 10,
						endLine: 20,
						score: 0.91,
						primarySymbol: "run",
						content: "body",
					},
					["filePath", "score", "primarySymbol"],
				),
			).toEqual({
				filePath: "src/app.ts",
				score: 0.91,
				primarySymbol: "run",
			});
		});
	});

	describe("context helpers", () => {
		it("parses max dependency limits", () => {
			expect(context.parseMaxDeps()).toBeUndefined();
			expect(context.parseMaxDeps("30")).toBe(30);
			expect(() => context.parseMaxDeps("0")).toThrow(/--max-deps/i);
		});

		it("limits dependency output and reports truncation", () => {
			expect(
				context.limitDependencies(
					{
						b: ["c"],
						a: ["b"],
						c: ["d"],
					},
					2,
				),
			).toEqual({
				dependencies: {
					a: ["b"],
					b: ["c"],
				},
				shown: 2,
				total: 3,
				truncated: true,
			});
		});
	});

	describe("structure helpers", () => {
		it("creates empty nodes and inserts nested paths", () => {
			const root = structure.createNode() as any;

			expect(root.files.size).toBe(0);
			expect(root.directories.size).toBe(0);

			structure.insertPath(root, "src/cli/index.ts");
			structure.insertPath(root, "src/core/types.ts");
			structure.insertPath(root, "package.json");

			expect(Array.from(root.files)).toEqual(["package.json"]);
			expect(Array.from(root.directories.keys())).toEqual(["src"]);

			const src = root.directories.get("src") as any;
			expect(Array.from(src.directories.keys()).sort()).toEqual([
				"cli",
				"core",
			]);
		});

		it("parses max depth and summarizes hidden children", () => {
			expect(structure.parseMaxDepth()).toBeUndefined();
			expect(structure.parseMaxDepth("2")).toBe(2);
			expect(() => structure.parseMaxDepth("-1")).toThrow(/--max-depth/i);

			const root = structure.createNode() as any;
			structure.insertPath(root, "src/a.ts");
			structure.insertPath(root, "src/nested/b.ts");
			const src = root.directories.get("src") as any;
			expect(structure.summarizeHiddenChildren(src)).toBe("... (2 children)");
		});

		it("serializes a sorted tree and truncates deep branches", () => {
			const root = structure.createNode() as any;
			structure.insertPath(root, "src/nested/deeper/file.ts");
			structure.insertPath(root, "src/alpha.ts");
			structure.insertPath(root, "README.md");

			const symbolsByFile = new Map([
				[
					"src/alpha.ts",
					[
						{
							name: "Alpha",
							kind: "class",
							exported: true,
						},
					],
				],
			]);

			expect(structure.treeToJson(root, "", symbolsByFile, 0, 1)).toEqual([
				{
					type: "directory",
					name: "src",
					children: [{ type: "summary", name: "... (2 children)" }],
				},
				{
					type: "file",
					name: "README.md",
					path: "README.md",
					symbols: [],
				},
			]);
		});
	});
});
