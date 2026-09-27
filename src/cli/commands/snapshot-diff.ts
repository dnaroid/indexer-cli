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
import { matchesPathPatterns } from "../../utils/path-patterns.js";

/**
 * Git cannot report files that `.gitignore` hides but the explicit include masks
 * (`indexIncludePaths` for code, `documentIncludePaths` for documents) bring into
 * the index. Reconcile those paths directly against the completed snapshot so
 * additions, deletions, and content changes are detected the same way for both
 * domains. Paths that Git also reports are harmless duplicates for mergeGitDiffs.
 */
export async function includedPathChanges(
	metadata: Pick<SqliteMetadataStore, "listFiles">,
	repoRoot: string,
	snapshotId: string,
): Promise<GitDiff> {
	const codeIncludes = config.get("indexIncludePaths");
	const documentIncludes = config.get("documentIncludePaths");
	const diff: GitDiff = { added: [], modified: [], deleted: [] };
	if (codeIncludes.length === 0 && documentIncludes.length === 0) return diff;

	const [snapshotCode, snapshotDocuments, currentCode, currentDocuments] =
		await Promise.all([
			codeIncludes.length
				? metadata.listFiles(DEFAULT_PROJECT_ID, snapshotId)
				: Promise.resolve([]),
			documentIncludes.length
				? metadata.listFiles(DEFAULT_PROJECT_ID, snapshotId, { domain: "document" })
				: Promise.resolve([]),
			codeIncludes.length
				? scanProjectFiles(
						repoRoot,
						createDefaultLanguagePlugins().flatMap((plugin) => plugin.fileExtensions),
						{ includePaths: codeIncludes },
					)
				: Promise.resolve([]),
			documentIncludes.length ? scanProjectDocuments(repoRoot) : Promise.resolve([]),
		]);

	const domains = [
		{ includes: codeIncludes, records: snapshotCode, current: currentCode },
		{ includes: documentIncludes, records: snapshotDocuments, current: currentDocuments },
	];
	for (const { includes, records, current } of domains) {
		if (includes.length === 0) continue;
		const previous = new Map(
			records
				.filter((file) => matchesPathPatterns(file.path, includes))
				.map((file) => [file.path, file.sha256]),
		);
		const present = new Set(
			current.filter((filePath) => matchesPathPatterns(filePath, includes)),
		);
		for (const filePath of present) {
			const sha256 = previous.get(filePath);
			if (sha256 === undefined) {
				diff.added.push(filePath);
				continue;
			}
			try {
				const content = await readFile(path.join(repoRoot, filePath), "utf8");
				if (computeHash(content) !== sha256) diff.modified.push(filePath);
			} catch {
				// Unreadable now: let the indexer's normal per-file error handling decide.
				diff.modified.push(filePath);
			}
		}
		for (const filePath of previous.keys()) {
			if (!present.has(filePath)) diff.deleted.push(filePath);
		}
	}

	return {
		added: diff.added.sort(),
		modified: diff.modified.sort(),
		deleted: diff.deleted.sort(),
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
