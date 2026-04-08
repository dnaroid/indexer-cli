import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { TypeScriptPlugin } from "../../src/languages/typescript.ts";
import { readFixtureAsSource } from "../helpers/fixture-loader";

const plugin = new TypeScriptPlugin();

const FIXTURE_INDEX = "typescript-basic/src/index.ts";
const FIXTURE_UTIL = "typescript-basic/src/util.ts";
const FIXTURE_ADD = "typescript-basic/src/math/add.ts";

const parseInline = (filePath: string, content: string) =>
	plugin.parse({ path: filePath, content });

describe("TypeScriptPlugin", () => {
	describe(`fixture: ${FIXTURE_INDEX}`, () => {
		const source = readFixtureAsSource(FIXTURE_INDEX);
		const parsed = plugin.parse(source);

		it("parse() returns correct structure", () => {
			expect(parsed).toHaveProperty("languageId", "typescript");
			expect(parsed).toHaveProperty("path", FIXTURE_INDEX);
			expect(parsed.ast).toBeTruthy();
		});

		it("extractSymbols() finds exported function foo", () => {
			const symbols = plugin.extractSymbols(parsed);
			expect(symbols.length).toBeGreaterThanOrEqual(1);

			const foo = symbols.find((s) => s.name === "foo");
			expect(foo).toBeDefined();
			expect(foo!.kind).toBe("function");
			expect(foo!.exported).toBe(true);
			expect(foo!.filePath).toContain(FIXTURE_INDEX);
		});

		it("extractImports() returns an array without errors", () => {
			const imports = plugin.extractImports(parsed);
			expect(Array.isArray(imports)).toBe(true);
		});

		it("splitIntoChunks() returns valid chunks", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 300 });
			expect(chunks.length).toBeGreaterThanOrEqual(1);

			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toContain(FIXTURE_INDEX);
				expect(chunk.languageId).toBe("typescript");
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.range).toHaveProperty("startLine");
				expect(chunk.range).toHaveProperty("endLine");
				expect(chunk.range.startLine).toBeGreaterThanOrEqual(1);
				expect(chunk.range.endLine).toBeGreaterThanOrEqual(
					chunk.range.startLine,
				);
			}
		});
	});

	describe(`fixture: ${FIXTURE_UTIL}`, () => {
		const source = readFixtureAsSource(FIXTURE_UTIL);
		const parsed = plugin.parse(source);

		it("parse() returns correct structure", () => {
			expect(parsed).toHaveProperty("languageId", "typescript");
			expect(parsed).toHaveProperty("path", FIXTURE_UTIL);
			expect(parsed.ast).toBeTruthy();
		});

		it("extractSymbols() finds exported function bar", () => {
			const symbols = plugin.extractSymbols(parsed);
			expect(symbols.length).toBeGreaterThanOrEqual(1);

			const bar = symbols.find((s) => s.name === "bar");
			expect(bar).toBeDefined();
			expect(bar!.kind).toBe("function");
			expect(bar!.exported).toBe(true);
			expect(bar!.filePath).toContain(FIXTURE_UTIL);
		});

		it("extractImports() returns an array without errors", () => {
			const imports = plugin.extractImports(parsed);
			expect(Array.isArray(imports)).toBe(true);
		});

		it("splitIntoChunks() returns valid chunks", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 300 });
			expect(chunks.length).toBeGreaterThanOrEqual(1);

			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toContain(FIXTURE_UTIL);
				expect(chunk.languageId).toBe("typescript");
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.range).toHaveProperty("startLine");
				expect(chunk.range).toHaveProperty("endLine");
				expect(chunk.range.startLine).toBeGreaterThanOrEqual(1);
				expect(chunk.range.endLine).toBeGreaterThanOrEqual(
					chunk.range.startLine,
				);
			}
		});
	});

	describe("getEntrypoints()", () => {
		it("ranks src/index.ts highly among file paths", () => {
			const filePaths = [
				"src/components/Button.tsx",
				"src/index.ts",
				"src/util.ts",
				"src/math/add.ts",
				"package.json",
			];

			const entrypoints = plugin.getEntrypoints!(filePaths);
			expect(entrypoints.length).toBeGreaterThanOrEqual(1);
			expect(entrypoints[0]).toBe("src/index.ts");
		});

		it("returns an empty array when no candidates are present", () => {
			expect(plugin.getEntrypoints([])).toEqual([]);
			expect(
				plugin.getEntrypoints(["README.md", "src/components/Button.tsx"]),
			).toEqual([]);
		});

		it("prefers /src/ candidates over /dist/ candidates", () => {
			const entrypoints = plugin.getEntrypoints([
				"packages/demo/dist/index.ts",
				"packages/demo/src/index.ts",
			]);

			expect(entrypoints).toEqual([
				"packages/demo/src/index.ts",
				"packages/demo/dist/index.ts",
			]);
		});

		it("limits ranked entrypoints to 20 files", () => {
			const filePaths = Array.from({ length: 25 }, (_, index) => {
				const bucket = String(index).padStart(2, "0");
				return `packages/app-${bucket}/src/index.ts`;
			});

			const entrypoints = plugin.getEntrypoints(filePaths);
			expect(entrypoints).toHaveLength(20);
			expect(entrypoints).toEqual(filePaths.slice(0, 20));
		});
	});

	describe("extractImports() with inline sources", () => {
		let tempDir = "";

		beforeEach(() => {
			tempDir = mkdtempSync(join(process.cwd(), ".tmp-typescript-plugin-"));
		});

		afterEach(() => {
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("resolves relative imports, index exports, and leaves external imports unresolved", () => {
			mkdirSync(join(tempDir, "src", "shared"), { recursive: true });
			mkdirSync(join(tempDir, "src", "pkg"), { recursive: true });
			writeFileSync(join(tempDir, "src", "foo.ts"), "export const foo = 1;\n");
			writeFileSync(
				join(tempDir, "src", "shared", "bar.ts"),
				"export const bar = 2;\n",
			);
			writeFileSync(
				join(tempDir, "src", "pkg", "index.ts"),
				"export const pkgValue = 3;\n",
			);

			const entryFile = join(tempDir, "src", "entry.ts");
			const parsed = parseInline(
				relative(process.cwd(), entryFile).replace(/\\/g, "/"),
				[
					'import { foo } from "./foo";',
					'import { bar } from "./shared/bar";',
					'import pkg from "./pkg";',
					'import lodash from "lodash";',
					'export { pkgValue } from "./pkg";',
					'export * from "express";',
					"const localValue = foo + bar;",
					"export { localValue };",
				].join("\n"),
			);

			const imports = plugin.extractImports(parsed);
			expect(imports).toHaveLength(6);

			expect(
				imports.map((entry) => [entry.kind, entry.spec, entry.resolvedPath]),
			).toEqual([
				[
					"import",
					"./foo",
					relative(process.cwd(), join(tempDir, "src", "foo.ts")).replace(
						/\\/g,
						"/",
					),
				],
				[
					"import",
					"./shared/bar",
					relative(
						process.cwd(),
						join(tempDir, "src", "shared", "bar.ts"),
					).replace(/\\/g, "/"),
				],
				[
					"import",
					"./pkg",
					relative(
						process.cwd(),
						join(tempDir, "src", "pkg", "index.ts"),
					).replace(/\\/g, "/"),
				],
				["import", "lodash", undefined],
				[
					"export",
					"./pkg",
					relative(
						process.cwd(),
						join(tempDir, "src", "pkg", "index.ts"),
					).replace(/\\/g, "/"),
				],
				["export", "express", undefined],
			]);
		});
	});

	describe("splitIntoChunks() with inline sources", () => {
		it("classifies import-only chunks as imports", () => {
			const parsed = parseInline(
				"inline/imports.ts",
				[
					'import { readFile } from "node:fs";',
					'import path from "node:path";',
					'export { something } from "./other";',
				].join("\n"),
			);

			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 200 });
			expect(chunks).toHaveLength(1);
			expect(chunks[0].metadata?.chunkType).toBe("imports");
			expect(chunks[0].metadata?.primarySymbol).toBeUndefined();
		});

		it("classifies type declaration chunks as types", () => {
			const parsed = parseInline(
				"inline/types.ts",
				[
					"export interface User {",
					"\tid: string;",
					"}",
					"export type UserId = string;",
					"export enum Role { Admin, User }",
				].join("\n"),
			);

			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 200 });
			expect(chunks).toHaveLength(1);
			expect(chunks[0].metadata?.chunkType).toBe("types");
			expect(chunks[0].metadata?.primarySymbol).toBe("User");
		});

		it("classifies implementation chunks as impl", () => {
			const parsed = parseInline(
				"inline/impl.ts",
				[
					"export function runTask(value: number) {",
					"\treturn value * 2;",
					"}",
				].join("\n"),
			);

			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 120 });
			expect(chunks).toHaveLength(1);
			expect(chunks[0].metadata?.chunkType).toBe("impl");
			expect(chunks[0].metadata?.primarySymbol).toBe("runTask");
		});

		it("splits oversized segments into overlapping chunks", () => {
			const bodyLines = Array.from(
				{ length: 40 },
				(_, index) =>
					`  const line${index} = "${"x".repeat(24)}${String(index).padStart(2, "0")}";`,
			);
			const parsed = parseInline(
				"inline/oversized.ts",
				[
					"export function giantFunction() {",
					...bodyLines,
					"  return line0;",
					"}",
				].join("\n"),
			);

			const chunks = plugin.splitIntoChunks(parsed, {
				targetTokens: 30,
				maxTokens: 40,
			});

			expect(chunks.length).toBeGreaterThan(1);
			for (const chunk of chunks) {
				expect(chunk.estimatedTokens).toBeLessThanOrEqual(40);
				expect(chunk.metadata?.chunkType).toBe("impl");
			}
			for (let index = 1; index < chunks.length; index++) {
				expect(chunks[index].range.startLine).toBeLessThanOrEqual(
					chunks[index - 1].range.endLine,
				);
			}
		});

		it("merges many small segments into a larger chunk", () => {
			const parsed = parseInline(
				"inline/merged.ts",
				Array.from(
					{ length: 8 },
					(_, index) => `const value${index} = ${index};`,
				).join("\n"),
			);

			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 80 });
			expect(chunks).toHaveLength(1);
			expect(chunks[0].content).toContain("const value0 = 0;");
			expect(chunks[0].content).toContain("const value7 = 7;");
			expect(chunks[0].metadata?.primarySymbol).toBe("value0");
		});

		it("returns no chunks for whitespace-only content", () => {
			const parsed = parseInline("inline/blank.ts", "   \n\n\t  \n");
			expect(plugin.splitIntoChunks(parsed, { targetTokens: 80 })).toEqual([]);
		});
	});

	describe("private chunk metadata helpers", () => {
		it("classifyChunkType() distinguishes imports, types, and impl content", () => {
			const classifyChunkType = (plugin as any).classifyChunkType.bind(
				plugin,
			) as (text: string) => string;

			expect(
				classifyChunkType(
					'import fs from "node:fs";\nexport { foo } from "./foo";\nconst bar = require("bar");',
				),
			).toBe("imports");
			expect(
				classifyChunkType("interface A {}\ntype B = string\nenum C { D }\n"),
			).toBe("types");
			expect(
				classifyChunkType("const answer = compute();\nconsole.log(answer);"),
			).toBe("impl");
		});

		it("extractPrimarySymbol() finds declarations, methods, and undefined cases", () => {
			const extractPrimarySymbol = (plugin as any).extractPrimarySymbol.bind(
				plugin,
			) as (text: string) => string | undefined;

			expect(extractPrimarySymbol("function makeThing() {}")).toBe("makeThing");
			expect(extractPrimarySymbol("class Thing {}\nmethod() {}")).toBe("Thing");
			expect(extractPrimarySymbol("interface Person {}")).toBe("Person");
			expect(extractPrimarySymbol("type Identifier = string;")).toBe(
				"Identifier",
			);
			expect(extractPrimarySymbol("enum Role { Admin }")).toBe("Role");
			expect(
				extractPrimarySymbol("handleSubmit(event) {\n\treturn event;\n}"),
			).toBe("handleSubmit");
			expect(extractPrimarySymbol("return 42;")).toBeUndefined();
		});

		it("mergeSegments() flushes overflowing buffers and merges a short final segment when possible", () => {
			const mergeSegments = (plugin as any).mergeSegments.bind(plugin) as (
				segments: Array<{
					text: string;
					range: {
						startLine: number;
						startCol: number;
						endLine: number;
						endCol: number;
					};
					estimatedTokens: number;
				}>,
				targetTokens: number,
				maxTokens: number,
				minTokens: number,
			) => unknown[];

			const overflowed = mergeSegments(
				[
					{
						text: "const first = 1;\n",
						range: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
						estimatedTokens: 20,
					},
					{
						text: "const second = 2;\n",
						range: { startLine: 2, startCol: 0, endLine: 2, endCol: 0 },
						estimatedTokens: 20,
					},
					{
						text: "const third = 3;\n",
						range: { startLine: 3, startCol: 0, endLine: 3, endCol: 0 },
						estimatedTokens: 20,
					},
				],
				50,
				30,
				10,
			);

			expect(overflowed).toHaveLength(3);

			const merged = mergeSegments(
				[
					{
						text: "const first = 1;\n",
						range: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
						estimatedTokens: 20,
					},
					{
						text: "const second = 2;\n",
						range: { startLine: 2, startCol: 0, endLine: 2, endCol: 0 },
						estimatedTokens: 20,
					},
					{
						text: "const tiny = 3;\n",
						range: { startLine: 3, startCol: 0, endLine: 3, endCol: 0 },
						estimatedTokens: 5,
					},
				],
				50,
				50,
				10,
			);

			expect(merged).toHaveLength(1);
			expect(merged[0]).toMatchObject({
				estimatedTokens: 45,
				range: { startLine: 1, endLine: 3 },
			});
		});
	});
});
