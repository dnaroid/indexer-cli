import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

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
	"../../../src/cli/commands/index.ts",
	/function countChangedFiles[\s\S]*?(?=function printFileTree)/,
	["countChangedFiles", "buildFileTree"],
);

const architecture = await loadInternals<{
	summarizeExternalDependencies: (
		values: Record<string, string[]>,
	) => Record<string, number>;
}>(
	"../../../src/cli/commands/architecture.ts",
	/function summarizeExternalDependencies[\s\S]*?(?=function formatPlain)/,
	["summarizeExternalDependencies"],
);

const search = await loadInternals<{
	parseMinScore: (input?: string) => number | undefined;
}>(
	"../../../src/cli/commands/search.ts",
	/type SearchResult[\s\S]*?(?=export function registerSearchCommand)/,
	["parseMinScore"],
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
	estimateTokens: (data: {
		architecture: { fileStats: Record<string, number>; entrypoints: string[] };
		modules: Array<{ path: string }>;
		symbols: Array<{
			file: string;
			name: string;
			kind: string;
			signature?: string;
		}>;
		dependencies: Record<string, string[]>;
	}) => number;
}>(
	"../../../src/cli/commands/context.ts",
	/type ContextData = [\s\S]*?(?=function normalizeScopePath)/,
	["parseMaxDeps", "limitDependencies", "estimateTokens"],
);

const structure = await loadInternals<{
	parseMaxDepth: (value?: string) => number | undefined;
	parseMaxFiles: (value?: string) => number | undefined;
	createNode: () => {
		files: Set<string>;
		directories: Map<string, unknown>;
	};
	insertPath: (root: any, filePath: string) => void;
	summarizeHiddenChildren: (node: any) => string;
	countFiles: (node: any) => number;
}>(
	"../../../src/cli/commands/structure.ts",
	/type TreeNode = [\s\S]*?(?=export function registerStructureCommand)/,
	[
		"parseMaxDepth",
		"parseMaxFiles",
		"createNode",
		"insertPath",
		"summarizeHiddenChildren",
		"countFiles",
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
		it("parses min-score thresholds", () => {
			const defaultVal = search.parseMinScore();
			expect(typeof defaultVal === "number" && defaultVal >= 0 && defaultVal <= 1).toBe(true);
			expect(search.parseMinScore("0.4")).toBe(0.4);
			expect(() => search.parseMinScore("2")).toThrow(/--min-score/i);
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

		it("estimates tokens from text-based character count", () => {
			const data = {
				architecture: {
					fileStats: { typescript: 10 },
					entrypoints: ["src/index.ts"],
				},
				modules: [{ path: "src/app.ts" }],
				symbols: [
					{
						file: "src/app.ts",
						name: "App",
						kind: "class",
						signature: "class App {}",
					},
				],
				dependencies: { "src/app.ts": ["src/core.ts"] },
			};
			const tokens = context.estimateTokens(data);
			expect(tokens).toBeGreaterThan(0);
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

		it("parses max-files and rejects invalid values", () => {
			expect(structure.parseMaxFiles()).toBeUndefined();
			expect(structure.parseMaxFiles("5")).toBe(5);
			expect(structure.parseMaxFiles("100")).toBe(100);
			expect(() => structure.parseMaxFiles("0")).toThrow(/--max-files/i);
			expect(() => structure.parseMaxFiles("-3")).toThrow(/--max-files/i);
		});

		it("counts all files in a subtree recursively", () => {
			const root = structure.createNode() as any;
			structure.insertPath(root, "src/a.ts");
			structure.insertPath(root, "src/b.ts");
			structure.insertPath(root, "src/nested/c.ts");
			structure.insertPath(root, "README.md");

			expect(structure.countFiles(root)).toBe(4);

			const src = root.directories.get("src") as any;
			expect(structure.countFiles(src)).toBe(3);
		});
	});
});
