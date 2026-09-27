import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { config, DEFAULT_CONFIG } from "../../../src/core/config.js";
import { DEFAULT_PROJECT_ID } from "../../../src/core/types.js";
import { PACKAGE_VERSION } from "../../../src/core/version.js";
import { includedPathChanges } from "../../../src/cli/commands/snapshot-diff.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { computeHash } from "../../../src/utils/hash.js";

describe("includedPathChanges", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function createProject(
		files: Record<string, string>,
		masks: { indexIncludePaths?: string[]; documentIncludePaths?: string[] },
	): string {
		const root = mkdtempSync(join(tmpdir(), "idx-included-changes-"));
		roots.push(root);
		for (const [filePath, content] of Object.entries({
			".gitignore": ".indexer-cli/\ngenerated/\nprivate-docs/\n",
			...files,
			".indexer-cli/config.json": JSON.stringify({
				...DEFAULT_CONFIG, version: PACKAGE_VERSION, vectorSize: 3, ...masks,
			}),
		})) {
			mkdirSync(dirname(join(root, filePath)), { recursive: true });
			writeFileSync(join(root, filePath), content);
		}
		config.load(join(root, ".indexer-cli"));
		return root;
	}

	async function withSnapshot(
		root: string,
		records: Array<{ path: string; content: string; domain: "code" | "document" }>,
		run: (metadata: SqliteMetadataStore, snapshotId: string) => Promise<void>,
	): Promise<void> {
		const metadata = new SqliteMetadataStore(join(root, ".indexer-cli", "db.sqlite"));
		await metadata.initialize();
		try {
			const snapshot = await metadata.createSnapshot(DEFAULT_PROJECT_ID, { indexedAt: Date.now() });
			for (const record of records) {
				await metadata.upsertFile(DEFAULT_PROJECT_ID, {
					snapshotId: snapshot.id, path: record.path, domain: record.domain,
					languageId: record.domain === "document" ? "document" : "typescript",
					sha256: computeHash(record.content), mtimeMs: 0, size: record.content.length,
				});
			}
			await run(metadata, snapshot.id);
		} finally {
			await metadata.close();
		}
	}

	it("reports additions, content changes, and deletions of ignored included code and documents", async () => {
		const root = createProject({
			"generated/same.ts": "export const same = 1;\n",
			"generated/changed.ts": "export const changed = 2;\n",
			"generated/new.ts": "export const fresh = 1;\n",
			"private-docs/same.md": "# Same\n",
			"private-docs/changed.md": "# Changed now\n",
			"private-docs/new.md": "# New\n",
			"src/tracked.ts": "export const tracked = 2;\n",
		}, {
			indexIncludePaths: ["generated/**"],
			documentIncludePaths: ["private-docs/**"],
		});
		await withSnapshot(root, [
			{ path: "generated/same.ts", content: "export const same = 1;\n", domain: "code" },
			{ path: "generated/changed.ts", content: "export const changed = 1;\n", domain: "code" },
			{ path: "generated/removed.ts", content: "export const removed = 1;\n", domain: "code" },
			{ path: "private-docs/same.md", content: "# Same\n", domain: "document" },
			{ path: "private-docs/changed.md", content: "# Changed\n", domain: "document" },
			{ path: "private-docs/removed.md", content: "# Removed\n", domain: "document" },
			// Paths outside the include masks are Git's responsibility.
			{ path: "src/tracked.ts", content: "export const tracked = 1;\n", domain: "code" },
		], async (metadata, snapshotId) => {
			expect(await includedPathChanges(metadata, root, snapshotId)).toEqual({
				added: ["generated/new.ts", "private-docs/new.md"],
				modified: ["generated/changed.ts", "private-docs/changed.md"],
				deleted: ["generated/removed.ts", "private-docs/removed.md"],
			});
		});
	});

	it("does not scan or read the snapshot when no include masks are configured", async () => {
		const root = createProject({ "generated/new.ts": "export const fresh = 1;\n" }, {});
		const metadata = {
			listFiles: async () => { throw new Error("snapshot must not be read"); },
		};
		expect(await includedPathChanges(metadata, root, "snapshot-1")).toEqual({
			added: [], modified: [], deleted: [],
		});
	});
});
