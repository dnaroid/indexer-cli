import { describe, expect, it } from "vitest";
import { GDScriptPlugin } from "../../src/languages/gdscript";
import { readFixtureAsSource } from "../helpers/fixture-loader";

const plugin = new GDScriptPlugin();

const MAIN = "godot-basic/scripts/main.gd";
const GAME_MANAGER = "godot-basic/scripts/game_manager.gd";
const PLAYER_CONTROLLER = "godot-basic/scripts/player_controller.gd";

describe("GDScriptPlugin", () => {
	describe(`fixture: ${MAIN}`, () => {
		const source = readFixtureAsSource(MAIN);
		const parsed = plugin.parse(source);

		it("parse() returns correct structure with frameworkHint", () => {
			expect(parsed.languageId).toBe("gdscript");
			expect(parsed.path).toBe(MAIN);
			expect(parsed.ast).toBeTruthy();
			expect(parsed.meta?.frameworkHint).toBe("godot");
		});

		it("extractSymbols() finds _ready as non-exported function", () => {
			const symbols = plugin.extractSymbols(parsed);

			const ready = symbols.find((s) => s.name === "_ready");
			expect(ready).toBeDefined();
			expect(ready!.kind).toBe("function");
			expect(ready!.exported).toBe(false);
			expect(ready!.filePath).toBe(MAIN);
		});

		it("extractImports() finds extends Node", () => {
			const imports = plugin.extractImports(parsed);

			const ext = imports.find((i) => i.spec === "Node");
			expect(ext).toBeDefined();
			expect(ext!.kind).toBe("import");
		});

		it("splitIntoChunks() returns non-empty chunks with valid structure", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 300 });

			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toBe(MAIN);
				expect(chunk.languageId).toBe("gdscript");
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.range.startLine).toBeGreaterThanOrEqual(1);
				expect(chunk.range.endLine).toBeGreaterThanOrEqual(
					chunk.range.startLine,
				);
			}
		});

		it("separates imports chunk and classifies definitions correctly", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 300 });
			const importChunks = chunks.filter(
				(chunk) => chunk.metadata?.chunkType === "imports",
			);
			const typeChunks = chunks.filter(
				(chunk) => chunk.metadata?.chunkType === "types",
			);
			const implChunks = chunks.filter(
				(chunk) => chunk.metadata?.chunkType === "impl",
			);

			expect(importChunks.length).toBeGreaterThanOrEqual(1);
			expect(typeChunks.length).toBeGreaterThanOrEqual(1);
			expect(implChunks.length).toBeGreaterThanOrEqual(1);

			for (const importChunk of importChunks) {
				expect(importChunk.content).toMatch(/extends\b/);
			}
		});
	});

	describe(`fixture: ${GAME_MANAGER}`, () => {
		const source = readFixtureAsSource(GAME_MANAGER);
		const parsed = plugin.parse(source);

		it("parse() returns correct structure with frameworkHint", () => {
			expect(parsed.languageId).toBe("gdscript");
			expect(parsed.path).toBe(GAME_MANAGER);
			expect(parsed.ast).toBeTruthy();
			expect(parsed.meta?.frameworkHint).toBe("godot");
		});

		it("extractSymbols() finds class_name GameManager and function _ready", () => {
			const symbols = plugin.extractSymbols(parsed);

			const cls = symbols.find((s) => s.name === "GameManager");
			expect(cls).toBeDefined();
			expect(cls!.kind).toBe("class");
			expect(cls!.exported).toBe(true);
			expect(cls!.filePath).toBe(GAME_MANAGER);

			const ready = symbols.find((s) => s.name === "_ready");
			expect(ready).toBeDefined();
			expect(ready!.kind).toBe("function");
			expect(ready!.exported).toBe(false);
		});

		it("extractImports() finds extends Node and preload for player_controller", () => {
			const imports = plugin.extractImports(parsed);

			const ext = imports.find((i) => i.spec === "Node");
			expect(ext).toBeDefined();
			expect(ext!.kind).toBe("import");

			const preload = imports.find((i) => i.kind === "asset_reference");
			expect(preload).toBeDefined();
			expect(preload!.spec).toContain("player_controller");
		});

		it("splitIntoChunks() returns non-empty chunks with valid structure", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 300 });

			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toBe(GAME_MANAGER);
				expect(chunk.languageId).toBe("gdscript");
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.range.startLine).toBeGreaterThanOrEqual(1);
				expect(chunk.range.endLine).toBeGreaterThanOrEqual(
					chunk.range.startLine,
				);
			}
		});
	});

	describe(`fixture: ${PLAYER_CONTROLLER}`, () => {
		const source = readFixtureAsSource(PLAYER_CONTROLLER);
		const parsed = plugin.parse(source);

		it("parse() returns correct structure with frameworkHint", () => {
			expect(parsed.languageId).toBe("gdscript");
			expect(parsed.path).toBe(PLAYER_CONTROLLER);
			expect(parsed.ast).toBeTruthy();
			expect(parsed.meta?.frameworkHint).toBe("godot");
		});

		it("extractSymbols() finds class_name PlayerController", () => {
			const symbols = plugin.extractSymbols(parsed);

			const cls = symbols.find((s) => s.name === "PlayerController");
			expect(cls).toBeDefined();
			expect(cls!.kind).toBe("class");
			expect(cls!.exported).toBe(true);
			expect(cls!.filePath).toBe(PLAYER_CONTROLLER);
		});

		it("extractSymbols() finds signal health_changed", () => {
			const symbols = plugin.extractSymbols(parsed);

			const sig = symbols.find((s) => s.name === "health_changed");
			expect(sig).toBeDefined();
			expect(sig!.kind).toBe("signal");
			expect(sig!.exported).toBe(true);
		});

		it("extractSymbols() finds _ready, _physics_process, apply_damage with correct exported status", () => {
			const symbols = plugin.extractSymbols(parsed);

			const ready = symbols.find((s) => s.name === "_ready");
			expect(ready).toBeDefined();
			expect(ready!.kind).toBe("function");
			expect(ready!.exported).toBe(false);
			expect(ready!.metadata?.lifecycle).toBe(true);

			const physics = symbols.find((s) => s.name === "_physics_process");
			expect(physics).toBeDefined();
			expect(physics!.kind).toBe("function");
			expect(physics!.exported).toBe(false);
			expect(physics!.metadata?.lifecycle).toBe(true);

			const damage = symbols.find((s) => s.name === "apply_damage");
			expect(damage).toBeDefined();
			expect(damage!.kind).toBe("function");
			expect(damage!.exported).toBe(true);
		});

		it("extractImports() finds extends CharacterBody2D and preload for game_manager", () => {
			const imports = plugin.extractImports(parsed);

			const ext = imports.find((i) => i.spec === "CharacterBody2D");
			expect(ext).toBeDefined();
			expect(ext!.kind).toBe("import");

			const preload = imports.find((i) => i.kind === "asset_reference");
			expect(preload).toBeDefined();
			expect(preload!.spec).toContain("game_manager");
		});

		it("splitIntoChunks() returns non-empty chunks with valid structure", () => {
			const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 300 });

			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toBe(PLAYER_CONTROLLER);
				expect(chunk.languageId).toBe("gdscript");
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.range.startLine).toBeGreaterThanOrEqual(1);
				expect(chunk.range.endLine).toBeGreaterThanOrEqual(
					chunk.range.startLine,
				);
			}
		});
	});

	describe("getEntrypoints()", () => {
		it("returns main.gd and game_manager.gd as entrypoints", () => {
			const files = [
				"godot-basic/scripts/main.gd",
				"godot-basic/scripts/game_manager.gd",
				"godot-basic/scripts/player_controller.gd",
				"godot-basic/project.godot",
			];

			const entrypoints = plugin.getEntrypoints(files);

			expect(entrypoints).toContain("godot-basic/scripts/main.gd");
			expect(entrypoints).toContain("godot-basic/scripts/game_manager.gd");
			expect(entrypoints).not.toContain(
				"godot-basic/scripts/player_controller.gd",
			);
			expect(entrypoints).not.toContain("godot-basic/project.godot");
		});
	});

	describe("inline helper branches", () => {
		it("extracts nested class methods with a container name", () => {
			const parsed = plugin.parse({
				path: "inline/nested.gd",
				content: ["class Helper:", "\tfunc act():", "\t\tpass"].join("\n"),
			});

			const act = plugin
				.extractSymbols(parsed)
				.find((symbol) => symbol.name === "act");
			expect(act).toMatchObject({
				kind: "method",
				containerName: "Helper",
			});
		});

		it("returns null when a function signature has no name and falls back to node ranges", () => {
			expect(
				(plugin as any).extractFunctionNameFromSignature(
					"signal value_changed",
				),
			).toBeNull();

			const parsed = plugin.parse({
				path: "inline/range.gd",
				content: 'extends "Node"\n',
			});
			const root = (
				(parsed.ast as any).tree.rootNode as {
					namedChildren: Array<any>;
				}
			).namedChildren[0];

			expect(
				(plugin as any).rangeForToken(
					['extends "Node"'],
					0,
					"MissingType",
					root,
				),
			).toEqual((plugin as any).rangeFromNode(root));
		});

		it("creates type chunks for local class definitions and falls back to a single chunk for plain scripts", () => {
			const classParsed = plugin.parse({
				path: "inline/class.gd",
				content: ["class Helper:", "\tpass"].join("\n"),
			});
			expect(
				plugin.splitIntoChunks(classParsed, { targetTokens: 32 })[0],
			).toMatchObject({
				metadata: {
					chunkType: "types",
					primarySymbol: "Helper",
				},
			});

			const fallbackParsed = plugin.parse({
				path: "inline/plain.gd",
				content: "print('hi')\n",
			});
			expect(
				plugin.splitIntoChunks(fallbackParsed, { targetTokens: 32 }),
			).toEqual([
				expect.objectContaining({
					id: "inline/plain.gd:chunk:1",
					metadata: {
						chunkStrategy: "tree-sitter-single-chunk",
						chunkType: "impl",
					},
				}),
			]);
		});
	});
});
