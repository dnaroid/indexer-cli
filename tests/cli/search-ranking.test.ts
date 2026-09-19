import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createTempProject,
	gitInit,
	removeTempProject,
	runCLI,
} from "../helpers/cli-runner";

type ParsedSearchResult = {
	filePath: string;
	score: number;
	mode: string;
};

function parseResults(output: string): ParsedSearchResult[] {
	return output
		.split(/\r?\n/)
		.map((line) => {
			const match = line.match(
				/^(.+?):\d+-\d+ \(score: ([\d.]+), rank=([^,)]+)(?:,[^)]*)?\)$/,
			);
			if (!match) return null;
			return { filePath: match[1], score: Number(match[2]), mode: match[3] };
		})
		.filter((result): result is ParsedSearchResult => result !== null);
}

describe.sequential("idx search ranking contract", () => {
	let root = "";

	beforeAll(() => {
		root = mkdtempSync(path.join(os.tmpdir(), "indexer-cli-search-ranking-"));
		removeTempProject(root);
		createTempProject(root);
		gitInit(root);
		const init = runCLI(["init"], { cwd: root });
		expect(
			init.exitCode,
			`init stdout:\n${init.stdout}\ninit stderr:\n${init.stderr}`,
		).toBe(0);
		const index = runCLI(["index"], { cwd: root });
		expect(
			index.exitCode,
			`index stdout:\n${index.stdout}\nindex stderr:\n${index.stderr}`,
		).toBe(0);
	}, 120_000);

	afterAll(() => {
		if (root) removeTempProject(root);
	});

	it("prefers the production definition over an exact-symbol test double", () => {
		const result = runCLI(
			["search", "HybridNeedleIndex", "--max-files", "5", "--min-score", "0"],
			{ cwd: root },
		);
		const results = parseResults(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(results[0]?.filePath).toBe("src/search/hybrid-needle.ts");
		expect(results.every((item) => item.score >= 0 && item.score <= 1)).toBe(true);
		const testIndex = results.findIndex(
			(item) => item.filePath === "tests/search/hybrid-needle.test.ts",
		);
		if (testIndex >= 0) expect(testIndex).toBeGreaterThan(0);
	});

	it("prefers the test double when the query explicitly asks for a test fixture", () => {
		const result = runCLI(
			[
				"search",
				"HybridNeedleIndex test fixture",
				"--max-files",
				"5",
				"--min-score",
				"0",
			],
			{ cwd: root },
		);
		const results = parseResults(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(results[0]?.filePath).toBe("tests/search/hybrid-needle.test.ts");
	});

	it("retrieves lexical-only content at the default threshold", () => {
		const result = runCLI(
			[
				"search",
				"zephyr quartz sentinel",
				"--mode",
				"lexical",
				"--max-files",
				"3",
			],
			{ cwd: root },
		);
		const results = parseResults(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("WARN no-results");
		expect(results[0]?.filePath).toBe("src/search/hybrid-needle.ts");
		expect(results[0]?.mode).toBe("lexical");
		expect(results[0]?.score).toBeGreaterThanOrEqual(0.55);
	});

	it("preserves Cyrillic lexical evidence", () => {
		const result = runCLI(
			[
				"search",
				"восстанавливает геометрию окна подключённый монитор",
				"--mode",
				"lexical",
				"--max-files",
				"3",
			],
			{ cwd: root },
		);
		const results = parseResults(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(results[0]?.filePath).toBe("src/search/window-layout.ts");
	});

	it("uses the symbol index as a standalone retriever for class definitions", () => {
		const result = runCLI(
			[
				"search",
				"HybridNeedleIndex",
				"--mode",
				"symbol",
				"--max-files",
				"3",
			],
			{ cwd: root },
		);
		const results = parseResults(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(results[0]?.filePath).toBe("src/search/hybrid-needle.ts");
		expect(results[0]?.mode).toBe("symbol");
	});

	it("treats an exact project-relative path as first-class hybrid evidence", () => {
		const result = runCLI(
			[
				"search",
				"src/search/hybrid-needle.ts",
				"--max-files",
				"3",
				"--min-score",
				"0",
			],
			{ cwd: root },
		);
		const results = parseResults(result.stdout);
		expect(result.exitCode).toBe(0);
		expect(results[0]?.filePath).toBe("src/search/hybrid-needle.ts");
	});

	it("runs lexical and symbol modes without a live embedding service once the index is current", () => {
		const configPath = path.join(root, ".indexer-cli", "config.json");
		const original = readFileSync(configPath, "utf8");
		const parsed = JSON.parse(original) as Record<string, unknown>;
		parsed.ollamaBaseUrl = "http://127.0.0.1:1";
		writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

		try {
			const lexical = runCLI(
				["search", "zephyr quartz sentinel", "--mode", "lexical"],
				{ cwd: root },
			);
			const symbol = runCLI(
				["search", "HybridNeedleIndex", "--mode", "symbol"],
				{ cwd: root },
			);
			expect(lexical.exitCode).toBe(0);
			expect(lexical.stdout).toContain("src/search/hybrid-needle.ts");
			expect(symbol.exitCode).toBe(0);
			expect(symbol.stdout).toContain("src/search/hybrid-needle.ts");
		} finally {
			writeFileSync(configPath, original, "utf8");
		}
	});
});
