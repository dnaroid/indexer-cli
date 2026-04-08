import { describe, expect, it } from "vitest";
import { FunctionLevelChunker } from "../../../src/chunking/function.js";

const chunker = new FunctionLevelChunker();

describe("FunctionLevelChunker", () => {
	it("extracts leading imports into an imports chunk", () => {
		const chunks = chunker.chunk({
			filePath: "src/file.ts",
			content: [
				'import fs from "node:fs";',
				'import { join } from "node:path";',
				"",
				"export function run() {}",
			].join("\n"),
			language: "typescript",
		});

		expect(chunks[0]).toMatchObject({
			type: "imports",
			startLine: 0,
			endLine: 2,
			symbols: [],
		});
		expect(chunks[0].content).toContain('import fs from "node:fs";');
		expect(chunks[0].content).toContain('import { join } from "node:path";');
	});

	it("extracts interfaces and type aliases into a preamble chunk", () => {
		const chunks = chunker.chunk({
			filePath: "src/file.ts",
			content: [
				'import fs from "node:fs";',
				"",
				"interface User {",
				"  id: string;",
				"}",
				"",
				"type UserMap = Record<string, User>;",
				"",
				"export function run() {}",
			].join("\n"),
			language: "typescript",
		});

		expect(chunks[1]).toMatchObject({
			type: "preamble",
			startLine: 0,
			endLine: 7,
			symbols: [],
		});
		expect(chunks[1].content).toContain("interface User");
		expect(chunks[1].content).toContain("type UserMap");
	});

	it("extracts top-level declarations with symbols", () => {
		const chunks = chunker.chunk({
			filePath: "src/file.ts",
			content: [
				"export function greet() {",
				'  return "hi";',
				"}",
				"",
				"const answer = 42;",
				"",
				"namespace Example {",
				"  export const value = answer;",
				"}",
			].join("\n"),
			language: "typescript",
		});

		expect(chunks).toHaveLength(3);
		expect(chunks.map((chunk) => chunk.primarySymbol)).toEqual([
			"greet",
			"answer",
			"Example",
		]);
		expect(chunks.map((chunk) => chunk.symbols)).toEqual([
			["greet"],
			["answer"],
			["Example"],
		]);
		expect(chunks.every((chunk) => chunk.type === "declaration")).toBe(true);
	});

	it("returns no chunks for an empty file", () => {
		expect(
			chunker.chunk({
				filePath: "src/empty.ts",
				content: "",
				language: "typescript",
			}),
		).toEqual([]);
	});

	it("keeps a class and its methods in one declaration chunk", () => {
		const chunks = chunker.chunk({
			filePath: "src/file.ts",
			content: [
				"class Greeter {",
				"  greet() {",
				'    return "hi";',
				"  }",
				"",
				"  part() {",
				'    return "bye";',
				"  }",
				"}",
			].join("\n"),
			language: "typescript",
		});

		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({
			type: "declaration",
			primarySymbol: "Greeter",
			symbols: ["Greeter"],
			startLine: 0,
			endLine: 9,
		});
		expect(chunks[0].content).toContain("greet()");
		expect(chunks[0].content).toContain("part()");
	});

	it("keeps destructured variable declarations even when no primary symbol can be extracted", () => {
		const chunks = chunker.chunk({
			filePath: "src/file.ts",
			content: "const { answer } = source;",
			language: "typescript",
		});

		expect(chunks).toEqual([
			{
				content: "const { answer } = source;",
				startLine: 0,
				endLine: 1,
				type: "declaration",
				primarySymbol: undefined,
				symbols: [],
			},
		]);
	});
});
