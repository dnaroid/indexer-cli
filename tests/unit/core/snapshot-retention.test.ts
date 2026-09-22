import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	withSnapshotReadLease,
	withSnapshotPruneGuard,
} from "../../../src/core/snapshot-retention.js";
import { acquireIndexLock } from "../../../src/core/lock.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "idx-snapshot-lease-"));
	roots.push(root);
	return root;
}

function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let output = "";
		const onData = (chunk: Buffer): void => {
			output += chunk.toString("utf8");
			if (output.split(/\r?\n/).includes(expected)) {
				child.stdout.off("data", onData);
				resolve();
			}
		};
		child.stdout.on("data", onData);
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`reader exited before ${expected}: ${code}; ${output}`)));
	});
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`reader exited: ${code}`)));
	});
}

function startReader(projectRoot: string): ChildProcessWithoutNullStreams {
	const retentionModule = path.resolve("src/core/snapshot-retention.ts");
	const script = `
		const { withSnapshotReadLease } = require(${JSON.stringify(retentionModule)});
		void (async () => {
			await withSnapshotReadLease(process.env.PROJECT_ROOT, async () => {
				process.stdout.write("lease-acquired\\n");
				await new Promise((resolve) => process.stdin.once("data", resolve));
			});
		})().catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
	`;
	return spawn(process.execPath, ["--import", "tsx", "--input-type=commonjs", "-e", script], {
		env: { ...process.env, PROJECT_ROOT: projectRoot },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function tryAcquireIndexLockInChild(projectRoot: string): Promise<boolean> {
	const lockModule = path.resolve("src/core/lock.ts");
	const script = `
		const { acquireIndexLock } = require(${JSON.stringify(lockModule)});
		void (async () => {
			try {
				const release = await acquireIndexLock(process.env.PROJECT_ROOT);
				await release();
				process.stdout.write("acquired\\n");
			} catch {
				process.stdout.write("blocked\\n");
			}
		})().catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
	`;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=commonjs", "-e", script], {
			env: { ...process.env, PROJECT_ROOT: projectRoot },
		});
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) reject(new Error(`lock child exited ${code}: ${output}`));
			else resolve(output.includes("acquired"));
		});
	});
}

describe("snapshot retention", () => {
	it("defers pruning for a separately running production reader lease, then collects after release", async () => {
		const projectRoot = await createRoot();
		const reader = startReader(projectRoot);
		try {
			await waitForLine(reader, "lease-acquired");
			let deleted = false;
			await withSnapshotPruneGuard(projectRoot, async () => { deleted = true; });
			expect(deleted).toBe(false);

			const exited = waitForExit(reader);
			reader.stdin.end("release\n");
			await exited;
			await withSnapshotPruneGuard(projectRoot, async () => { deleted = true; });
			expect(deleted).toBe(true);
		} finally {
			if (!reader.killed) reader.kill("SIGKILL");
		}
	});

	it("recovers an incomplete owned lease after its reader crashes", async () => {
		const projectRoot = await createRoot();
		const leases = path.join(projectRoot, ".indexer-cli", "snapshot-reader-leases");
		await mkdir(leases, { recursive: true });
		const reader = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"]);
		try {
			await writeFile(path.join(leases, `${reader.pid}-00000000-0000-4000-8000-000000000000.json`), "{", "utf8");
			reader.kill("SIGKILL");
			await new Promise<void>((resolve) => reader.once("exit", () => resolve()));
			let deleted = false;
			await withSnapshotPruneGuard(projectRoot, async () => { deleted = true; });
			expect(deleted).toBe(true);
		} finally {
			if (!reader.killed) reader.kill("SIGKILL");
		}
	});

	it("keeps malformed foreign leases conservative", async () => {
		const projectRoot = await createRoot();
		const leases = path.join(projectRoot, ".indexer-cli", "snapshot-reader-leases");
		await mkdir(leases, { recursive: true });
		await writeFile(path.join(leases, "foreign.json"), "{", "utf8");
		let deleted = false;
		await withSnapshotPruneGuard(projectRoot, async () => { deleted = true; });
		expect(deleted).toBe(false);
	});

	it.each([
		["read lease", (root: string) => withSnapshotReadLease(root, async () => undefined)],
		["prune guard", (root: string) => withSnapshotPruneGuard(root, async () => undefined)],
	])("preserves an outer index lock while using the %s", async (_name, enterGuard) => {
		const projectRoot = await createRoot();
		await mkdir(path.join(projectRoot, ".indexer-cli"), { recursive: true });
		const release = await acquireIndexLock(projectRoot);
		try {
			await enterGuard(projectRoot);
			expect(await tryAcquireIndexLockInChild(projectRoot)).toBe(false);
		} finally {
			await release();
		}

		expect(await tryAcquireIndexLockInChild(projectRoot)).toBe(true);
		const subsequentRelease = await acquireIndexLock(projectRoot);
		await subsequentRelease();
	});
});
