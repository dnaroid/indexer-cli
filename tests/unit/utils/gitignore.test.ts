import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGitignore } from "../../../src/utils/gitignore.js";

describe("parseGitignore", () => {
	let tempDirs: string[] = [];

	beforeEach(() => {
		tempDirs = [];
	});

	afterEach(() => {
		for (const dir of tempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "indexer-gitignore-test-"),
		);
		tempDirs.push(dir);
		return dir;
	}

	function writeGitignore(dir: string, content: string): void {
		fs.writeFileSync(path.join(dir, ".gitignore"), content, "utf-8");
	}

	it("uses default patterns to ignore node_modules, .git, dist, and related paths", () => {
		const filter = parseGitignore(makeTempDir());

		expect(filter.ignores("node_modules/lodash/index.js")).toBe(true);
		expect(filter.ignores("src/.git/config")).toBe(true);
		expect(filter.ignores("dist/app.js")).toBe(true);
		expect(filter.ignores("coverage/index.html")).toBe(true);
		expect(filter.ignores("src/index.ts")).toBe(false);
	});

	it("loads custom patterns from .gitignore", () => {
		const dir = makeTempDir();
		writeGitignore(dir, "custom-output\nsecrets.txt\n");

		const filter = parseGitignore(dir);

		expect(filter.ignores("custom-output/report.json")).toBe(true);
		expect(filter.ignores("secrets.txt")).toBe(true);
		expect(filter.ignores("safe.txt")).toBe(false);
	});

	it("uses only defaults when .gitignore does not exist", () => {
		const filter = parseGitignore(makeTempDir());

		expect(filter.ignores("package-lock.json")).toBe(true);
		expect(filter.ignores("custom-output/file.txt")).toBe(false);
	});

	it("matches glob patterns such as *.pyc and *.min.js", () => {
		const filter = parseGitignore(makeTempDir());

		expect(filter.ignores("app/main.pyc")).toBe(true);
		expect(filter.ignores("public/app.min.js")).toBe(true);
		expect(filter.ignores("public/app.js")).toBe(false);
	});

	it("matches directory patterns like node_modules and .git", () => {
		const filter = parseGitignore(makeTempDir());

		expect(filter.ignores("node_modules")).toBe(true);
		expect(filter.ignores("node_modules/pkg/index.js")).toBe(true);
		expect(filter.ignores(".git")).toBe(true);
		expect(filter.ignores(".git/hooks/pre-commit")).toBe(true);
	});

	it("skips negation patterns that start with !", () => {
		const dir = makeTempDir();
		writeGitignore(dir, "!keep.js\nignored-dir\n");

		const filter = parseGitignore(dir);

		expect(filter.ignores("keep.js")).toBe(false);
		expect(filter.ignores("ignored-dir/file.txt")).toBe(true);
	});

	it("ignores comment lines and empty lines", () => {
		const dir = makeTempDir();
		writeGitignore(dir, "# comment\n\nlogs\n   \n# another\n");

		const filter = parseGitignore(dir);

		expect(filter.ignores("logs/app.log")).toBe(true);
		expect(filter.ignores("comment")).toBe(false);
	});

	it("matches paths inside subdirectories", () => {
		const dir = makeTempDir();
		writeGitignore(dir, "generated\n");

		const filter = parseGitignore(dir);

		expect(filter.ignores("src/generated/types.ts")).toBe(true);
		expect(filter.ignores("src/runtime/types.ts")).toBe(false);
	});

	it("normalizes Windows-style backslash paths before matching", () => {
		const dir = makeTempDir();
		writeGitignore(dir, "cache\n");

		const filter = parseGitignore(dir);

		expect(filter.ignores("node_modules\\pkg\\index.js")).toBe(true);
		expect(filter.ignores("src\\cache\\value.json")).toBe(true);
		expect(filter.ignores("src\\app\\index.ts")).toBe(false);
	});

	it("returns false for invalid glob patterns instead of throwing", () => {
		const dir = makeTempDir();
		writeGitignore(dir, "[\n");

		const filter = parseGitignore(dir);

		expect(filter.ignores("src/app.ts")).toBe(false);
	});

	it("swallows .gitignore read failures and falls back to default patterns", async () => {
		vi.resetModules();
		vi.doMock("node:fs", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs")>();
			return {
				...actual,
				existsSync: vi.fn(() => true),
				readFileSync: vi.fn(() => {
					throw new Error("permission denied");
				}),
			};
		});

		const { parseGitignore: mockedParseGitignore } = await import(
			"../../../src/utils/gitignore.js"
		);
		const filter = mockedParseGitignore("/repo");

		expect(filter.ignores("node_modules/pkg/index.js")).toBe(true);
		expect(filter.ignores("src/index.ts")).toBe(false);

		vi.doUnmock("node:fs");
		vi.resetModules();
	});
});
