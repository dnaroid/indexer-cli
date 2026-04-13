import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
	return readFileSync(path.resolve(__dirname, relativePath), "utf8");
}

describe("CLI text-only output contract", () => {
	it("does not use --txt, --json, or isJsonOutput in any command", () => {
		const files = [
			"../../../src/cli/commands/index.ts",
			"../../../src/cli/commands/search.ts",
			"../../../src/cli/commands/structure.ts",
			"../../../src/cli/commands/architecture.ts",
			"../../../src/cli/commands/explain.ts",
			"../../../src/cli/commands/deps.ts",
		];

		for (const file of files) {
			const source = readSource(file);
			expect(source).not.toContain('.option("--txt"');
			expect(source).not.toContain("--json");
			expect(source).not.toContain("isJsonOutput");
		}
	});

	it("does not use JSON.stringify in command output paths", () => {
		const files = [
			"../../../src/cli/commands/index.ts",
			"../../../src/cli/commands/search.ts",
			"../../../src/cli/commands/structure.ts",
			"../../../src/cli/commands/architecture.ts",
			"../../../src/cli/commands/explain.ts",
			"../../../src/cli/commands/deps.ts",
		];

		for (const file of files) {
			const source = readSource(file);
			expect(source).not.toContain("console.log(JSON.stringify");
			expect(source).not.toContain("console.error(JSON.stringify");
		}
	});

	it("uses the renamed search --max-files option consistently", () => {
		const source = readSource("../../../src/cli/commands/search.ts");

		expect(source).toContain('.option("--max-files <number>"');
		expect(source).toContain('options?.maxFiles ?? "3"');
		expect(source).not.toContain("options?.topK");
	});
});
