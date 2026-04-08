import { describe, expect, it } from "vitest";
import {
	LanguagePluginRegistry,
	type ChunkOptions,
	type LanguageCodeChunk,
	type LanguageImport,
	type LanguagePlugin,
	type LanguageSymbol,
	type ParsedFile,
	type SourceFile,
} from "../../../src/languages/plugin.js";

function createMockPlugin(
	id: string,
	fileExtensions: string[],
): LanguagePlugin {
	return {
		id,
		fileExtensions,
		parse(file: SourceFile): ParsedFile {
			return {
				languageId: id,
				path: file.path,
				ast: null,
			};
		},
		extractSymbols(_parsed: ParsedFile): LanguageSymbol[] {
			return [];
		},
		extractImports(_parsed: ParsedFile): LanguageImport[] {
			return [];
		},
		splitIntoChunks(
			_parsed: ParsedFile,
			_opts: ChunkOptions,
		): LanguageCodeChunk[] {
			return [];
		},
	};
}

describe("LanguagePluginRegistry", () => {
	it("registers plugins and lists them in insertion order", () => {
		const registry = new LanguagePluginRegistry();
		const tsPlugin = createMockPlugin("typescript", [".ts", ".tsx"]);
		const pyPlugin = createMockPlugin("python", [".py"]);

		registry.register(tsPlugin);
		registry.register(pyPlugin);

		expect(registry.list()).toEqual([tsPlugin, pyPlugin]);
		expect(registry.getById("typescript")).toBe(tsPlugin);
		expect(registry.getById("python")).toBe(pyPlugin);
	});

	it("registerMany adds multiple plugins", () => {
		const registry = new LanguagePluginRegistry();
		const plugins = [
			createMockPlugin("typescript", [".ts"]),
			createMockPlugin("python", [".py"]),
		];

		registry.registerMany(plugins);

		expect(registry.list()).toEqual(plugins);
	});

	it("throws when registering a duplicate plugin id", () => {
		const registry = new LanguagePluginRegistry();
		registry.register(createMockPlugin("typescript", [".ts"]));

		expect(() => {
			registry.register(createMockPlugin("typescript", [".tsx"]));
		}).toThrow("Language plugin with id 'typescript' is already registered");
	});

	it("finds plugins by file extension using a lowercased path extension", () => {
		const registry = new LanguagePluginRegistry();
		const tsPlugin = createMockPlugin("typescript", [".ts", ".tsx"]);
		const pyPlugin = createMockPlugin("python", [".py"]);

		registry.registerMany([tsPlugin, pyPlugin]);

		expect(registry.findByFilePath("src/component.TSX")).toBe(tsPlugin);
		expect(registry.findByFilePath("src/script.py")).toBe(pyPlugin);
		expect(registry.findByFilePath("src/README.md")).toBeNull();
	});

	it("returns null for unknown plugin ids", () => {
		const registry = new LanguagePluginRegistry();

		expect(registry.getById("missing")).toBeNull();
	});
});
