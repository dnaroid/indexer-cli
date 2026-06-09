import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireIndexLock,
	getActiveIndexingInfo,
	getIndexLockStatus,
} from "../../../src/core/lock.js";

describe("acquireIndexLock", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(tmpdir(), "indexer-cli-lock-"));
		mkdirSync(path.join(tempDir, ".indexer-cli"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("acquires and releases lock successfully", async () => {
		const release = await acquireIndexLock(tempDir);
		expect(release).toBeTypeOf("function");

		await release();

		const releaseAgain = await acquireIndexLock(tempDir);
		await releaseAgain();
	});

	it("fails when lock is already held", async () => {
		const release = await acquireIndexLock(tempDir);

		try {
			await expect(acquireIndexLock(tempDir, { waitMs: 0 })).rejects.toThrow(
				"Indexing is already in progress",
			);
		} finally {
			await release();
		}
	});

	it("waits and retries when waitMs > 0", async () => {
		const release = await acquireIndexLock(tempDir);
		setTimeout(() => {
			void release();
		}, 500);

		const releaseAfterRetry = await acquireIndexLock(tempDir, {
			waitMs: 5_000,
			retryIntervalMs: 200,
		});

		await releaseAfterRetry();
	});

	it("uses custom staleMs", async () => {
		const release = await acquireIndexLock(tempDir, { staleMs: 60_000 });
		await release();
	});

	it("reports active lock status without taking ownership", async () => {
		const release = await acquireIndexLock(tempDir);

		try {
			const status = await getIndexLockStatus(tempDir);

			expect(status.status).toBe("locked");
			if (status.status === "locked") {
				expect(status.lockPath).toBe(path.join(tempDir, ".indexer-cli", "indexer.lock"));
				expect(status.ageMs).toBeGreaterThanOrEqual(0);
			}
		} finally {
			await release();
		}

		await expect(getIndexLockStatus(tempDir)).resolves.toEqual({
			status: "unlocked",
		});
	});

	it("reports stale lock status from lock mtime", async () => {
		const lockPath = path.join(tempDir, ".indexer-cli", "indexer.lock");
		mkdirSync(lockPath, { recursive: true });
		const oldDate = new Date(Date.now() - 10_000);
		utimesSync(lockPath, oldDate, oldDate);

		const status = await getIndexLockStatus(tempDir, { staleMs: 2_000 });

		expect(status.status).toBe("stale");
		if (status.status === "stale") {
			expect(status.lockPath).toBe(lockPath);
			expect(status.ageMs).toBeGreaterThanOrEqual(2_000);
		}
	});
});

describe("getActiveIndexingInfo", () => {
	it("returns null when no indexing snapshot exists", async () => {
		const metadata = {
			getLatestSnapshot: vi.fn().mockResolvedValue(null),
		} as any;

		const result = await getActiveIndexingInfo(metadata, "project-1");

		expect(result).toBeNull();
	});

	it("returns null when latest snapshot is completed", async () => {
		const metadata = {
			getLatestSnapshot: vi.fn().mockResolvedValue({
				id: "snap-1",
				status: "completed",
				createdAt: Date.now(),
			}),
		} as any;

		const result = await getActiveIndexingInfo(metadata, "project-1");

		expect(result).toBeNull();
	});

	it("returns info when latest snapshot is indexing", async () => {
		const now = Date.now();
		const metadata = {
			getLatestSnapshot: vi.fn().mockResolvedValue({
				id: "snap-active",
				status: "indexing",
				createdAt: now,
			}),
		} as any;

		const result = await getActiveIndexingInfo(metadata, "project-1");

		expect(result).toEqual({
			snapshotId: "snap-active",
			startedAt: now,
		});
	});
});
