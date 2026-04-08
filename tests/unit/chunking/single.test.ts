import { describe, expect, it } from "vitest";
import { SingleFileChunker } from "../../../src/chunking/single.js";

const chunker = new SingleFileChunker();

describe("SingleFileChunker", () => {
	it("wraps empty content as one full-file chunk", () => {
		const chunks = chunker.chunk({
			filePath: "src/empty.ts",
			content: "",
			language: "typescript",
		});

		expect(chunks).toEqual([
			{
				content: "",
				startLine: 0,
				endLine: 1,
				type: "full_file",
				symbols: [],
			},
		]);
	});

	it("wraps a single line as one full-file chunk", () => {
		const chunks = chunker.chunk({
			filePath: "src/file.ts",
			content: "const value = 1;",
			language: "typescript",
		});

		expect(chunks).toEqual([
			{
				content: "const value = 1;",
				startLine: 0,
				endLine: 1,
				type: "full_file",
				symbols: [],
			},
		]);
	});

	it("uses the full line count as the end line for multi-line content", () => {
		const content = "first line\nsecond line\nthird line";

		const [chunk] = chunker.chunk({
			filePath: "src/file.ts",
			content,
			language: "typescript",
		});

		expect(chunk.content).toBe(content);
		expect(chunk.startLine).toBe(0);
		expect(chunk.endLine).toBe(3);
		expect(chunk.type).toBe("full_file");
		expect(chunk.symbols).toEqual([]);
	});
});
