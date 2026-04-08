import { describe, expect, it } from "vitest";
import { ModuleLevelChunker } from "../../../src/chunking/module.js";

const chunker = new ModuleLevelChunker();

function makeLines(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

describe("ModuleLevelChunker", () => {
	it("returns a single chunk for a small file", () => {
		const content = makeLines(3).join("\n");

		const chunks = chunker.chunk({
			filePath: "src/file.ts",
			content,
			language: "typescript",
		});

		expect(chunks).toEqual([
			{
				content,
				startLine: 0,
				endLine: 3,
				type: "module_section",
				symbols: [],
			},
		]);
	});

	it("keeps an exact 200-line file in one chunk", () => {
		const content = makeLines(200).join("\n");

		const [chunk] = chunker.chunk({
			filePath: "src/file.ts",
			content,
			language: "typescript",
		});

		expect(chunk.startLine).toBe(0);
		expect(chunk.endLine).toBe(200);
		expect(chunk.content.startsWith("// ...\n")).toBe(false);
	});

	it("splits a 201-line file into overlapping chunks", () => {
		const lines = makeLines(201);
		const chunks = chunker.chunk({
			filePath: "src/file.ts",
			content: lines.join("\n"),
			language: "typescript",
		});

		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toMatchObject({
			startLine: 0,
			endLine: 200,
			type: "module_section",
		});
		expect(chunks[1]).toMatchObject({
			startLine: 180,
			endLine: 201,
			type: "module_section",
		});
		expect(chunks[1].content).toBe(`// ...\n${lines.slice(180).join("\n")}`);
	});

	it("preserves the 20-line overlap between adjacent chunks", () => {
		const lines = makeLines(250);
		const [first, second] = chunker.chunk({
			filePath: "src/file.ts",
			content: lines.join("\n"),
			language: "typescript",
		});

		const firstChunkLines = first.content.split("\n");
		const secondChunkLines = second.content
			.replace(/^\/\/ \.\.\.\n/, "")
			.split("\n");

		expect(firstChunkLines.slice(-20)).toEqual(secondChunkLines.slice(0, 20));
	});

	it("prefixes continuation chunks with a comment marker", () => {
		const chunks = chunker.chunk({
			filePath: "src/file.ts",
			content: makeLines(250).join("\n"),
			language: "typescript",
		});

		expect(chunks[0].content.startsWith("// ...\n")).toBe(false);
		expect(chunks[1].content.startsWith("// ...\n")).toBe(true);
	});
});
