import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config, DEFAULT_CONFIG } from "../../../src/core/config.js";
import { DEFAULT_PROJECT_ID } from "../../../src/core/types.js";
import { PACKAGE_VERSION } from "../../../src/core/version.js";
import { createIndexProgressReporter } from "../../../src/cli/commands/index.js";
import { filterIndexedChanges } from "../../../src/cli/commands/snapshot-diff.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { computeHash } from "../../../src/utils/hash.js";
import { writeKnowledgeIndexConfigArtifact } from "../../../src/knowledge/embedding.js";
import { runCLI } from "../../helpers/cli-runner.js";
import { gitInit } from "../../helpers/cli-runner.js";

describe("index file counts", () => {
	const roots: string[] = [];
	const mockOllamaUrl = "http://127.0.0.1:1";

	function runWithMockOllama(root: string, ...args: string[]) {
		const preload = join(__dirname, "../../helpers/ollama-fetch-mock.cjs");
		return runCLI(["--no-auto-update", "index", ...args], {
			cwd: root,
			env: {
				NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload}"`].filter(Boolean).join(" "),
			},
		});
	}

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
			count: 4,
		},
		{
			name: "documentation only",
			files: { "README.md": "# Project", "docs/usage.txt": "Usage" },
			count: 3,
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

	it("filters previously indexed dirty code and documents without hiding later changes", async () => {
		const root = createProject({
			".gitignore": ".indexer-cli/\n",
			"src/main.ts": "export const value = 1;\n",
			"docs/guide.md": "# Original\n",
		});
		writeFileSync(join(root, ".indexer-cli/config.json"), JSON.stringify({
			...DEFAULT_CONFIG, version: PACKAGE_VERSION, vectorSize: 3,
			ollamaBaseUrl: mockOllamaUrl,
		}));
		gitInit(root);
		writeFileSync(join(root, "src/main.ts"), "export const value = 2;\n");
		writeFileSync(join(root, "docs/guide.md"), "# Indexed dirty version\n");
		const metadata = new SqliteMetadataStore(join(root, ".indexer-cli", "db.sqlite"));
		config.load(join(root, ".indexer-cli"));
		await metadata.initialize();
		let snapshotId: string;
		try {
			const { execFileSync } = await import("node:child_process");
			const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
			const snapshot = await metadata.createSnapshot(DEFAULT_PROJECT_ID, { headCommit, indexedAt: Date.now() });
			snapshotId = snapshot.id;
			for (const [filePath, content, domain, languageId] of [
				["src/main.ts", "export const value = 2;\n", "code", "typescript"],
				["docs/guide.md", "# Indexed dirty version\n", "document", "document"],
			] as const) {
				await metadata.upsertFile(DEFAULT_PROJECT_ID, {
					snapshotId, path: filePath, domain, languageId,
					sha256: computeHash(content), mtimeMs: 0, size: content.length,
				});
			}
			await writeKnowledgeIndexConfigArtifact(metadata, DEFAULT_PROJECT_ID, snapshotId);
			await metadata.updateSnapshotStatus(snapshotId, "completed");
		} finally {
			await metadata.close();
		}

		const run = (...args: string[]) => runWithMockOllama(root, ...args);
		const repeated = run();
		expect(repeated.exitCode, repeated.stderr).toBe(0);
		expect(repeated.stdout).toContain("Index is already up to date.");
		const emptyPlan = run("--dry-run");
		expect(emptyPlan.exitCode, emptyPlan.stderr).toBe(0);
		expect(emptyPlan.stdout).toContain("Changed total: 0");

		writeFileSync(join(root, "src/main.ts"), "");
		const mixedPlan = run("--dry-run");
		expect(mixedPlan.exitCode, mixedPlan.stderr).toBe(0);
		expect(mixedPlan.stdout).toContain("Modified: 1");
		writeFileSync(join(root, "docs/guide.md"), "");
		const changed = run();
		expect(changed.exitCode, `${changed.stdout}\n${changed.stderr}`).toBe(0);
		expect(changed.stdout).toContain("Files indexed: 2");
		expect(changed.stdout).toContain("src/main.ts");
		expect(changed.stdout).toContain("docs/guide.md");
		const after = new SqliteMetadataStore(join(root, ".indexer-cli", "db.sqlite"));
		await after.initialize();
		const changedSnapshotId = (await after.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID))?.id;
		await after.close();
		expect(changedSnapshotId).not.toBe(snapshotId);
		if (!changedSnapshotId) throw new Error("Incremental index did not create a snapshot");
		const again = run();
		expect(again.exitCode, again.stderr).toBe(0);
		expect(again.stdout).toContain("Index is already up to date.");

		const finalMetadata = new SqliteMetadataStore(join(root, ".indexer-cli", "db.sqlite"));
		await finalMetadata.initialize();
		try {
			expect((await finalMetadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID))?.id).toBe(changedSnapshotId);
			await finalMetadata.upsertArtifact(DEFAULT_PROJECT_ID, {
				projectId: DEFAULT_PROJECT_ID,
				snapshotId: changedSnapshotId,
				artifactType: "knowledge_index_config",
				scope: "project",
				dataJson: JSON.stringify({ fingerprint: "old" }),
			});
		} finally {
			await finalMetadata.close();
		}
		const refreshPlan = run("--dry-run");
		expect(refreshPlan.exitCode, refreshPlan.stderr).toBe(0);
		expect(refreshPlan.stdout).toContain("Modified: 1");
		writeFileSync(join(root, "docs/new.md"), "# New\n");
		rmSync(join(root, "src/main.ts"));
		const addedAndDeleted = run("--dry-run");
		expect(addedAndDeleted.exitCode, addedAndDeleted.stderr).toBe(0);
		expect(addedAndDeleted.stdout).toContain("Added: 1");
		expect(addedAndDeleted.stdout).toContain("Deleted: 1");
		expect(addedAndDeleted.stdout).toContain("Changed total: 3");
	});

	it("indexes ignored included document membership despite already-indexed dirty code", async () => {
		const root = createProject({
			".gitignore": ".indexer-cli/\nignored/\n",
			"src/main.ts": "export const value = 1;\n",
		});
		writeFileSync(join(root, ".indexer-cli/config.json"), JSON.stringify({
			...DEFAULT_CONFIG, version: PACKAGE_VERSION, vectorSize: 3,
			documentIncludePaths: ["ignored/**"],
			ollamaBaseUrl: mockOllamaUrl,
		}));
		gitInit(root);
		const dirtyCode = "export const value = 2;\n";
		writeFileSync(join(root, "src/main.ts"), dirtyCode);
		const metadata = new SqliteMetadataStore(join(root, ".indexer-cli/db.sqlite"));
		config.load(join(root, ".indexer-cli"));
		await metadata.initialize();
		const { execFileSync } = await import("node:child_process");
		const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		const snapshot = await metadata.createSnapshot(DEFAULT_PROJECT_ID, { headCommit, indexedAt: Date.now() });
		await metadata.upsertFile(DEFAULT_PROJECT_ID, {
			snapshotId: snapshot.id, path: "src/main.ts", domain: "code", languageId: "typescript",
			sha256: computeHash(dirtyCode), mtimeMs: 0, size: dirtyCode.length,
		});
		await writeKnowledgeIndexConfigArtifact(metadata, DEFAULT_PROJECT_ID, snapshot.id);
		await metadata.updateSnapshotStatus(snapshot.id, "completed");
		await metadata.close();

		const run = (...args: string[]) => runWithMockOllama(root, ...args);
		expect(run().stdout).toContain("Index is already up to date.");
		mkdirSync(join(root, "ignored"));
		writeFileSync(join(root, "ignored/new.md"), "");
		const addedPlan = run("--dry-run");
		expect(addedPlan.exitCode, addedPlan.stderr).toBe(0);
		expect(addedPlan.stdout).toContain("Added: 1");
		const added = run();
		expect(added.exitCode, `${added.stdout}\n${added.stderr}`).toBe(0);
		expect(added.stdout).toContain("Running incremental index...");
		expect(added.stdout).toContain("Files indexed: 1");
		const afterAdd = new SqliteMetadataStore(join(root, ".indexer-cli/db.sqlite"));
		await afterAdd.initialize();
		const addedId = (await afterAdd.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID))!.id;
		expect((await afterAdd.listFiles(DEFAULT_PROJECT_ID, addedId, { domain: "document" })).map((file) => file.path)).toContain("ignored/new.md");
		await afterAdd.close();

		rmSync(join(root, "ignored/new.md"));
		const deletedPlan = run("--dry-run");
		expect(deletedPlan.exitCode, deletedPlan.stderr).toBe(0);
		expect(deletedPlan.stdout).toContain("Deleted: 1");
		const deleted = run();
		expect(deleted.exitCode, `${deleted.stdout}\n${deleted.stderr}`).toBe(0);
		expect(deleted.stdout).toContain("Running incremental index...");
		const afterDelete = new SqliteMetadataStore(join(root, ".indexer-cli/db.sqlite"));
		await afterDelete.initialize();
		const deletedId = (await afterDelete.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID))!.id;
		expect(await afterDelete.listFiles(DEFAULT_PROJECT_ID, deletedId, { domain: "document" })).toEqual([]);
		await afterDelete.close();
		expect(run().stdout).toContain("Index is already up to date.");

		// Clean Git status must not conceal a new ignored included document either.
		writeFileSync(join(root, "src/main.ts"), "export const value = 1;\n");
		expect(run().exitCode).toBe(0);
		writeFileSync(join(root, "ignored/new.md"), "");
		const cleanAdd = run();
		expect(cleanAdd.exitCode, `${cleanAdd.stdout}\n${cleanAdd.stderr}`).toBe(0);
		expect(cleanAdd.stdout).toContain("Files indexed: 1");
		rmSync(join(root, "ignored/new.md"));
		const cleanDelete = run();
		expect(cleanDelete.exitCode, `${cleanDelete.stdout}\n${cleanDelete.stderr}`).toBe(0);
		expect(cleanDelete.stdout).toContain("Running incremental index...");
	});

	it("keeps root ignore changes only when they alter indexed file selection", async () => {
		const root = createProject({
			".gitignore": ".indexer-cli/\n",
			"docs/guide.md": "# Guide\n",
		});
		config.load(join(root, ".indexer-cli"));
		const metadata = new SqliteMetadataStore(join(root, ".indexer-cli", "db.sqlite"));
		await metadata.initialize();
		try {
			const snapshot = await metadata.createSnapshot(DEFAULT_PROJECT_ID, { indexedAt: Date.now() });
			await metadata.upsertFile(DEFAULT_PROJECT_ID, {
				snapshotId: snapshot.id, path: "docs/guide.md", domain: "document",
				languageId: "document", sha256: computeHash("# Guide\n"), mtimeMs: 0, size: 8,
			});
			const diff = { added: [], modified: [".gitignore"], deleted: [] };
			expect(await filterIndexedChanges(metadata, root, snapshot.id, diff)).toEqual({
				added: [], modified: [], deleted: [],
			});
			writeFileSync(join(root, ".gitignore"), ".indexer-cli/\ndocs/\n");
			expect(await filterIndexedChanges(metadata, root, snapshot.id, diff)).toEqual(diff);
		} finally {
			await metadata.close();
		}
	});
});

describe("index command progress", () => {
	it("prints relative code and document paths for full and incremental callbacks without batch progress duplicates", () => {
		for (const start of [1, 3]) {
			const lines: string[] = [];
			const reporter = createIndexProgressReporter((line) => lines.push(line));
			reporter.onFileStart("src/main.ts", start, 4);
			reporter.onProgress(start, 4);
			reporter.onFileStart("docs/usage.md", start + 1, 4);
			reporter.onProgress(start + 1, 4);
			expect(lines).toEqual([
				`  [${start}/4] src/main.ts`,
				`  [${start + 1}/4] docs/usage.md`,
			]);
		}
	});

	it("prints count-only progress when there are no file starts (copied-only or empty)", () => {
		for (const total of [2, 0]) {
			const lines: string[] = [];
			createIndexProgressReporter((line) => lines.push(line)).onProgress(total, total);
			expect(lines).toEqual([`  ${total}/${total} files...`]);
		}
	});
});
