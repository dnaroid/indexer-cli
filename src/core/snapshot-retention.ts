import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as lockfile from "proper-lockfile";

const DATA_DIR = ".indexer-cli";
const LEASE_DIR = "snapshot-reader-leases";
const GUARD_FILE = "snapshot-retention.lock";

function paths(projectRoot: string): {
	leaseDir: string;
	guard: string;
} {
	const dataDir = path.join(projectRoot, DATA_DIR);
	return {
		leaseDir: path.join(dataDir, LEASE_DIR),
		guard: path.join(dataDir, GUARD_FILE),
	};
}

async function withGuard<T>(projectRoot: string, action: () => Promise<T>): Promise<T> {
	const { leaseDir, guard } = paths(projectRoot);
	await mkdir(leaseDir, { recursive: true });
	// proper-lockfile tracks in-process ownership by the canonical lock target,
	// not lockfilePath. Use the dedicated existing lease directory so this guard
	// cannot replace an outer index lock whose target is dataDir.
	const release = await lockfile.lock(leaseDir, {
		lockfilePath: guard,
		// Snapshot deletion can be large. Match the index lock's conservative
		// stale threshold while keeping contention failures bounded.
		stale: 10 * 60_000,
		retries: { retries: 50, factor: 1.1, minTimeout: 25, maxTimeout: 200 },
	});
	try {
		return await action();
	} finally {
		await release();
	}
}

function pidIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function ownedLeasePid(filename: string): number | undefined {
	const match = /^(\d+)-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.json$/i.exec(filename);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Registers a cross-process read lease before a completed snapshot is chosen.
 * A publisher holds the same guard while checking leases and deleting snapshots,
 * so it cannot delete the snapshot selected by an in-flight callback.
 */
export async function withSnapshotReadLease<T>(
	projectRoot: string,
	action: () => Promise<T>,
): Promise<T> {
	const { leaseDir } = paths(projectRoot);
	const leasePath = path.join(leaseDir, `${process.pid}-${randomUUID()}.json`);
	await withGuard(projectRoot, async () => {
		await writeFile(leasePath, JSON.stringify({ pid: process.pid }), "utf8");
	});
	try {
		return await action();
	} finally {
		// A concurrent publisher can safely ignore an already removed lease.
		await rm(leasePath, { force: true });
	}
}

/** True when no live reader can still hold a completed snapshot. */
async function noLiveReaderUnderGuard(projectRoot: string): Promise<boolean> {
	const { leaseDir } = paths(projectRoot);
	for (const entry of await readdir(leaseDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const leasePath = path.join(leaseDir, entry.name);
		const filenamePid = ownedLeasePid(entry.name);
		try {
			const lease = JSON.parse(await readFile(leasePath, "utf8")) as { pid?: unknown };
			if (typeof lease.pid === "number" && Number.isSafeInteger(lease.pid) && lease.pid > 0) {
				if (pidIsLive(lease.pid)) return false;
				await rm(leasePath, { force: true });
				continue;
			}
		} catch {
			// A process can die after creating its owned filename and before the
			// JSON write completes. Its PID in that filename is still authoritative.
			if (filenamePid !== undefined && !pidIsLive(filenamePid)) {
				await rm(leasePath, { force: true });
				continue;
			}
		}
		// Foreign or malformed leases without a dead owned PID are conservative.
		return false;
	}
	return true;
}

/** Runs deletion while preventing a reader from registering/selecting a snapshot. */
export async function withSnapshotPruneGuard<T>(
	projectRoot: string,
	action: () => Promise<T>,
): Promise<T | undefined> {
	return withGuard(projectRoot, async () => {
		if (!(await noLiveReaderUnderGuard(projectRoot))) return undefined;
		return action();
	});
}
