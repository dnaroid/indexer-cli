import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { writeKnowledgeIndexConfigArtifact } from "../../../src/knowledge/embedding.js";

const indexProject = vi.fn();
let mutateDuringIndex = false;

vi.mock("../../../src/embedding/ollama.js", () => ({
	OllamaEmbeddingProvider: class {
		async initialize(): Promise<void> {}
		async close(): Promise<void> {}
	},
}));

vi.mock("../../../src/engine/indexer.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/engine/indexer.js")>();
	return {
		...original,
		IndexerEngine: class {
			constructor(private readonly options: { metadata: any; repoRoot: string }) {}
			indexProject = indexProject.mockImplementation(async () => {
				const headCommit = (
					await execFileAsync("git", ["-C", this.options.repoRoot, "rev-parse", "HEAD"])
				).stdout.trim();
				const snapshot = await this.options.metadata.createSnapshot("default", { headCommit });
				await writeKnowledgeIndexConfigArtifact(this.options.metadata, "default", snapshot.id);
				await this.options.metadata.updateSnapshotStatus(snapshot.id, "completed");
				if (mutateDuringIndex) {
					await writeFile(path.join(repoRootForIndex, "tracked.ts"), "export const value = 2;\n");
				}
				return { snapshotId: snapshot.id, filesIndexed: 1, errors: [] };
			});
		},
	};
});

const { ensureIndexed } = await import("../../../src/cli/commands/ensure-indexed.js");
const { SqliteMetadataStore } = await import("../../../src/storage/sqlite.js");

const execFileAsync = promisify(execFile);
let repoRootForIndex = "";

describe("ensureIndexed post-index freshness", () => {
	it("reports updated, then noop, when the completed snapshot remains current", async () => {
		const repoRoot = await mkdtemp(path.join(tmpdir(), "idx-ensure-freshness-"));
		repoRootForIndex = repoRoot;
		await mkdir(path.join(repoRoot, ".indexer-cli"), { recursive: true });
		const metadata = new SqliteMetadataStore(path.join(repoRoot, ".indexer-cli", "db.sqlite"));
		try {
			await writeFile(path.join(repoRoot, "tracked.ts"), "export const value = 1;\n");
			await execFileAsync("git", ["init", "-q", repoRoot]);
			await execFileAsync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
			await execFileAsync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
			await execFileAsync("git", ["-C", repoRoot, "add", "tracked.ts"]);
			await execFileAsync("git", ["-C", repoRoot, "commit", "-qm", "initial"]);
			await metadata.initialize();

			await expect(ensureIndexed(metadata, repoRoot, { silent: true })).resolves.toMatchObject({ status: "updated" });
			await expect(ensureIndexed(metadata, repoRoot, { silent: true })).resolves.toMatchObject({ status: "noop" });
			expect(indexProject).toHaveBeenCalledTimes(1);
		} finally {
			await metadata.close();
			await rm(repoRoot, { recursive: true, force: true });
			indexProject.mockReset();
		}
	});

	it("reports a stale result when files change during one indexing pass", async () => {
		const repoRoot = await mkdtemp(path.join(tmpdir(), "idx-ensure-freshness-"));
		repoRootForIndex = repoRoot;
		await mkdir(path.join(repoRoot, ".indexer-cli"), { recursive: true });
		const metadata = new SqliteMetadataStore(path.join(repoRoot, ".indexer-cli", "db.sqlite"));
		try {
			await writeFile(path.join(repoRoot, "tracked.ts"), "export const value = 1;\n");
			await execFileAsync("git", ["init", "-q", repoRoot]);
			await execFileAsync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
			await execFileAsync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
			await execFileAsync("git", ["-C", repoRoot, "add", "tracked.ts"]);
			await execFileAsync("git", ["-C", repoRoot, "commit", "-qm", "initial"]);
			await metadata.initialize();
			mutateDuringIndex = true;

			await expect(ensureIndexed(metadata, repoRoot, { silent: true })).resolves.toMatchObject({
				status: "stale",
				reason: "files-changed-during-index",
			});
			expect(indexProject).toHaveBeenCalledTimes(1);
		} finally {
			await metadata.close();
			await rm(repoRoot, { recursive: true, force: true });
			indexProject.mockReset();
			mutateDuringIndex = false;
		}
	});
});
