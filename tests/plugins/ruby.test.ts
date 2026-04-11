import { describe, expect, it } from "vitest";
import { RubyPlugin } from "../../src/languages/ruby";
import { readFixtureAsSource } from "../helpers/fixture-loader";

const plugin = new RubyPlugin();

const CALCULATOR = "ruby-basic/lib/services/calculator.rb";
const APP = "ruby-basic/lib/app.rb";
const CLI = "ruby-basic/bin/app.rb";

describe("RubyPlugin", () => {
	describe("parse()", () => {
		it("returns parsed file with languageId, path, and truthy ast", () => {
			const source = readFixtureAsSource(CALCULATOR);
			const parsed = plugin.parse(source);

			expect(parsed.languageId).toBe("ruby");
			expect(parsed.path).toBe(CALCULATOR);
			expect(parsed.ast).toBeTruthy();
		});
	});

	describe("calculator.rb", () => {
		const source = readFixtureAsSource(CALCULATOR);
		const parsed = plugin.parse(source);

		it("extracts modules, class, instance method, and singleton method", () => {
			const symbols = plugin.extractSymbols(parsed);
			const services = symbols.find((symbol) => symbol.name === "Services");
			const formatter = symbols.find((symbol) => symbol.name === "Formatter");
			const calculator = symbols.find((symbol) => symbol.name === "Calculator");
			const add = symbols.find((symbol) => symbol.name === "add");
			const multiply = symbols.find((symbol) => symbol.name === "multiply");

			expect(services).toMatchObject({ kind: "module", exported: true });
			expect(formatter).toMatchObject({ kind: "module", exported: true });
			expect(calculator).toMatchObject({ kind: "class", exported: true });
			expect(add).toMatchObject({
				kind: "method",
				containerName: "Services::Calculator",
			});
			expect(multiply).toMatchObject({
				kind: "method",
				containerName: "Services::Calculator",
				metadata: { singleton: true },
			});
		});

		it("does not treat extend Formatter as a file import", () => {
			const imports = plugin.extractImports(parsed);
			expect(imports).toEqual([]);
		});

		it("splits into non-empty chunks with valid structure", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 500 });

			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toBe(CALCULATOR);
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.languageId).toBe("ruby");
				expect(chunk.range.startLine).toBeGreaterThan(0);
			}
		});
	});

	describe("app.rb", () => {
		const source = readFixtureAsSource(APP);
		const parsed = plugin.parse(source);

		it("extracts App class with qualified container names", () => {
			const symbols = plugin.extractSymbols(parsed);
			const app = symbols.find((symbol) => symbol.name === "App");
			const run = symbols.find((symbol) => symbol.name === "run");
			const render = symbols.find((symbol) => symbol.name === "render");

			expect(app).toMatchObject({ kind: "class", exported: true });
			expect(run).toMatchObject({
				kind: "method",
				containerName: "RubyBasic::App",
			});
			expect(render).toMatchObject({
				kind: "method",
				containerName: "RubyBasic::App",
			});
		});

		it("extracts require-style imports only", () => {
			const imports = plugin.extractImports(parsed);
			expect(imports).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "require",
						spec: "json",
						metadata: { syntax: "require" },
					}),
					expect.objectContaining({
						kind: "require",
						spec: "services/calculator",
						metadata: { syntax: "require_relative" },
					}),
				]),
			);
			expect(imports).toHaveLength(2);
		});

		it("keeps imports chunk focused on top-level load statements", () => {
			const importsChunk = plugin
				.splitIntoChunks(parsed, { targetTokens: 500 })
				.find((chunk) => chunk.metadata?.chunkType === "imports");

			expect(importsChunk).toMatchObject({
				range: {
					startLine: 1,
					endLine: 2,
				},
			});
			expect(importsChunk?.content).toBe(
				['require "json"', 'require_relative "services/calculator"'].join("\n"),
			);
		});

		it("classifies class/module chunks as types and method chunks as impl", () => {
			const allChunks = plugin.splitIntoChunks(parsed, { targetTokens: 500 });
			const typeChunks = allChunks.filter(
				(chunk) => chunk.metadata?.chunkType === "types",
			);
			const implChunks = allChunks.filter(
				(chunk) => chunk.metadata?.chunkType === "impl",
			);

			expect(typeChunks.length).toBeGreaterThanOrEqual(1);
			expect(implChunks.length).toBeGreaterThanOrEqual(1);
		});

		it("splits into non-empty chunks with valid structure", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 500 });

			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toBe(APP);
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.languageId).toBe("ruby");
			}
		});
	});

	describe("bin/app.rb", () => {
		const source = readFixtureAsSource(CLI);
		const parsed = plugin.parse(source);

		it("extracts require_relative import and CLI.call singleton method", () => {
			const imports = plugin.extractImports(parsed);
			const call = plugin
				.extractSymbols(parsed)
				.find((symbol) => symbol.name === "call");

			expect(imports).toContainEqual(
				expect.objectContaining({
					kind: "require",
					spec: "../lib/app",
					metadata: { syntax: "require_relative" },
				}),
			);
			expect(call).toMatchObject({
				kind: "method",
				containerName: "RubyBasic::CLI",
				metadata: { singleton: true },
			});
		});
	});

	describe("getEntrypoints()", () => {
		it("returns bin and conventional Ruby entrypoint files", () => {
			const files = [
				"ruby-basic/lib/services/calculator.rb",
				"ruby-basic/lib/app.rb",
				"ruby-basic/bin/app.rb",
				"ruby-basic/main.rb",
			];

			const entrypoints = plugin.getEntrypoints(files);

			expect(entrypoints).toContain("ruby-basic/bin/app.rb");
			expect(entrypoints).toContain("ruby-basic/lib/app.rb");
			expect(entrypoints).toContain("ruby-basic/main.rb");
			expect(entrypoints).not.toContain(
				"ruby-basic/lib/services/calculator.rb",
			);
		});
	});

	describe("inline helper branches", () => {
		it("detects Rails and Sinatra metadata and falls back to node ranges", () => {
			expect(
				plugin.parse({
					path: "inline/rails.rb",
					content: "class App < Rails::Application\nend",
				}).meta?.frameworkHint,
			).toBe("rails");
			expect(
				plugin.parse({
					path: "inline/sinatra.rb",
					content: "class App < Sinatra::Base\nend",
				}).meta?.frameworkHint,
			).toBe("sinatra");

			const parsed = plugin.parse({
				path: "inline/range.rb",
				content: 'require "json"\n',
			});
			const root = (
				parsed.ast as {
					tree: { rootNode: { namedChildren: unknown[] } };
				}
			).tree.rootNode.namedChildren[0];

			expect(
				(
					plugin as unknown as {
						rangeForToken: (
							lines: string[],
							lineIndex: number,
							token: string,
							fallbackNode: unknown,
						) => unknown;
					}
				).rangeForToken(['require "json"'], 0, "missing", root),
			).toEqual(
				(
					plugin as unknown as {
						rangeFromNode: (node: unknown) => unknown;
					}
				).rangeFromNode(root),
			);
		});

		it("marks private methods as non-exported", () => {
			const parsed = plugin.parse({
				path: "inline/private.rb",
				content: [
					"class SecretKeeper",
					"  private",
					"",
					"  def token",
					"    :hidden",
					"  end",
					"end",
				].join("\n"),
			});

			const token = plugin
				.extractSymbols(parsed)
				.find((symbol) => symbol.name === "token");

			expect(token).toMatchObject({
				kind: "method",
				exported: false,
				containerName: "SecretKeeper",
				metadata: { visibility: "private" },
			});
		});

		it("returns a single fallback chunk when no imports or definitions are present", () => {
			const parsed = plugin.parse({
				path: "inline/fallback.rb",
				content: "puts 'hello'\n",
			});

			expect(plugin.splitIntoChunks(parsed, { targetTokens: 64 })).toEqual([
				expect.objectContaining({
					id: "inline/fallback.rb:chunk:1",
					metadata: {
						chunkStrategy: "tree-sitter-single-chunk",
						chunkType: "impl",
					},
				}),
			]);
		});
	});
});
