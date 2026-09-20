import path from "node:path";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { initLogger } from "../../core/logger.js";
import { KnowledgeService } from "../../knowledge/service.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { resolveInitializedProjectRoot } from "../project-root.js";
import { ensureIndexed } from "./ensure-indexed.js";

export interface WikiRuntime {
	projectRoot: string;
	metadata: SqliteMetadataStore;
	service: KnowledgeService;
	snapshotId: string;
	indexWarning?: string;
}

/** Maintenance reads live sources; embedding availability is not a prerequisite. */
export async function withWikiRuntime<T>(
	action: (runtime: WikiRuntime) => Promise<T>,
	options: { refresh?: boolean } = {},
): Promise<T> {
	const resolved = resolveInitializedProjectRoot();
	if (resolved.notice) console.error(resolved.notice);
	const projectRoot = resolved.projectRoot;
	const dataDir = path.join(projectRoot, ".indexer-cli");
	initLogger(dataDir);
	config.load(dataDir);
	const metadata = new SqliteMetadataStore(path.join(dataDir, "db.sqlite"));
	try {
		await metadata.initialize();
		const indexResult = options.refresh
			? await ensureIndexed(metadata, projectRoot, { silent: !process.stderr.isTTY })
			: undefined;
		const snapshot = await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
		if (!snapshot) {
			if (indexResult?.status === "failed") throw new Error(indexResult.reason);
			throw new Error("No completed index snapshot is available. Run idx index first.");
		}
		let indexWarning: string | undefined;
		if (indexResult?.status === "failed" || indexResult?.status === "stale") {
			indexWarning = `Using existing completed index: ${indexResult.reason}`;
			console.error(indexWarning);
		}
		const service = new KnowledgeService(DEFAULT_PROJECT_ID, projectRoot, metadata, metadata);
		return await action({ projectRoot, metadata, service, snapshotId: snapshot.id, indexWarning });
	} finally {
		await metadata.close();
	}
}
