import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../src/core/config.js";
import { DEFAULT_PROJECT_ID } from "../../../src/core/types.js";
import { PACKAGE_VERSION } from "../../../src/core/version.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { runCLI } from "../../helpers/cli-runner.js";

describe("index file counts", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createProject(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "idx-cli-file-counts-"));
		roots.push(root);
		for (const [filePath, content] of Object.entries({
			...files,
			".indexer-cli/config.json": JSON.stringify({
				...DEFAULT_CONFIG,
				version: PACKAGE_VERSION,
				vectorSize: 3,
			}),
		})) {
			mkdirSync(dirname(join(root, filePath)), { recursive: true });
			writeFileSync(join(root, filePath), content);
		}
		return root;
	}

	it.each<{
		name: string;
		files: Record<string, string>;
		count: number;
	}>([
		{
			name: "mixed code and documentation",
			files: {
				"src/main.ts": "export const value = 1;",
				"README.md": "# Project",
				"docs/usage.md": "# Usage",
			},
			count: 3,
		},
		{
			name: "documentation only",
			files: { "README.md": "# Project", "docs/usage.txt": "Usage" },
			count: 2,
		},
	])("includes $name in the full dry-run count", async ({ files, count }) => {
		const root = createProject({
			...files,
			".gitignore": "ignored/\n.indexer-cli/\n",
			"ignored/guide.md": "# Ignored documentation",
			"fixtures/guide.md": "# Excluded fixture documentation",
			"image.svg": "<svg />",
		});
		const result = runCLI(["--no-auto-update", "index", "--full", "--dry-run"], {
			cwd: root,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("Mode: full reindex");
		expect(result.stdout).toMatch(new RegExp(`^Files to index: ${count}$`, "m"));

		const metadata = new SqliteMetadataStore(
			join(root, ".indexer-cli", "db.sqlite"),
		);
		await metadata.initialize();
		try {
			expect(await metadata.listSnapshots(DEFAULT_PROJECT_ID)).toEqual([]);
		} finally {
			await metadata.close();
		}
	});

	it("includes documents in the status file count and indexed tree", async () => {
		const root = createProject({});
		const metadata = new SqliteMetadataStore(
			join(root, ".indexer-cli", "db.sqlite"),
		);
		await metadata.initialize();
		try {
			const snapshot = await metadata.createSnapshot(DEFAULT_PROJECT_ID, {
				indexedAt: Date.now(),
			});
			for (const file of [
				{
					path: "src/main.ts",
					languageId: "typescript",
					domain: "code" as const,
				},
				{
					path: "README.md",
					languageId: "document",
					domain: "document" as const,
				},
				{
					path: "docs/usage.md",
					languageId: "document",
					domain: "document" as const,
				},
			]) {
				await metadata.upsertFile(DEFAULT_PROJECT_ID, {
					...file,
					snapshotId: snapshot.id,
					sha256: "fixture",
					mtimeMs: 0,
					size: 1,
				});
			}
			await metadata.updateSnapshotStatus(snapshot.id, "completed");
			await metadata.updateSnapshotProgress(snapshot.id, 3, 3);
		} finally {
			await metadata.close();
		}

		const result = runCLI(["--no-auto-update", "index", "--status", "--tree"], {
			cwd: root,
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/^Files: 3\s+\|/m);
		expect(result.stdout).toContain("document: 2");
		expect(result.stdout).toContain("typescript: 1");
		expect(result.stdout).toContain("README.md");
		expect(result.stdout).toContain("usage.md");
		expect(result.stdout).toContain("main.ts");
	});
});
