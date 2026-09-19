import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshCallableSignatureForDisplay } from "../../../src/cli/commands/explain.ts";

describe("refreshCallableSignatureForDisplay", () => {
	it("removes executable bodies from legacy one-line signatures", async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "idx-explain-oneline-"));
		try {
			const declaration = 'export function reveal() { return "body-only"; }';
			writeFileSync(join(repoRoot, "sample.ts"), declaration);
			expect(await refreshCallableSignatureForDisplay(repoRoot, {
				filePath: "sample.ts",
				kind: "function",
				name: "reveal",
				range: {
					start: { line: 1, character: 0 },
					end: { line: 1, character: 0 },
				},
				signature: declaration,
			})).toBe("export function reveal()");
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("does not reinterpret other languages as TypeScript", async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "idx-explain-language-"));
		try {
			writeFileSync(join(repoRoot, "sample.cpp"), "function run(\n  value\n) {}\n");
			expect(await refreshCallableSignatureForDisplay(repoRoot, {
				filePath: "sample.cpp",
				kind: "function",
				name: "run",
				range: {
					start: { line: 1, character: 0 },
					end: { line: 3, character: 0 },
				},
				signature: "function run(",
			})).toBe("function run(");
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});

	it("repairs a legacy multiline callable signature without reindexing", async () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "idx-explain-signature-"));
		try {
			writeFileSync(
				join(repoRoot, "sample.ts"),
				[
					"export async function ensureIndexed(",
					"  repoRoot: string,",
					"  options: { retry: (count: number) => Promise<void> },",
					"): Promise<{ indexed: boolean }> {",
					"  return { indexed: true };",
					"}",
				].join("\n"),
			);

			const signature = await refreshCallableSignatureForDisplay(repoRoot, {
				filePath: "sample.ts",
				kind: "function",
				name: "ensureIndexed",
				range: {
					start: { line: 1, character: 0 },
					end: { line: 6, character: 0 },
				},
				signature: "export async function ensureIndexed(",
			});

			expect(signature).toContain("options: { retry: (count: number) => Promise<void> }");
			expect(signature).toContain("): Promise<{ indexed: boolean }>");
			expect(signature).not.toContain("return { indexed: true }");
		} finally {
			rmSync(repoRoot, { recursive: true, force: true });
		}
	});
});
