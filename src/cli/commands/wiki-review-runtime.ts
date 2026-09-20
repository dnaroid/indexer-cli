import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { SimpleGitOperations } from "../../engine/git.js";
import { KnowledgeImpactEngine } from "../../knowledge/impact.js";
import { knowledgeRelationsHash } from "../../knowledge/service.js";
import type { WikiReviewRuntime } from "./wiki-review.js";
import { withWikiRuntime, type WikiRuntime } from "./wiki-runtime.js";

async function currentHash(root: string, filePath: string): Promise<string | null> {
	try {
		const resolved = await realpath(path.resolve(root, filePath));
		const relative = path.relative(await realpath(root), resolved);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			return "outside-project";
		}
		if (!(await stat(resolved)).isFile()) return "not-a-file";
		return createHash("sha256").update(await readFile(resolved)).digest("hex");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
	}
}

export function wikiReviewRuntime(runtime: WikiRuntime): WikiReviewRuntime {
	return {
		projectId: DEFAULT_PROJECT_ID,
		projectRoot: runtime.projectRoot,
		dbPath: path.join(runtime.projectRoot, ".indexer-cli", "db.sqlite"),
		impact: (options) => new KnowledgeImpactEngine(DEFAULT_PROJECT_ID, runtime.projectRoot,
			runtime.snapshotId, runtime.metadata, runtime.metadata, runtime.service, new SimpleGitOperations()).impact(options),
		contractState: async (paths) => {
			// Request-scoped deduplication: never reuse hashes across review requests.
			const hashes = new Map<string, Promise<string | null>>();
			const hash = (filePath: string) => {
				let pending = hashes.get(filePath);
				if (!pending) { pending = currentHash(runtime.projectRoot, filePath); hashes.set(filePath, pending); }
				return pending;
			};
			const states = await Promise.all(paths.map(async (sourcePath) => {
				const [entry, relations, sourceHash] = await Promise.all([
					runtime.metadata.getKnowledgeEntry(DEFAULT_PROJECT_ID, sourcePath),
					runtime.metadata.listKnowledgeRelations(DEFAULT_PROJECT_ID, { sourcePath }), hash(sourcePath),
				]);
				const inputs = await Promise.all([...new Set(relations.filter((r) => r.targetKind === "code")
					.map((r) => r.targetPath))].sort().map(async (inputPath) => ({ inputPath, hash: await hash(inputPath) })));
				const evidenceHash = createHash("sha256").update(JSON.stringify({ inputs,
					classification: entry?.classification, lifecycle: entry?.lifecycle, behaviorType: entry?.behaviorType,
					metadata: entry?.metadata, receipt: entry?.verificationReceipt })).digest("hex");
				return [sourcePath, { sourceHash, relationsHash: knowledgeRelationsHash(relations), evidenceHash }] as const;
			}));
			return Object.fromEntries(states);
		},
	};
}

export async function withWikiReviewRuntime<T>(action: (runtime: WikiReviewRuntime) => Promise<T>): Promise<T> {
	return withWikiRuntime((runtime) => action(wikiReviewRuntime(runtime)));
}
