import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../core/config.js";
import type {
	GitDiff,
	GitOperations,
	KnowledgeEntry,
	KnowledgeRelation,
	KnowledgeStore,
	MetadataStore,
	ProjectId,
	SnapshotId,
} from "../core/types.js";
import { mergeGitDiffs } from "../engine/git.js";
import { computeHash } from "../utils/hash.js";
import { documentTitle, knowledgeDiscoverySignals } from "./discovery.js";
import type { KnowledgeSearchResult } from "./search.js";
import {
	PRIMARY_KNOWLEDGE_CLASSIFICATIONS,
	type KnowledgeService,
} from "./service.js";

export interface ImpactKnowledgeSearcher {
	search(
		query: string,
		options?: { limit?: number; includeSecondary?: boolean },
	): Promise<KnowledgeSearchResult[]>;
}

export interface KnowledgeImpactOptions {
	paths?: string[];
	base?: string;
	semanticLimit?: number;
}

export interface KnowledgeImpactResult {
	source: "explicit" | `git:${string}`;
	changes: GitDiff;
	changedPaths: string[];
	knownAffected: Array<{
		path: string;
		matchedChanges: string[];
		status: string;
		reasons: string[];
	}>;
	uncoveredPaths: string[];
	changedDocuments: Array<{
		path: string;
		title: string;
		score: number;
		roleHint: string;
		signals: string[];
		currentHash: string;
		knownClassification?: string;
		knownLifecycle?: string;
		requiresClassification: boolean;
		requiresReclassification: boolean;
	}>;
	missingTrackedSpecs: string[];
	graphContext: Array<{
		path: string;
		imports: string[];
		importedBy: string[];
	}>;
	semanticCandidates: Array<{
		changedPath: string;
		query: string;
		candidates: Array<{
			path: string;
			title: string;
			score: number;
			status: string;
		}>;
	}>;
	semanticSweepRequired: boolean;
	reasons: string[];
}

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function pathOverlaps(changedPath: string, trackedPath: string): boolean {
	const changed = changedPath.replace(/\\/g, "/").replace(/\/+$/, "");
	const tracked = trackedPath.replace(/\\/g, "/").replace(/\/+$/, "");
	return (
		changed === tracked ||
		tracked.startsWith(`${changed}/`) ||
		changed.startsWith(`${tracked}/`)
	);
}

function changedPaths(diff: GitDiff): string[] {
	return uniqueSorted([...diff.added, ...diff.modified, ...diff.deleted]);
}

function normalizeExplicitPath(repoRoot: string, value: string): string {
	const root = path.resolve(repoRoot);
	const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
	const relative = path.relative(root, absolute);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Changed path escapes project root: ${value}`);
	}
	return relative.replace(/\\/g, "/");
}

async function resolveSafeProjectFile(
	repoRoot: string,
	filePath: string,
): Promise<string | null> {
	try {
		const root = await realpath(repoRoot);
		const resolved = await realpath(path.join(root, filePath));
		const relative = path.relative(root, resolved);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
			return null;
		}
		return (await stat(resolved)).isFile() ? resolved : null;
	} catch {
		return null;
	}
}

function isPrimary(entry: KnowledgeEntry): boolean {
	return PRIMARY_KNOWLEDGE_CLASSIFICATIONS.has(entry.classification);
}

function currentEntry(entry: KnowledgeEntry): boolean {
	return entry.lifecycle !== "historical" && entry.lifecycle !== "superseded";
}

function isDocumentPath(filePath: string): boolean {
	return config.get("documentExtensions").includes(path.extname(filePath).toLowerCase());
}

export class KnowledgeImpactEngine {
	constructor(
		private readonly projectId: ProjectId,
		private readonly repoRoot: string,
		private readonly snapshotId: SnapshotId,
		private readonly metadata: MetadataStore,
		private readonly knowledge: KnowledgeStore,
		private readonly service: KnowledgeService,
		private readonly git: GitOperations,
		private readonly searcher?: ImpactKnowledgeSearcher,
	) {}

	async impact(options: KnowledgeImpactOptions = {}): Promise<KnowledgeImpactResult> {
		let diff: GitDiff;
		let source: KnowledgeImpactResult["source"];
		if (options.paths && options.paths.length > 0) {
			const normalized = uniqueSorted(
				options.paths.map((value) => normalizeExplicitPath(this.repoRoot, value)),
			);
			diff = { added: [], modified: normalized, deleted: [] };
			source = "explicit";
		} else {
			const base = options.base ?? "HEAD";
			const [committed, workspace] = await Promise.all([
				this.git.getChangedFiles(this.repoRoot, base),
				this.git.getWorkingTreeChanges(this.repoRoot),
			]);
			diff = mergeGitDiffs(committed, workspace);
			source = `git:${base}`;
		}

		const paths = changedPaths(diff).filter(
			(filePath) =>
				filePath !== ".indexer-cli" && !filePath.startsWith(".indexer-cli/"),
		);
		const [entries, relations] = await Promise.all([
			this.knowledge.listKnowledgeEntries(this.projectId),
			this.knowledge.listKnowledgeRelations(this.projectId),
		]);
		const primaryEntries = entries.filter((entry) => isPrimary(entry) && currentEntry(entry));
		const relationsBySource = new Map<string, KnowledgeRelation[]>();
		for (const relation of relations) {
			const values = relationsBySource.get(relation.sourcePath) ?? [];
			values.push(relation);
			relationsBySource.set(relation.sourcePath, values);
		}

		const knownAffected = [] as KnowledgeImpactResult["knownAffected"];
		const covered = new Set<string>();
		for (const entry of primaryEntries) {
			const trackedPaths = [
				entry.path,
				...(relationsBySource.get(entry.path) ?? [])
					.filter((relation) => relation.targetKind === "code")
					.map((relation) => relation.targetPath),
			];
			const matched = paths.filter((changedPath) =>
				trackedPaths.some((trackedPath) => pathOverlaps(changedPath, trackedPath)),
			);
			if (matched.length === 0) continue;
			matched.forEach((filePath) => covered.add(filePath));
			const status = await this.service.getStatus(entry);
			knownAffected.push({
				path: entry.path,
				matchedChanges: matched,
				status: status.status,
				reasons: status.reasons,
			});
		}

		const changedDocuments: KnowledgeImpactResult["changedDocuments"] = [];
		const documentPaths = new Set<string>();
		for (const filePath of paths) {
			if (!isDocumentPath(filePath)) continue;
			const fullPath = await resolveSafeProjectFile(this.repoRoot, filePath);
			if (!fullPath) continue;
			try {
				const content = await readFile(fullPath, "utf8");
				const discovery = knowledgeDiscoverySignals(filePath, content);
				const existing = entries.find((entry) => entry.path === filePath);
				changedDocuments.push({
					path: filePath,
					title: documentTitle(content, filePath),
					score: discovery.score,
					roleHint: discovery.roleHint,
					signals: discovery.signals,
					currentHash: computeHash(content),
					knownClassification: existing?.classification,
					knownLifecycle: existing?.lifecycle,
					requiresClassification: !existing,
					requiresReclassification: Boolean(
						existing && !PRIMARY_KNOWLEDGE_CLASSIFICATIONS.has(existing.classification),
					),
				});
				documentPaths.add(filePath);
			} catch {
				// Deleted documents are represented by missingTrackedSpecs below.
			}
		}

		const missingTrackedSpecs = uniqueSorted(
			entries
				.filter(isPrimary)
				.filter((entry) => paths.some((filePath) => pathOverlaps(filePath, entry.path)))
				.map((entry) => entry.path),
		);
		const actuallyMissing: string[] = [];
		for (const entryPath of missingTrackedSpecs) {
			try {
				if (!(await stat(path.join(this.repoRoot, entryPath))).isFile()) {
					actuallyMissing.push(entryPath);
				}
			} catch {
				actuallyMissing.push(entryPath);
			}
		}

		const graphContext: KnowledgeImpactResult["graphContext"] = [];
		for (const filePath of paths.filter((value) => !isDocumentPath(value))) {
			const [outgoing, incoming] = await Promise.all([
				this.metadata.listDependencies(this.projectId, this.snapshotId, filePath),
				this.metadata.getDependents(this.projectId, this.snapshotId, filePath),
			]);
			graphContext.push({
				path: filePath,
				imports: uniqueSorted(
					outgoing.map((dependency) => dependency.toPath).filter((value): value is string => Boolean(value)),
				),
				importedBy: uniqueSorted(incoming.map((dependency) => dependency.fromPath)),
			});
		}

		const uncoveredPaths = paths.filter(
			(filePath) => !covered.has(filePath) && !documentPaths.has(filePath),
		);
		const semanticCandidates: KnowledgeImpactResult["semanticCandidates"] = [];
		if (this.searcher) {
			for (const filePath of uncoveredPaths) {
				const graph = graphContext.find((item) => item.path === filePath);
				const terms = uniqueSorted([
					filePath,
					path.basename(filePath),
					...(graph?.imports ?? []).map((value) => path.basename(value)),
					...(graph?.importedBy ?? []).map((value) => path.basename(value)),
				]);
				const query = terms.join(" ");
				const candidates = await this.searcher.search(query, {
					limit: options.semanticLimit ?? 5,
				});
				semanticCandidates.push({
					changedPath: filePath,
					query,
					candidates: candidates.map((candidate) => ({
						path: candidate.path,
						title: candidate.title,
						score: candidate.score,
						status: candidate.status,
					})),
				});
			}
		}

		const changedDocsNeedReview = changedDocuments.some(
			(document) =>
				document.requiresClassification || document.requiresReclassification,
		);
		const reasons: string[] = [];
		if (knownAffected.length > 0) reasons.push("known-relationships-affected");
		if (uncoveredPaths.length > 0) reasons.push("changed-paths-without-known-spec-relations");
		if (changedDocsNeedReview) reasons.push("changed-or-new-documents-require-classification");
		if (actuallyMissing.length > 0) reasons.push("tracked-primary-source-missing-or-moved");

		return {
			source,
			changes: diff,
			changedPaths: paths,
			knownAffected: knownAffected.sort((a, b) => a.path.localeCompare(b.path)),
			uncoveredPaths,
			changedDocuments: changedDocuments.sort((a, b) => a.path.localeCompare(b.path)),
			missingTrackedSpecs: actuallyMissing,
			graphContext,
			semanticCandidates,
			semanticSweepRequired:
				knownAffected.length > 0 ||
				uncoveredPaths.length > 0 ||
				changedDocsNeedReview ||
				actuallyMissing.length > 0,
			reasons,
		};
	}
}

