import { describe, expect, it } from "vitest";
import { chunkDocument } from "../../../src/knowledge/document-chunker.js";

describe("chunkDocument", () => {
	it("splits heading-based documents into line-addressable sections", () => {
		const chunks = chunkDocument(
			"docs/auth.md",
			[
				"# Authentication",
				"Intro.",
				"",
				"## Behavior",
				"Refresh retries once.",
				"",
				"## Verification",
				"Test retry success.",
			].join("\n"),
			{ fullFileMaxTokens: 1 },
		);

		const sections = chunks.filter((chunk) => chunk.chunkType === "doc_section");
		expect(sections).toHaveLength(3);
		expect(sections[0]).toMatchObject({
			heading: "Authentication",
			startLine: 1,
			endLine: 3,
		});
		expect(sections[1]).toMatchObject({
			heading: "Behavior",
			startLine: 4,
			endLine: 6,
		});
		expect(sections[2]).toMatchObject({
			heading: "Verification",
			startLine: 7,
			endLine: 8,
		});
	});

	it("supports setext/RST-style headings and no-heading documents", () => {
		const withSetext = chunkDocument(
			"docs/contract.rst",
			"Request contract\n================\n\nCurrent behavior.\n",
		);
		expect(withSetext.some((chunk) => chunk.heading === "Request contract")).toBe(
			true,
		);

		const plain = chunkDocument(
			"notes/capture.txt",
			"Duplicate capture requests return the original result.",
		);
		expect(plain).toHaveLength(1);
		expect(plain[0]).toMatchObject({
			chunkType: "doc_full",
			startLine: 1,
			endLine: 1,
		});
	});

	it("splits oversized sections without losing deterministic line coverage", () => {
		const body = Array.from({ length: 30 }, (_, index) =>
			`Behavior sentence ${index} with enough words to consume tokens.`,
		).join("\n");
		const chunks = chunkDocument("docs/large.md", `# Behavior\n${body}`, {
			maxTokens: 64,
			fullFileMaxTokens: 1,
		});

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0].startLine).toBe(1);
		expect(chunks.at(-1)?.endLine).toBe(31);
		expect(new Set(chunks.map((chunk) => chunk.chunkId)).size).toBe(chunks.length);
	});
});

