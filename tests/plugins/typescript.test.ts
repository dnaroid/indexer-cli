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
			expect(foo!.signature).toBeDefined();
			expect(foo!.signature).toContain("foo");
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

	describe(`fixture: ${FIXTURE_ADD}`, () => {
		const source = readFixtureAsSource(FIXTURE_ADD);
		const parsed = plugin.parse(source);

		it("parse() returns correct structure", () => {
			expect(parsed).toHaveProperty("languageId", "typescript");
			expect(parsed).toHaveProperty("path", FIXTURE_ADD);
			expect(parsed.ast).toBeTruthy();
		});

		it("extractSymbols() finds exported function add", () => {
			const symbols = plugin.extractSymbols(parsed);
			expect(symbols.length).toBeGreaterThanOrEqual(1);

			const add = symbols.find((s) => s.name === "add");
			expect(add).toBeDefined();
			expect(add!.kind).toBe("function");
			expect(add!.exported).toBe(true);
			expect(add!.filePath).toContain(FIXTURE_ADD);
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
				expect(chunk.filePath).toContain(FIXTURE_ADD);
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

		it("classifies first hybrid import and type chunks as preamble", () => {
			const parsed = parseInline(
				"inline/preamble.ts",
				[
					'import { readFile } from "node:fs/promises";',
					'import path from "node:path";',
					"type GitDiff = { added: string[]; };",
					"type IndexPlan = { ready: boolean; };",
					"const value = readFile;",
				].join("\n"),
			);

			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 200 });
			expect(chunks).toHaveLength(2);
			expect(chunks[0].metadata?.chunkType).toBe("preamble");
			expect(chunks[1].metadata?.chunkType).toBe("impl");
		});

		it("treats bare export lists without a from clause as impl", () => {
			const parsed = parseInline(
				"inline/export-list.ts",
				["const localValue = 1;", "export { localValue };"].join("\n"),
			);

			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 80 });
			expect(chunks).toHaveLength(1);
			expect(chunks[0].metadata?.chunkType).toBe("impl");
		});

		it("treats export type re-exports with from clauses as imports", () => {
			const parsed = parseInline(
				"inline/export-type-reexport.ts",
				['export type { Foo } from "./types";'].join("\n"),
			);

			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 80 });
			expect(chunks).toHaveLength(1);
			expect(chunks[0].metadata?.chunkType).toBe("imports");
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
			expect(chunks[0].metadata?.primarySymbol).toBeUndefined();
		});

		it("does not return local variable as primarySymbol for mid-method chunks", () => {
			const parsed = parseInline(
				"inline/auth.service.ts",
				[
					"class AuthService {",
					"  async resetPassword(user: string, token: string) {",
					"    const existingUser = await this.repo.find(user);",
					"    const resetToken = user.resetToken;",
					"    return existingUser;",
					"  }",
					"}",
				].join("\n"),
			);

			const chunks = plugin.splitIntoChunks(parsed, {
				targetTokens: 40,
				maxTokens: 80,
			});
			for (const chunk of chunks) {
				expect(chunk.metadata?.primarySymbol).not.toBe("existingUser");
				expect(chunk.metadata?.primarySymbol).not.toBe("resetToken");
				expect(chunk.metadata?.primarySymbol).not.toBe("user");
			}
		});

		it("returns no chunks for whitespace-only content", () => {
			const parsed = parseInline("inline/blank.ts", "   \n\n\t  \n");
			expect(plugin.splitIntoChunks(parsed, { targetTokens: 80 })).toEqual([]);
		});
	});

	describe("extractSymbols() signature extraction", () => {
		it("extracts function signature as first line of declaration", () => {
			const parsed = parseInline(
				"inline/sig-func.ts",
				[
					"export async function processData(input: string, opts?: Options): Promise<Result> {",
					"\tconst result = transform(input);",
					"\treturn result;",
					"}",
				].join("\n"),
			);

			const symbols = plugin.extractSymbols(parsed);
			const fn = symbols.find((s) => s.name === "processData");
			expect(fn).toBeDefined();
			expect(fn!.signature).toBe(
				"export async function processData(input: string, opts?: Options): Promise<Result> {",
			);
		});

		it("extracts class signature including opening brace", () => {
			const parsed = parseInline(
				"inline/sig-class.ts",
				[
					"export class SearchEngine {",
					"\tconstructor(private repo: string) {}",
					"\tasync search(query: string): Promise<void> {}",
					"}",
				].join("\n"),
			);

			const symbols = plugin.extractSymbols(parsed);
			const cls = symbols.find(
				(s) => s.name === "SearchEngine" && s.kind === "class",
			);
			expect(cls).toBeDefined();
			expect(cls!.signature).toBe("export class SearchEngine {");
		});

		it("extracts method signature", () => {
			const parsed = parseInline(
				"inline/sig-method.ts",
				[
					"export class Service {",
					"\tpublic async connect(host: string, port: number): Promise<void> {",
					"\t\tawait this.socket.connect(host, port);",
					"\t}",
					"}",
				].join("\n"),
			);

			const symbols = plugin.extractSymbols(parsed);
			const method = symbols.find(
				(s) => s.name === "connect" && s.kind === "method",
			);
			expect(method).toBeDefined();
			expect(method!.signature).toBe(
				"public async connect(host: string, port: number): Promise<void> {",
			);
		});

		it("extracts interface signature", () => {
			const parsed = parseInline(
				"inline/sig-iface.ts",
				[
					"export interface VectorSearchFilters {",
					"\tprojectId: ProjectId;",
					"\tsnapshotId?: SnapshotId;",
					"}",
				].join("\n"),
			);

			const symbols = plugin.extractSymbols(parsed);
			const iface = symbols.find((s) => s.name === "VectorSearchFilters");
			expect(iface).toBeDefined();
			expect(iface!.signature).toBe("export interface VectorSearchFilters {");
		});

		it("extracts type alias signature", () => {
			const parsed = parseInline(
				"inline/sig-type.ts",
				["export type SearchField = (typeof SEARCH_FIELDS)[number];"].join(
					"\n",
				),
			);

			const symbols = plugin.extractSymbols(parsed);
			const ta = symbols.find((s) => s.name === "SearchField");
			expect(ta).toBeDefined();
			expect(ta!.signature).toBe(
				"export type SearchField = (typeof SEARCH_FIELDS)[number];",
			);
		});
	});

	describe("private chunk metadata helpers", () => {
		it("classifyChunkType() distinguishes imports, preamble, types, and impl", () => {
			const classifyChunkType = (
				plugin as unknown as {
					classifyChunkType: (
						statementKinds: Array<"import" | "type" | "impl">,
						isFirstChunk: boolean,
					) => string;
				}
			).classifyChunkType.bind(plugin);

			expect(classifyChunkType(["import", "import"], false)).toBe("imports");
			expect(classifyChunkType(["import", "type"], true)).toBe("preamble");
			expect(classifyChunkType(["type", "type"], false)).toBe("types");
			expect(classifyChunkType(["import", "impl"], true)).toBe("impl");
		});

		it("extractPrimarySymbol() finds declarations, methods, and undefined cases", () => {
			const extractPrimarySymbol = (
				plugin as unknown as {
					extractPrimarySymbol: (text: string) => string | undefined;
				}
			).extractPrimarySymbol.bind(plugin);

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
			const mergeSegments = (
				plugin as unknown as {
					mergeSegments: (
						segments: Array<{
							text: string;
							range: {
								startLine: number;
								startCol: number;
								endLine: number;
								endCol: number;
							};
							estimatedTokens: number;
							statementKinds?: Array<"import" | "type" | "impl">;
						}>,
						targetTokens: number,
						maxTokens: number,
						minTokens: number,
					) => unknown[];
				}
			).mergeSegments.bind(plugin);

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

		it("mergeSegments() keeps a leading preamble separate from implementation", () => {
			const mergeSegments = (
				plugin as unknown as {
					mergeSegments: (
						segments: Array<{
							text: string;
							range: {
								startLine: number;
								startCol: number;
								endLine: number;
								endCol: number;
							};
							estimatedTokens: number;
							statementKinds?: Array<"import" | "type" | "impl">;
						}>,
						targetTokens: number,
						maxTokens: number,
						minTokens: number,
					) => Array<{
						text: string;
						range: { startLine: number; endLine: number };
						statementKinds?: Array<"import" | "type" | "impl">;
					}>;
				}
			).mergeSegments.bind(plugin);

			const merged = mergeSegments(
				[
					{
						text: 'import path from "node:path";\n',
						range: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
						estimatedTokens: 8,
						statementKinds: ["import"],
					},
					{
						text: "type Name = string;\n",
						range: { startLine: 2, startCol: 0, endLine: 2, endCol: 0 },
						estimatedTokens: 6,
						statementKinds: ["type"],
					},
					{
						text: "const value = 1;\n",
						range: { startLine: 3, startCol: 0, endLine: 3, endCol: 0 },
						estimatedTokens: 6,
						statementKinds: ["impl"],
					},
				],
				200,
				200,
				5,
			);

			expect(merged).toHaveLength(2);
			expect(merged[0]).toMatchObject({
				range: { startLine: 1, endLine: 2 },
				statementKinds: ["import", "type"],
			});
			expect(merged[1]).toMatchObject({
				range: { startLine: 3, endLine: 3 },
				statementKinds: ["impl"],
			});
		});
	});
});
