import { describe, expect, it } from "vitest";
import { AdaptiveChunker } from "../../../src/chunking/adaptive.js";

const chunker = new AdaptiveChunker();

function makeContent(count: number): string {
	return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join(
		"\n",
	);
}

describe("AdaptiveChunker", () => {
	it("returns an empty array for empty content", () => {
		expect(
			chunker.chunk({
				filePath: "src/file.ts",
				content: "",
				language: "typescript",
			}),
		).toEqual([]);
	});

	it("returns an empty array for whitespace-only content", () => {
		expect(
			chunker.chunk({
				filePath: "src/file.ts",
				content: "  \n\t\n  ",
				language: "typescript",
			}),
		).toEqual([]);
	});

	it("returns a full_file chunk for content with 220 lines or fewer", () => {
		const content = makeContent(220);

		expect(
			chunker.chunk({
				filePath: "src/file.ts",
				content,
				language: "python",
			}),
		).toEqual([
			{
				content,
				startLine: 1,
				endLine: 220,
				type: "full_file",
			},
		]);
	});

	it("splits files larger than 220 lines and marks the first chunk as module_section", () => {
		const chunks = chunker.chunk({
			filePath: "src/file.py",
			content: makeContent(221),
			language: "python",
		});

		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toMatchObject({
			startLine: 1,
			endLine: 220,
			type: "module_section",
		});
		expect(chunks[1]).toMatchObject({
			startLine: 201,
			endLine: 221,
			type: "impl",
		});
	});

	it("uses 180-line chunks for typescript files", () => {
		const chunks = chunker.chunk({
			filePath: "src/file.ts",
			content: makeContent(221),
			language: "typescript",
		});

		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toMatchObject({
			startLine: 1,
			endLine: 180,
			type: "module_section",
		});
		expect(chunks[1]).toMatchObject({
			startLine: 161,
			endLine: 221,
			type: "impl",
		});
	});

	it("uses 220-line chunks for non-typescript languages", () => {
		const chunks = chunker.chunk({
			filePath: "src/file.cs",
			content: makeContent(440),
			language: "csharp",
		});

		expect(chunks[0].endLine).toBe(220);
		expect(chunks[1].startLine).toBe(201);
		expect(chunks.slice(1).every((chunk) => chunk.type === "impl")).toBe(true);
	});

	it("skips empty overlapped chunks created from whitespace-only trailing lines", () => {
		const content = [
			...Array.from({ length: 200 }, (_, index) => `line ${index + 1}`),
			...Array.from({ length: 21 }, () => "   \t  "),
		].join("\n");

		const chunks = chunker.chunk({
			filePath: "src/file.py",
			content,
			language: "python",
		});

		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({
			startLine: 1,
			endLine: 220,
			type: "module_section",
		});
	});
});
