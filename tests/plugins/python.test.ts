import { describe, expect, it } from "vitest";
import { PythonPlugin } from "../../src/languages/python";
import { readFixtureAsSource } from "../helpers/fixture-loader";

const plugin = new PythonPlugin();

const CALCULATOR = "python-basic/src/services/calculator.py";
const MAIN = "python-basic/src/__main__.py";
const MANAGE = "python-basic/manage.py";

describe("PythonPlugin", () => {
	describe("parse()", () => {
		it("returns parsed file with languageId, path, and truthy ast", () => {
			const source = readFixtureAsSource(CALCULATOR);
			const parsed = plugin.parse(source);

			expect(parsed.languageId).toBe("python");
			expect(parsed.path).toBe(CALCULATOR);
			expect(parsed.ast).toBeTruthy();
		});
	});

	describe("calculator.py", () => {
		const source = readFixtureAsSource(CALCULATOR);
		const parsed = plugin.parse(source);

		it("extracts functions add and multiply as exported", () => {
			const symbols = plugin.extractSymbols(parsed);
			const names = symbols.map((s) => s.name);

			expect(names).toContain("add");
			expect(names).toContain("multiply");

			for (const sym of symbols) {
				expect(sym.kind).toBe("function");
				expect(sym.exported).toBe(true);
			}
		});

		it("extracts no imports from calculator.py", () => {
			const imports = plugin.extractImports(parsed);
			expect(imports).toHaveLength(0);
		});

		it("splits into non-empty chunks with valid structure", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 500 });

			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toBe(CALCULATOR);
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.languageId).toBe("python");
				expect(chunk.range.startLine).toBeGreaterThan(0);
			}
		});
	});

	describe("__main__.py", () => {
		const source = readFixtureAsSource(MAIN);
		const parsed = plugin.parse(source);

		it("extracts class App with method run and function bootstrap", () => {
			const symbols = plugin.extractSymbols(parsed);
			const app = symbols.find((s) => s.name === "App");

			expect(app).toBeDefined();
			expect(app!.kind).toBe("class");
			expect(app!.exported).toBe(true);

			const run = symbols.find((s) => s.name === "run");
			expect(run).toBeDefined();
			expect(run!.kind).toBe("method");
			expect(run!.containerName).toBe("App");

			const bootstrap = symbols.find((s) => s.name === "bootstrap");
			expect(bootstrap).toBeDefined();
			expect(bootstrap!.kind).toBe("function");
			expect(bootstrap!.exported).toBe(true);
		});

		it("extracts imports from services.calculator and import os", () => {
			const imports = plugin.extractImports(parsed);
			const specs = imports.map((i) => i.spec);

			expect(specs).toContain("services.calculator");
			expect(specs).toContain("os");

			for (const imp of imports) {
				expect(imp.kind).toBe("import");
			}

			const calcImport = imports.find((i) => i.spec === "services.calculator");
			expect(calcImport).toBeDefined();
			expect(calcImport!.metadata?.imported).toContain("Calculator");
			expect(calcImport!.metadata?.imported).toContain("add");
		});

		it("splits into non-empty chunks with valid structure", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 500 });

			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toBe(MAIN);
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.languageId).toBe("python");
			}
		});
	});

	describe("manage.py", () => {
		const source = readFixtureAsSource(MANAGE);
		const parsed = plugin.parse(source);

		it("extracts import from src.__main__", () => {
			const imports = plugin.extractImports(parsed);
			const specs = imports.map((i) => i.spec);

			expect(specs).toContain("src.__main__");

			for (const imp of imports) {
				expect(imp.kind).toBe("import");
			}

			const mainImport = imports.find((i) => i.spec === "src.__main__");
			expect(mainImport).toBeDefined();
			expect(mainImport!.metadata?.imported).toContain("bootstrap");
		});

		it("splits into non-empty chunks with valid structure", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 500 });

			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toBe(MANAGE);
				expect(chunk.languageId).toBe("python");
			}
		});
	});

	describe("getEntrypoints()", () => {
		it("returns manage.py and __main__.py as entrypoints", () => {
			const files = [
				"python-basic/src/services/calculator.py",
				"python-basic/src/__main__.py",
				"python-basic/manage.py",
			];

			const entrypoints = plugin.getEntrypoints(files);

			expect(entrypoints).toContain("python-basic/src/__main__.py");
			expect(entrypoints).toContain("python-basic/manage.py");
			expect(entrypoints).not.toContain(
				"python-basic/src/services/calculator.py",
			);
		});
	});

	describe("inline helper branches", () => {
		it("detects django, fastapi, and flask in parse metadata and extracts base classes", () => {
			expect(
				plugin.parse({ path: "inline/django.py", content: "import django" })
					.meta?.frameworkHint,
			).toBe("django");
			expect(
				plugin.parse({
					path: "inline/fastapi.py",
					content: "from fastapi import FastAPI",
				}).meta?.frameworkHint,
			).toBe("fastapi");

			const parsed = plugin.parse({
				path: "inline/app.py",
				content: [
					"from flask import Flask",
					"",
					"class Service(BaseOne, BaseTwo):",
					"    pass",
				].join("\n"),
			});

			expect(parsed.meta?.frameworkHint).toBe("flask");
			expect(
				(plugin as any).extractBaseClasses("class Service(BaseOne, BaseTwo):"),
			).toEqual(["BaseOne", "BaseTwo"]);
		});

		it("falls back to the node range when a token cannot be located in the source line", () => {
			const parsed = plugin.parse({
				path: "inline/range.py",
				content: "import os\n",
			});
			const root = (
				(parsed.ast as any).tree.rootNode as {
					namedChildren: Array<any>;
				}
			).namedChildren[0];

			expect(
				(plugin as any).rangeForToken(["import os"], 0, "missing", root),
			).toEqual((plugin as any).rangeFromNode(root));
		});

		it("returns a single fallback chunk when no imports or definitions are present", () => {
			const parsed = plugin.parse({
				path: "inline/fallback.py",
				content: "print('hello')\n",
			});

			expect(plugin.splitIntoChunks(parsed, { targetTokens: 64 })).toEqual([
				expect.objectContaining({
					id: "inline/fallback.py:chunk:1",
					metadata: {
						chunkStrategy: "tree-sitter-single-chunk",
						chunkType: "impl",
					},
				}),
			]);
		});
	});
});
