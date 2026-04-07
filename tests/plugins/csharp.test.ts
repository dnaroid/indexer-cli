import { describe, it, expect } from "vitest";
import { CSharpPlugin } from "../../../src/languages/csharp";
import { readFixtureAsSource } from "../helpers/fixture-loader";

const plugin = new CSharpPlugin();

const BASE = "unity-csharp-basic";

const FIXTURES = {
	GameManager: `${BASE}/Assets/Scripts/GameManager.cs`,
	PlayerController: `${BASE}/Assets/Scripts/PlayerController.cs`,
	GameConfig: `${BASE}/Assets/Scripts/Config/GameConfig.cs`,
};

describe("CSharpPlugin", () => {
	describe("GameManager.cs", () => {
		const source = readFixtureAsSource(FIXTURES.GameManager);
		const parsed = plugin.parse(source);
		const symbols = plugin.extractSymbols(parsed);
		const imports = plugin.extractImports(parsed);
		const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 500 });

		it("parse returns correct structure", () => {
			expect(parsed.languageId).toBe("csharp");
			expect(parsed.path).toBe(FIXTURES.GameManager);
			expect(parsed.ast).toBeTruthy();
		});

		it("detects unity framework hint", () => {
			expect(parsed.meta?.frameworkHint).toBe("unity");
		});

		it("extracts GameManager class symbol", () => {
			const cls = symbols.find(
				(s) => s.name === "GameManager" && s.kind === "class",
			);
			expect(cls).toBeDefined();
			expect(cls!.exported).toBe(true);
			expect(cls!.metadata?.unityComponent).toBe(true);
			expect(cls!.metadata?.framework).toBe("unity");
		});

		it("extracts Awake method symbol", () => {
			const awake = symbols.find(
				(s) => s.name === "Awake" && s.kind === "method",
			);
			expect(awake).toBeDefined();
			expect(awake!.containerName).toBe("GameManager");
			expect(awake!.exported).toBe(true);
			expect(awake!.metadata?.lifecycle).toBe(true);
		});

		it("extracts using UnityEngine import", () => {
			const usingUnityEngine = imports.find(
				(imp) => imp.spec === "UnityEngine",
			);
			expect(usingUnityEngine).toBeDefined();
			expect(usingUnityEngine!.kind).toBe("using");
		});

		it("splitIntoChunks returns non-empty array", () => {
			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.id).toBeTruthy();
				expect(chunk.filePath).toBe(FIXTURES.GameManager);
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.languageId).toBe("csharp");
			}
		});
	});

	describe("PlayerController.cs", () => {
		const source = readFixtureAsSource(FIXTURES.PlayerController);
		const parsed = plugin.parse(source);
		const symbols = plugin.extractSymbols(parsed);
		const imports = plugin.extractImports(parsed);
		const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 500 });

		it("parse returns correct structure", () => {
			expect(parsed.languageId).toBe("csharp");
			expect(parsed.path).toBe(FIXTURES.PlayerController);
			expect(parsed.ast).toBeTruthy();
		});

		it("detects unity framework hint", () => {
			expect(parsed.meta?.frameworkHint).toBe("unity");
		});

		it("extracts PlayerController class symbol", () => {
			const cls = symbols.find(
				(s) => s.name === "PlayerController" && s.kind === "class",
			);
			expect(cls).toBeDefined();
			expect(cls!.exported).toBe(true);
			expect(cls!.metadata?.unityComponent).toBe(true);
		});

		it("extracts Start method", () => {
			const start = symbols.find(
				(s) => s.name === "Start" && s.kind === "method",
			);
			expect(start).toBeDefined();
			expect(start!.containerName).toBe("PlayerController");
			expect(start!.exported).toBe(true);
			expect(start!.metadata?.lifecycle).toBe(true);
		});

		it("extracts Update method", () => {
			const update = symbols.find(
				(s) => s.name === "Update" && s.kind === "method",
			);
			expect(update).toBeDefined();
			expect(update!.containerName).toBe("PlayerController");
			expect(update!.exported).toBe(true);
			expect(update!.metadata?.lifecycle).toBe(true);
		});

		it("extracts both using directives", () => {
			expect(imports).toHaveLength(2);
			const specs = imports.map((imp) => imp.spec);
			expect(specs).toContain("UnityEngine");
			expect(specs).toContain("UnityEngine.InputSystem");
			for (const imp of imports) {
				expect(imp.kind).toBe("using");
			}
		});

		it("splitIntoChunks returns non-empty array", () => {
			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.filePath).toBe(FIXTURES.PlayerController);
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.languageId).toBe("csharp");
			}
		});
	});

	describe("GameConfig.cs", () => {
		const source = readFixtureAsSource(FIXTURES.GameConfig);
		const parsed = plugin.parse(source);
		const symbols = plugin.extractSymbols(parsed);
		const imports = plugin.extractImports(parsed);
		const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 500 });

		it("parse returns correct structure", () => {
			expect(parsed.languageId).toBe("csharp");
			expect(parsed.path).toBe(FIXTURES.GameConfig);
			expect(parsed.ast).toBeTruthy();
		});

		it("detects unity framework hint", () => {
			expect(parsed.meta?.frameworkHint).toBe("unity");
		});

		it("extracts GameConfig class symbol", () => {
			const cls = symbols.find(
				(s) => s.name === "GameConfig" && s.kind === "class",
			);
			expect(cls).toBeDefined();
			expect(cls!.exported).toBe(true);
			expect(cls!.metadata?.unityComponent).toBe(true);
		});

		it("extracts using UnityEngine import", () => {
			const usingUnityEngine = imports.find(
				(imp) => imp.spec === "UnityEngine",
			);
			expect(usingUnityEngine).toBeDefined();
			expect(usingUnityEngine!.kind).toBe("using");
		});

		it("splitIntoChunks returns non-empty array", () => {
			expect(chunks.length).toBeGreaterThan(0);
			for (const chunk of chunks) {
				expect(chunk.filePath).toBe(FIXTURES.GameConfig);
				expect(chunk.content.length).toBeGreaterThan(0);
				expect(chunk.languageId).toBe("csharp");
			}
		});
	});

	describe("getEntrypoints", () => {
		it("returns GameManager.cs from file list", () => {
			const paths = [
				"Assets/Scripts/GameManager.cs",
				"Assets/Scripts/PlayerController.cs",
				"Assets/Scripts/Config/GameConfig.cs",
			];
			const entrypoints = plugin.getEntrypoints(paths);
			expect(entrypoints).toEqual(["Assets/Scripts/GameManager.cs"]);
		});

		it("returns empty array when no entrypoint files present", () => {
			const paths = ["Assets/Scripts/PlayerController.cs", "Other.cs"];
			const entrypoints = plugin.getEntrypoints(paths);
			expect(entrypoints).toEqual([]);
		});
	});
});
