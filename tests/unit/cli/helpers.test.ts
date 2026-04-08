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

const structure = await loadInternals<{
	createNode: () => {
		files: Set<string>;
		directories: Map<string, unknown>;
	};
	insertPath: (root: any, filePath: string) => void;
	treeToJson: (
		root: any,
		prefix: string,
		symbolsByFile: Map<
			string,
			Array<{ name: string; kind: string; exported: boolean }>
		>,
	) => object[];
}>(
	"/Volumes/128GBSSD/Projects/indexer-cli/src/cli/commands/structure.ts",
	/type TreeNode = [\s\S]*?(?=export function registerStructureCommand)/,
	["createNode", "insertPath", "treeToJson"],
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

	describe("createNode and insertPath", () => {
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

			const cli = src.directories.get("cli") as any;
			const core = src.directories.get("core") as any;
			expect(Array.from(cli.files)).toEqual(["index.ts"]);
			expect(Array.from(core.files)).toEqual(["types.ts"]);
		});
	});

	describe("treeToJson", () => {
		it("serializes a sorted tree and projects symbol metadata", () => {
			const root = structure.createNode() as any;
			structure.insertPath(root, "src/beta.ts");
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
							filePath: "src/alpha.ts",
						},
					],
				],
				[
					"src/beta.ts",
					[
						{
							name: "beta",
							kind: "function",
							exported: false,
							filePath: "src/beta.ts",
						},
					],
				],
			]);

			expect(structure.treeToJson(root, "", symbolsByFile)).toEqual([
				{
					type: "directory",
					name: "src",
					children: [
						{
							type: "file",
							name: "alpha.ts",
							path: "src/alpha.ts",
							symbols: [{ name: "Alpha", kind: "class", exported: true }],
						},
						{
							type: "file",
							name: "beta.ts",
							path: "src/beta.ts",
							symbols: [{ name: "beta", kind: "function", exported: false }],
						},
					],
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
