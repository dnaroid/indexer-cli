import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GitDiff } from "../../core/types.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { config } from "../../core/config.js";
import { createDefaultLanguagePlugins } from "../../engine/indexer.js";
import { scanProjectFiles } from "../../engine/scanner.js";
import { scanProjectDocuments } from "../../knowledge/document-scanner.js";
import type { SqliteMetadataStore } from "../../storage/sqlite.js";
import { computeHash } from "../../utils/hash.js";

/** Git does not report ignored documents explicitly included by the document scanner. */
export async function documentMembershipChanges(
	metadata: SqliteMetadataStore,
	repoRoot: string,
	snapshotId: string,
): Promise<GitDiff> {
	const [previousFiles, currentPaths] = await Promise.all([
		metadata.listFiles(DEFAULT_PROJECT_ID, snapshotId, { domain: "document" }),
		scanProjectDocuments(repoRoot),
	]);
	const previous = new Set(previousFiles.map((file) => file.path));
	const current = new Set(currentPaths);
	return {
		added: currentPaths.filter((filePath) => !previous.has(filePath)),
		modified: [],
		deleted: [...previous].filter((filePath) => !current.has(filePath)),
	};
}

/** Compare Git candidates with the completed snapshot, not just with HEAD. */
export async function filterIndexedChanges(
	metadata: SqliteMetadataStore,
	repoRoot: string,
	snapshotId: string,
	diff: GitDiff,
): Promise<GitDiff> {
	const [code, documents] = await Promise.all([
		metadata.listFiles(DEFAULT_PROJECT_ID, snapshotId),
		metadata.listFiles(DEFAULT_PROJECT_ID, snapshotId, { domain: "document" }),
	]);
	const records = new Map([...code, ...documents].map((file) => [file.path, file]));
	const hasGitignoreChange = [...diff.added, ...diff.modified, ...diff.deleted].some(
		(filePath) => filePath === ".gitignore",
	);
	let fileSetChanged = false;
	if (hasGitignoreChange) {
		const [currentCode, currentDocuments] = await Promise.all([
			scanProjectFiles(
				repoRoot,
				createDefaultLanguagePlugins().flatMap((plugin) => plugin.fileExtensions),
				{ includePaths: config.get("indexIncludePaths") },
			),
			scanProjectDocuments(repoRoot),
		]);
		const current = new Set([...currentCode, ...currentDocuments]);
		fileSetChanged =
			current.size !== records.size ||
			[...current].some((filePath) => !records.has(filePath));
	}

	async function needsIndex(filePath: string): Promise<boolean> {
		if (filePath === ".gitignore") return fileSetChanged;
		const previous = records.get(filePath);
		if (!previous) return true;
		try {
			const content = await readFile(path.join(repoRoot, filePath), "utf8");
			return computeHash(content) !== previous.sha256;
		} catch {
			// Leave unreadable or missing files to the indexer's normal error/deletion handling.
			return true;
		}
	}

	async function retainChanged(paths: string[]): Promise<string[]> {
		const decisions = await Promise.all(paths.map(needsIndex));
		return paths.filter((_, index) => decisions[index]);
	}

	const [added, modified] = await Promise.all([
		retainChanged(diff.added),
		retainChanged(diff.modified),
	]);
	return {
		added,
		modified,
		deleted: diff.deleted.filter((filePath) =>
			filePath === ".gitignore" ? fileSetChanged : records.has(filePath),
		),
	};
}
