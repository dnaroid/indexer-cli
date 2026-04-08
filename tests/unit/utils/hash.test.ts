import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeHash } from "../../../src/utils/hash.js";

describe("computeHash", () => {
	it("returns a 64-character hex hash for a basic string", () => {
		const hash = computeHash("hello world");

		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("is deterministic for the same input", () => {
		expect(computeHash("same input")).toBe(computeHash("same input"));
	});

	it("returns different hashes for different inputs", () => {
		expect(computeHash("hello")).not.toBe(computeHash("world"));
	});

	it("normalizes CRLF line endings before hashing", () => {
		expect(computeHash("hello\r\nworld")).toBe(computeHash("hello\nworld"));
	});

	it("removes BOM characters before hashing", () => {
		expect(computeHash("\uFEFFhello")).toBe(computeHash("hello"));
	});

	it("trims trailing whitespace before hashing", () => {
		expect(computeHash("hello ")).toBe(computeHash("hello"));
		expect(computeHash("hello\t\n")).toBe(computeHash("hello"));
	});

	it("hashes an empty string", () => {
		const expected = createHash("sha256").update("", "utf-8").digest("hex");

		expect(computeHash("")).toBe(expected);
	});

	it("hashes large strings consistently", () => {
		const largeText = "abcdef123456\n".repeat(20_000);
		const hash = computeHash(largeText);

		expect(hash).toMatch(/^[a-f0-9]{64}$/);
		expect(hash).toBe(computeHash(largeText));
	});
});
