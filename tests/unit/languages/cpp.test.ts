import { describe, expect, it } from "vitest";
import { CppPlugin } from "../../../src/languages/cpp.js";

describe("CppPlugin", () => {
	it("extracts includes and top-level declarations", () => {
		const plugin = new CppPlugin();
		const parsed = plugin.parse({
			path: "src/main.cpp",
			content: [
				'#include "display.h"',
				"#include <Arduino.h>",
				"",
				"struct Item {",
				"  int id;",
				"};",
				"",
				"void setup() {",
				"  initDisplay();",
				"}",
			].join("\n"),
		});

		expect(plugin.extractImports(parsed).map((item) => item.spec)).toEqual([
			"display.h",
			"Arduino.h",
		]);
		expect(plugin.extractSymbols(parsed).map((item) => [item.kind, item.name])).toEqual([
			["struct", "Item"],
			["function", "setup"],
		]);
	});

	it("splits include, type, and implementation chunks", () => {
		const plugin = new CppPlugin();
		const parsed = plugin.parse({
			path: "include/display.h",
			content: [
				"#pragma once",
				"#include <string>",
				"",
				"class Display {",
				"public:",
				"  void render();",
				"};",
			].join("\n"),
		});

		const chunks = plugin.splitIntoChunks(parsed, { targetTokens: 280 });

		expect(chunks.map((chunk) => chunk.metadata?.chunkType)).toEqual([
			"imports",
			"types",
		]);
		expect(chunks[1].content).toContain("class Display");
	});

	it("marks common C++ standard library headers as built-in-style includes", () => {
		const plugin = new CppPlugin();
		expect(plugin.getEntrypoints?.(["src/main.cpp", "src/display.cpp"])).toEqual([
			"src/main.cpp",
		]);
	});
});
