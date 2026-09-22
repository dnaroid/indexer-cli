import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { IndexerEngine } from "../../../src/engine/indexer.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { SqliteVecVectorStore } from "../../../src/storage/vectors.js";

const PROJECT_ID = "snapshot-retention-project" as any;
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function waitForMessage(
	child: ChildProcessWithoutNullStreams,
	predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let output = "";
		const onData = (chunk: Buffer): void => {
			output += chunk.toString("utf8");
			for (const line of output.split(/\r?\n/)) {
				try {
					const message = JSON.parse(line) as Record<string, unknown>;
					if (predicate(message)) {
						child.stdout.off("data", onData);
						resolve(message);
						return;
					}
				} catch {
					// Keep partial lines until the child flushes them.
				}
			}
		};
		child.stdout.on("data", onData);
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`reader exited early: ${code}; ${output}`)));
	});
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`reader exited: ${code}`)));
	});
}

function startSnapshotReader(projectRoot: string): ChildProcessWithoutNullStreams {
	const retention = pathToFileURL(path.resolve("src/core/snapshot-retention.ts")).href;
	const metadata = pathToFileURL(path.resolve("src/storage/sqlite.ts")).href;
	const vectors = pathToFileURL(path.resolve("src/storage/vectors.ts")).href;
	const script = `
		import { withSnapshotReadLease } from ${JSON.stringify(retention)};
		import { SqliteMetadataStore } from ${JSON.stringify(metadata)};
		import { SqliteVecVectorStore } from ${JSON.stringify(vectors)};
		import path from "node:path";
		const root = process.env.PROJECT_ROOT;
		const dbPath = path.join(root, ".indexer-cli", "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		await withSnapshotReadLease(root, async () => {
			const snapshot = await metadata.getLatestCompletedSnapshot(${JSON.stringify(PROJECT_ID)});
			const read = async () => ({
				files: await metadata.listFiles(${JSON.stringify(PROJECT_ID)}, snapshot.id),
				vectors: await vectors.search([1, 0, 0], 10, { projectId: ${JSON.stringify(PROJECT_ID)}, snapshotId: snapshot.id }),
			});
			process.stdout.write(JSON.stringify({ phase: "selected", snapshotId: snapshot.id, ...(await read()) }) + "\\n");
			await new Promise((resolve) => process.stdin.once("data", resolve));
			process.stdout.write(JSON.stringify({ phase: "after-publication", snapshotId: snapshot.id, ...(await read()) }) + "\\n");
		});
		await metadata.close();
		await vectors.close();
	`;
	return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		env: { ...process.env, PROJECT_ROOT: projectRoot },
		stdio: ["pipe", "pipe", "pipe"],
	});
}

describe("IndexerEngine snapshot pruning retention", () => {
	it("retains real selected metadata and vectors for a separate-process reader until release", async () => {
		const projectRoot = await mkdtemp(path.join(tmpdir(), "idx-engine-retention-"));
		roots.push(projectRoot);
		const dbPath = path.join(projectRoot, ".indexer-cli", "db.sqlite");
		await mkdir(path.dirname(dbPath), { recursive: true });
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await metadata.initialize();
		await vectors.initialize();
		try {
			const oldSnapshot = await metadata.createSnapshot(PROJECT_ID, { headCommit: "old", indexedAt: Date.now() });
			await metadata.upsertFile(PROJECT_ID, {
				snapshotId: oldSnapshot.id, path: "src/retained.ts", sha256: "old-hash", mtimeMs: 1, size: 1, languageId: "typescript",
			});
			await vectors.upsert([{
				projectId: PROJECT_ID, snapshotId: oldSnapshot.id, chunkId: "old-chunk", filePath: "src/retained.ts", startLine: 1, endLine: 1, contentHash: "old-hash", embedding: [1, 0, 0],
			}]);
			await metadata.updateSnapshotStatus(oldSnapshot.id, "completed");

			const reader = startSnapshotReader(projectRoot);
			try {
				const selected = await waitForMessage(reader, (message) => message.phase === "selected");
				expect(selected.snapshotId).toBe(oldSnapshot.id);
				expect(selected.files).toHaveLength(1);
				expect(selected.vectors).toHaveLength(1);

				const publisher = new IndexerEngine({
					projectId: PROJECT_ID, repoRoot: projectRoot, metadata, vectors,
					embedder: { id: "fake", initialize: async () => {}, close: async () => {}, getDimension: () => 3, embed: async () => [[1, 0, 0]] },
					git: {} as any,
				});
				const published = await metadata.createSnapshot(PROJECT_ID, { headCommit: "published", indexedAt: Date.now() });
				await metadata.updateSnapshotStatus(published.id, "completed");
				await (publisher as any).pruneHistoricalSnapshots(PROJECT_ID, published.id);
				expect(await metadata.getSnapshot(oldSnapshot.id)).not.toBeNull();
				expect(await vectors.countVectors({ projectId: PROJECT_ID, snapshotId: oldSnapshot.id })).toBe(1);

				const afterPublication = waitForMessage(reader, (message) => message.phase === "after-publication");
				const exited = waitForExit(reader);
				reader.stdin.end("release\n");
				const retained = await afterPublication;
				await exited;
				expect(retained.files).toHaveLength(1);
				expect(retained.vectors).toHaveLength(1);

				const nextPublished = await metadata.createSnapshot(PROJECT_ID, { headCommit: "next", indexedAt: Date.now() });
				await metadata.updateSnapshotStatus(nextPublished.id, "completed");
				await (publisher as any).pruneHistoricalSnapshots(PROJECT_ID, nextPublished.id);
				expect(await metadata.getSnapshot(oldSnapshot.id)).toBeNull();
				expect(await vectors.countVectors({ projectId: PROJECT_ID, snapshotId: oldSnapshot.id })).toBe(0);
			} finally {
				if (!reader.killed) reader.kill("SIGKILL");
			}
		} finally {
			await metadata.close();
			await vectors.close();
		}
	});
});
