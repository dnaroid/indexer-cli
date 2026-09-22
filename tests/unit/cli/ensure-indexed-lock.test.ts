import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ensureIndexed } from "../../../src/cli/commands/ensure-indexed.js";
import { DEFAULT_PROJECT_ID } from "../../../src/core/types.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { writeKnowledgeIndexConfigArtifact } from "../../../src/knowledge/embedding.js";
import { IndexerEngine } from "../../../src/engine/indexer.js";

const execFileAsync = promisify(execFile);

describe("ensureIndexed lock orchestration", () => {
	it("waits for another process, then rechecks snapshots before indexing", async () => {
		const repoRoot = await mkdtemp(path.join(tmpdir(), "idx-ensure-lock-"));
		await mkdir(path.join(repoRoot, ".indexer-cli"), { recursive: true });
		const metadata = new SqliteMetadataStore(
			path.join(repoRoot, ".indexer-cli", "db.sqlite"),
		);
		let child: ReturnType<typeof holdLockInChild> | undefined;
		let indexProject: ReturnType<typeof vi.spyOn> | undefined;
		try {
			await execFileAsync("git", ["init", "-q", repoRoot]);
			await execFileAsync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
			await execFileAsync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
			await writeFile(path.join(repoRoot, "tracked.ts"), "export const version = 1;\n");
			await execFileAsync("git", ["-C", repoRoot, "add", "tracked.ts"]);
			await execFileAsync("git", ["-C", repoRoot, "commit", "-qm", "first"]);
			const firstCommit = (await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"])).stdout.trim();
			await writeFile(path.join(repoRoot, "tracked.ts"), "export const version = 2;\n");
			await execFileAsync("git", ["-C", repoRoot, "commit", "-am", "second"]);
			const secondCommit = (await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"])).stdout.trim();

			await metadata.initialize();
			const firstSnapshot = await metadata.createSnapshot(DEFAULT_PROJECT_ID, { headCommit: firstCommit });
			await writeKnowledgeIndexConfigArtifact(metadata, DEFAULT_PROJECT_ID, firstSnapshot.id);
			await metadata.updateSnapshotStatus(firstSnapshot.id, "completed");
			child = holdLockInChild(repoRoot, 400);
			await child.acquired;
			const latestSnapshot = vi.spyOn(metadata, "getLatestCompletedSnapshot");
			const startedAt = Date.now();

			const ensure = ensureIndexed(metadata, repoRoot, {
				silent: true,
				lockWaitMs: 2_000,
				lockRetryIntervalMs: 50,
			});
			// Allow ensureIndexed to read the old snapshot and begin waiting on the
			// process lock before publishing the replacement snapshot.
			await new Promise((resolve) => setTimeout(resolve, 100));
			const secondSnapshot = await metadata.createSnapshot(DEFAULT_PROJECT_ID, { headCommit: secondCommit });
			await writeKnowledgeIndexConfigArtifact(metadata, DEFAULT_PROJECT_ID, secondSnapshot.id);
			await metadata.updateSnapshotStatus(secondSnapshot.id, "completed");

			indexProject = vi.spyOn(IndexerEngine.prototype, "indexProject");
			await expect(ensure).resolves.toMatchObject({ status: "noop" });
			expect(indexProject).not.toHaveBeenCalled();
			expect(latestSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
			await child.done;
		} finally {
			indexProject?.mockRestore();
			await metadata.close();
			await rm(repoRoot, { recursive: true, force: true });
		}
	}, 10_000);
});

function holdLockInChild(projectRoot: string, holdMs: number): {
	acquired: Promise<void>;
	done: Promise<void>;
} {
	const lockModule = path.resolve("src/core/lock.ts");
	const child = execFile(process.execPath, [
		"--import", "tsx", "--input-type=commonjs", "--eval",
		`const { acquireIndexLock } = require(${JSON.stringify(lockModule)});
void (async () => {
	const release = await acquireIndexLock(${JSON.stringify(projectRoot)});
	console.log("locked");
	setTimeout(async () => { await release(); }, ${holdMs});
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});`,
	]);
	const acquired = new Promise<void>((resolve, reject) => {
		child.stdout?.on("data", (chunk) => {
			if (String(chunk).includes("locked")) resolve();
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) reject(new Error(`Lock child exited ${code}`));
		});
	});
	const done = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`Lock child exited ${code}`));
		});
	});
	return { acquired, done };
}
