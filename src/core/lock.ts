import path from "node:path";
import * as lockfile from "proper-lockfile";
import type { SqliteMetadataStore } from "../storage/sqlite.js";
import { SystemLogger } from "./logger.js";

const logger = new SystemLogger("lock");

const LOCK_DIR = ".indexer-cli";
const LOCK_FILE = "indexer.lock";

const DEFAULT_STALE_MS = 10 * 60 * 1000;

export async function acquireIndexLock(
	projectRoot: string,
	options?: {
		waitMs?: number;
		retryIntervalMs?: number;
		staleMs?: number;
	},
): Promise<() => Promise<void>> {
	const lockDir = path.join(projectRoot, LOCK_DIR);
	const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;

	const lockOptions: lockfile.LockOptions = {
		stale: staleMs,
		update: 10_000,
		onCompromised: (err: Error) => {
			logger.error(
				"[lock] Lock compromised! Another process may be indexing concurrently.",
				{
					message: err.message,
				},
			);
			process.exit(1);
		},
		retries: options?.waitMs
			? {
					retries: Math.ceil(
						options.waitMs / (options.retryIntervalMs ?? 1000),
					),
					minTimeout: options.retryIntervalMs ?? 1000,
					maxTimeout: options.retryIntervalMs ?? 1000,
				}
			: 0,
	};

	try {
		const release = await lockfile.lock(lockDir, {
			...lockOptions,
			lockfilePath: path.join(lockDir, LOCK_FILE),
		});
		logger.info("[lock] Acquired index lock");
		return release;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Indexing is already in progress by another process. ` +
				`Wait for it to finish. If stale, remove ${LOCK_DIR}/${LOCK_FILE}. ` +
				`(${message})`,
		);
	}
}
export async function getActiveIndexingInfo(
	metadata: SqliteMetadataStore,
	projectId: string,
): Promise<{ snapshotId: string; startedAt: number } | null> {
	const snapshot = await metadata.getLatestSnapshot(projectId);
	if (snapshot?.status === "indexing") {
		return {
			snapshotId: snapshot.id,
			startedAt: snapshot.createdAt,
		};
	}

	return null;
}
