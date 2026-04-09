import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
	return readFileSync(path.resolve(__dirname, relativePath), "utf8");
}

describe("CLI output flag contract", () => {
	it("uses --txt instead of --json across output-selecting commands", () => {
		const files = [
			"../../../src/cli/commands/index.ts",
			"../../../src/cli/commands/search.ts",
			"../../../src/cli/commands/structure.ts",
			"../../../src/cli/commands/architecture.ts",
			"../../../src/cli/commands/context.ts",
			"../../../src/cli/commands/explain.ts",
			"../../../src/cli/commands/deps.ts",
		];

		for (const file of files) {
			const source = readSource(file);
			expect(source).toContain('.option("--txt"');
			expect(source).not.toContain("--json");
		}
	});

	it("removes the legacy context --format option", () => {
		const source = readSource("../../../src/cli/commands/context.ts");

		expect(source).not.toContain("--format <format>");
		expect(source).toContain("const isJson = isJsonOutput(options);");
		expect(source).toContain("truncatedDependencies");
	});
});
