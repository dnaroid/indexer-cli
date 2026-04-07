import { describe, it, expect } from "vitest";
import { TypeScriptPlugin } from "../../../src/languages/typescript.js";
import { readFixtureAsSource } from "../helpers/fixture-loader";

const plugin = new TypeScriptPlugin();

const FIXTURE_INDEX = "typescript-basic/src/index.ts";
const FIXTURE_UTIL = "typescript-basic/src/util.ts";
const FIXTURE_ADD = "typescript-basic/src/math/add.ts";

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
	});
});
