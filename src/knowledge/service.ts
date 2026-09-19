import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../core/config.js";
import type {
	KnowledgeBehaviorType,
	KnowledgeClassification,
	KnowledgeEntry,
	KnowledgeLifecycle,
	KnowledgeRelation,
	KnowledgeRelationKind,
	KnowledgeStore,
	MetadataStore,
	ProjectId,
	SnapshotId,
} from "../core/types.js";
import { computeHash } from "../utils/hash.js";
import { parseGitignore, type GitignoreFilter } from "../utils/gitignore.js";
import { documentTitle, knowledgeDiscoverySignals } from "./discovery.js";
import { scanProjectDocuments } from "./document-scanner.js";
import { extractExplicitKnowledgeRelations } from "./relations.js";

export const PRIMARY_KNOWLEDGE_CLASSIFICATIONS = new Set<KnowledgeClassification>([
	"spec",
	"spec-like",
]);

export type KnowledgeFreshnessStatus =
	| "fresh"
	| "unverified"
	| "spec-changed"
	| "inputs-changed"
	| "spec+inputs-changed"
	| "missing-source"
	| "classified";

export interface KnowledgeStatus {
	path: string;
	classification: KnowledgeClassification;
	lifecycle: KnowledgeLifecycle;
	status: KnowledgeFreshnessStatus;
	reasons: string[];
}

export interface KnowledgeRelateStatus extends KnowledgeStatus {
	changed: boolean;
	warnings: string[];
}

export interface KnowledgeCandidate {
	path: string;
	title: string;
	score: number;
	roleHint: ReturnType<typeof knowledgeDiscoverySignals>["roleHint"];
	signals: string[];
	currentHash: string;
	knownClassification?: KnowledgeClassification;
	knownLifecycle?: KnowledgeLifecycle;
	changedSinceClassification?: boolean;
}

export interface KnowledgeCandidateReviewSummary {
	candidateCount: number;
	unclassifiedCandidateCount: number;
	changedClassifiedCandidateCount: number;
}

export function summarizeKnowledgeCandidates(
	candidates: readonly KnowledgeCandidate[],
): KnowledgeCandidateReviewSummary {
	let unclassifiedCandidateCount = 0;
	let changedClassifiedCandidateCount = 0;
	for (const candidate of candidates) {
		if (!candidate.knownClassification) {
			unclassifiedCandidateCount += 1;
		} else if (candidate.changedSinceClassification) {
			changedClassifiedCandidateCount += 1;
		}
	}
	return {
		candidateCount: candidates.length,
		unclassifiedCandidateCount,
		changedClassifiedCandidateCount,
	};
}

export interface RecordKnowledgeInput {
	path: string;
	classification: KnowledgeClassification;
	behaviorType?: KnowledgeBehaviorType;
	lifecycle?: KnowledgeLifecycle;
	confidence?: string;
	summary?: string;
	topics?: string[];
}

export interface RelateKnowledgeInput {
	sourcePath: string;
	targetPath: string;
	targetKind: "code" | "knowledge";
	relationKind: KnowledgeRelationKind;
	action: "add" | "remove";
}

function isTestPath(filePath: string): boolean {
	return /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(
		filePath.replace(/\\/g, "/"),
	);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function knowledgeRelationsHash(relations: KnowledgeRelation[]): string {
	const canonical = relations
		.map((relation) => ({
			targetPath: relation.targetPath,
			targetKind: relation.targetKind,
			relationKind: relation.relationKind,
			provenance: relation.provenance,
		}))
		.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		);
	return sha256(JSON.stringify(canonical));
}

function primary(entry: KnowledgeEntry): boolean {
	return PRIMARY_KNOWLEDGE_CLASSIFICATIONS.has(entry.classification);
}

function currentLifecycle(entry: KnowledgeEntry): boolean {
	return entry.lifecycle !== "historical" && entry.lifecycle !== "superseded";
}

export class KnowledgeService {
	constructor(
		private readonly projectId: ProjectId,
		private readonly repoRoot: string,
		private readonly metadata: MetadataStore,
		private readonly knowledge: KnowledgeStore,
	) {}

	private async normalizeProjectPath(value: string): Promise<string> {
		const root = await realpath(this.repoRoot);
		const absolute = path.isAbsolute(value) ? value : path.resolve(root, value);
		const relative = path.relative(root, absolute);
		if (!relative || relative === ".") {
			throw new Error("Knowledge paths must point to a project file.");
		}
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Path escapes project root: ${value}`);
		}
		return relative.replace(/\\/g, "/");
	}

	private async resolveExistingProjectFile(filePath: string): Promise<string> {
		const root = await realpath(this.repoRoot);
		const candidate = path.join(root, filePath);
		const resolved = await realpath(candidate);
		const relative = path.relative(root, resolved);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Path resolves outside project root: ${filePath}`);
		}
		if (!(await stat(resolved)).isFile()) {
			throw new Error(`Path is not a file: ${filePath}`);
		}
		return resolved;
	}

	private async currentHash(filePath: string): Promise<string | null> {
		try {
			const fullPath = await this.resolveExistingProjectFile(filePath);
			return computeHash(await readFile(fullPath, "utf8"));
		} catch {
			return null;
		}
	}

	private async getStatusWithGitignore(
		entry: KnowledgeEntry,
		gitignore: GitignoreFilter,
	): Promise<KnowledgeStatus> {
		if (!primary(entry)) {
			return {
				path: entry.path,
				classification: entry.classification,
				lifecycle: entry.lifecycle,
				status: "classified",
				reasons: [],
			};
		}

		const sourceHash = await this.currentHash(entry.path);
		if (!sourceHash) {
			return {
				path: entry.path,
				classification: entry.classification,
				lifecycle: entry.lifecycle,
				status: "missing-source",
				reasons: [entry.path],
			};
		}

		if (!entry.verifiedSourceHash || !entry.verifiedRelationsHash) {
			return {
				path: entry.path,
				classification: entry.classification,
				lifecycle: entry.lifecycle,
				status:
					sourceHash === entry.indexedSourceHash ? "unverified" : "spec-changed",
				reasons:
					sourceHash === entry.indexedSourceHash
						? ["semantic verification required"]
						: [`source:${entry.path}`],
			};
		}

		const sourceChanged = sourceHash !== entry.verifiedSourceHash;
		const relations = await this.knowledge.listKnowledgeRelations(this.projectId, {
			sourcePath: entry.path,
		});
		const relationChanged =
			knowledgeRelationsHash(relations) !== entry.verifiedRelationsHash;
		const verifiedInputs = await this.knowledge.listKnowledgeVerifiedInputs(
			this.projectId,
			entry.path,
		);
		const changedInputs: string[] = [];
		for (const input of verifiedInputs) {
			if (gitignore.ignores(input.inputPath)) continue;
			const current = await this.currentHash(input.inputPath);
			if (!current || current !== input.inputHash) {
				changedInputs.push(input.inputPath);
			}
		}
		if (relationChanged) changedInputs.push("[relation-map]");

		let status: KnowledgeFreshnessStatus = "fresh";
		if (sourceChanged && changedInputs.length > 0) status = "spec+inputs-changed";
		else if (sourceChanged) status = "spec-changed";
		else if (changedInputs.length > 0) status = "inputs-changed";
		const reasons = [
			...(sourceChanged ? [`source:${entry.path}`] : []),
			...changedInputs.map((input) =>
				input === "[relation-map]" ? "relations:changed" : `input:${input}`,
			),
		];
		return {
			path: entry.path,
			classification: entry.classification,
			lifecycle: entry.lifecycle,
			status,
			reasons,
		};
	}

	async getStatus(entry: KnowledgeEntry): Promise<KnowledgeStatus> {
		return this.getStatusWithGitignore(entry, parseGitignore(this.repoRoot));
	}

	async listStatuses(): Promise<KnowledgeStatus[]> {
		const entries = await this.knowledge.listKnowledgeEntries(this.projectId);
		const gitignore = parseGitignore(this.repoRoot);
		return Promise.all(
			entries.map((entry) => this.getStatusWithGitignore(entry, gitignore)),
		);
	}

	async discover(options: {
		allUnclassified?: boolean;
		includeAll?: boolean;
		minScore?: number;
	} = {}): Promise<KnowledgeCandidate[]> {
		const [paths, entries] = await Promise.all([
			scanProjectDocuments(this.repoRoot),
			this.knowledge.listKnowledgeEntries(this.projectId),
		]);
		const known = new Map(entries.map((entry) => [entry.path, entry]));
		const minScore = options.minScore ?? 3;
		const candidates: KnowledgeCandidate[] = [];

		for (const filePath of paths) {
			const fullPath = path.join(this.repoRoot, filePath);
			let content: string;
			try {
				content = await readFile(fullPath, "utf8");
			} catch {
				continue;
			}
			const sourceHash = computeHash(content);
			const existing = known.get(filePath);
			const changed = Boolean(existing && existing.indexedSourceHash !== sourceHash);
			if (options.allUnclassified && existing) continue;
			const signals = knowledgeDiscoverySignals(filePath, content);
			if (!options.includeAll && !options.allUnclassified) {
				if (existing && !changed) continue;
				if (!existing && signals.score < minScore && signals.roleHint !== "meta-index") {
					continue;
				}
			}
			if (
				options.allUnclassified &&
				(signals.signals.includes("fixture-like-path") ||
					signals.signals.includes("skill-resource-path"))
			) {
				continue;
			}

			candidates.push({
				path: filePath,
				title: documentTitle(content, filePath),
				score: signals.score,
				roleHint: signals.roleHint,
				signals: signals.signals,
				currentHash: sourceHash,
				knownClassification: existing?.classification,
				knownLifecycle: existing?.lifecycle,
				changedSinceClassification: existing ? changed : undefined,
			});
		}

		return candidates.sort((left, right) => {
			const leftKnown = left.knownClassification ? 1 : 0;
			const rightKnown = right.knownClassification ? 1 : 0;
			if (leftKnown !== rightKnown) return leftKnown - rightKnown;
				const roleRank = (role: KnowledgeCandidate["roleHint"]): number => {
					if (role === "spec-candidate") return 0;
					if (role === "meta-index") return 1;
					if (role === "design-reference") return 2;
					return 3;
				};
			const roleDifference = roleRank(left.roleHint) - roleRank(right.roleHint);
			if (roleDifference !== 0) return roleDifference;
			if (left.score !== right.score) return right.score - left.score;
			return left.path.localeCompare(right.path);
		});
	}

	async record(input: RecordKnowledgeInput): Promise<KnowledgeEntry> {
		const filePath = await this.normalizeProjectPath(input.path);
		const fullPath = await this.resolveExistingProjectFile(filePath);
		const content = await readFile(fullPath, "utf8");
		const sourceHash = computeHash(content);
		const previous = await this.knowledge.getKnowledgeEntry(this.projectId, filePath);
		const isPrimary = PRIMARY_KNOWLEDGE_CLASSIFICATIONS.has(input.classification);
		const previousWasPrimary = Boolean(previous && primary(previous));
		if (isPrimary && !input.summary?.trim() && !(previousWasPrimary && previous?.summary.trim())) {
			throw new Error("Primary knowledge requires a non-empty summary.");
		}
		if (isPrimary && !input.behaviorType && !previousWasPrimary) {
			throw new Error("Primary knowledge requires --type on first record.");
		}
		if (isPrimary && !input.lifecycle && !previousWasPrimary) {
			throw new Error("Primary knowledge requires --lifecycle on first record.");
		}

		const explicit = await extractExplicitKnowledgeRelations(
			this.repoRoot,
			filePath,
			content,
			config.get("documentExtensions"),
		);
		const previousRelations = await this.knowledge.listKnowledgeRelations(
			this.projectId,
			{ sourcePath: filePath },
		);
		for (const relation of previousRelations.filter(
			(relation) => relation.provenance === "explicit",
		)) {
			await this.knowledge.deleteKnowledgeRelation(this.projectId, relation);
		}
		if (!isPrimary) {
			for (const relation of previousRelations.filter(
				(relation) => relation.provenance === "inferred",
			)) {
				await this.knowledge.deleteKnowledgeRelation(this.projectId, relation);
			}
			if (previous) {
				await this.knowledge.clearKnowledgeVerification(this.projectId, filePath);
			}
		}
		if (isPrimary) {
			for (const targetPath of explicit.code) {
				await this.knowledge.upsertKnowledgeRelation({
					projectId: this.projectId,
					sourcePath: filePath,
					targetPath,
					targetKind: "code",
					relationKind: isTestPath(targetPath) ? "tests" : "implements",
					provenance: "explicit",
				});
			}
			for (const targetPath of explicit.knowledge) {
				await this.knowledge.upsertKnowledgeRelation({
					projectId: this.projectId,
					sourcePath: filePath,
					targetPath,
					targetKind: "knowledge",
					relationKind: "related",
					provenance: "explicit",
				});
			}
		}

		const entry: KnowledgeEntry = {
			projectId: this.projectId,
			path: filePath,
			classification: input.classification,
			behaviorType: isPrimary
				? (input.behaviorType ?? previous?.behaviorType ?? "unknown")
				: "unknown",
			lifecycle: isPrimary
				? (input.lifecycle ?? previous?.lifecycle ?? "unknown")
				: "unknown",
			confidence: input.confidence ?? previous?.confidence ?? "unknown",
			title: documentTitle(content, filePath),
			summary: input.summary?.trim() ?? previous?.summary ?? "",
			topics: [...new Set(input.topics ?? previous?.topics ?? [])].sort(),
			indexedSourceHash: sourceHash,
			indexedAt: Date.now(),
			metadata: {
				...(previous?.metadata ?? {}),
				unresolvedReferences: isPrimary ? explicit.unresolved : [],
			},
		};
		await this.knowledge.upsertKnowledgeEntry(entry);
		return (await this.knowledge.getKnowledgeEntry(this.projectId, filePath)) ?? entry;
	}

	async verify(inputPath: string): Promise<KnowledgeEntry> {
		const filePath = await this.normalizeProjectPath(inputPath);
		const entry = await this.knowledge.getKnowledgeEntry(this.projectId, filePath);
		if (!entry || !primary(entry)) {
			throw new Error(`Only recorded primary knowledge can be verified: ${filePath}`);
		}
		const sourceHash = await this.currentHash(filePath);
		if (!sourceHash) throw new Error(`Primary source is missing: ${filePath}`);
		const relations = await this.knowledge.listKnowledgeRelations(this.projectId, {
			sourcePath: filePath,
		});
		const codeRelations = relations.filter(
			(relation) => relation.targetKind === "code",
		);
		const gitignore = parseGitignore(this.repoRoot);
		const verifiedAt = Date.now();
		const inputs = [] as Array<{
			inputPath: string;
			inputHash: string;
			verifiedAt: number;
		}>;
		for (const inputPath of [...new Set(codeRelations.map((relation) => relation.targetPath))]) {
			if (gitignore.ignores(inputPath)) continue;
			const inputHash = await this.currentHash(inputPath);
			if (!inputHash) {
				throw new Error(`Tracked input is missing or unreadable: ${inputPath}`);
			}
			inputs.push({ inputPath, inputHash, verifiedAt });
		}
		await this.knowledge.replaceKnowledgeVerifiedInputs(
			this.projectId,
			filePath,
			inputs,
		);
		await this.knowledge.upsertKnowledgeEntry({
			...entry,
			indexedSourceHash: sourceHash,
			indexedAt: verifiedAt,
			verifiedSourceHash: sourceHash,
			verifiedRelationsHash: knowledgeRelationsHash(relations),
			verifiedAt,
		});
		const verified = await this.knowledge.getKnowledgeEntry(this.projectId, filePath);
		if (!verified) throw new Error(`Knowledge entry disappeared during verify: ${filePath}`);
		return verified;
	}

	async relate(input: RelateKnowledgeInput): Promise<KnowledgeRelateStatus> {
		const sourcePath = await this.normalizeProjectPath(input.sourcePath);
		const targetPath = await this.normalizeProjectPath(input.targetPath);
		const gitignore = parseGitignore(this.repoRoot);
		const warnings =
			input.action === "add" &&
			input.targetKind === "code" &&
			gitignore.ignores(targetPath)
				? [`${targetPath} is gitignored and will not participate in freshness tracking.`]
				: [];
		const entry = await this.knowledge.getKnowledgeEntry(this.projectId, sourcePath);
		if (!entry || !primary(entry)) {
			throw new Error(`Only primary knowledge can have durable relations: ${sourcePath}`);
		}
		if (input.action === "add") {
			const targetHash = await this.currentHash(targetPath);
			if (!targetHash) throw new Error(`Relation target does not exist: ${targetPath}`);
		}
		const relation: KnowledgeRelation = {
			projectId: this.projectId,
			sourcePath,
			targetPath,
			targetKind: input.targetKind,
			relationKind: input.relationKind,
			provenance: "inferred",
		};
		if (input.action === "add") {
			const existingRelations = await this.knowledge.listKnowledgeRelations(
				this.projectId,
				{ sourcePath },
			);
			if (
				existingRelations.some(
					(existing) =>
						existing.targetPath === targetPath &&
						existing.targetKind === input.targetKind &&
						existing.relationKind === input.relationKind,
				)
			) {
				return {
					...(await this.getStatusWithGitignore(entry, gitignore)),
					changed: false,
					warnings,
				};
			}
			await this.knowledge.upsertKnowledgeRelation(relation);
			return {
				...(await this.getStatusWithGitignore(entry, gitignore)),
				changed: true,
				warnings,
			};
		} else {
			const changed =
				(await this.knowledge.deleteKnowledgeRelation(this.projectId, relation)) > 0;
			if (!changed) {
				warnings.push(
					`no matching relation: ${sourcePath} — ${input.relationKind} ${targetPath}`,
				);
			}
			return {
				...(await this.getStatusWithGitignore(entry, gitignore)),
				changed,
				warnings,
			};
		}
	}

	async remove(inputPath: string): Promise<void> {
		const filePath = await this.normalizeProjectPath(inputPath);
		await this.knowledge.deleteKnowledgeEntry(this.projectId, filePath);
	}

	async audit(): Promise<{
		primarySpecCount: number;
		currentPrimarySpecCount: number;
		freshCount: number;
		unverifiedCount: number;
		needsReviewCount: number;
		unresolvedReferenceCount: number;
		uncoveredActiveAsIsCount: number;
		uncoveredActiveAsIsSpecs: string[];
		statuses: KnowledgeStatus[];
		candidateCount: number;
		unclassifiedCandidateCount: number;
		changedClassifiedCandidateCount: number;
		candidates: KnowledgeCandidate[];
	}> {
		const [entries, statuses, candidates, relations] = await Promise.all([
			this.knowledge.listKnowledgeEntries(this.projectId),
			this.listStatuses(),
			this.discover(),
			this.knowledge.listKnowledgeRelations(this.projectId),
		]);
		const primaryEntries = entries.filter(primary);
		const sourcesWithCodeRelations = new Set(
			relations
				.filter((relation) => relation.targetKind === "code")
				.map((relation) => relation.sourcePath),
		);
		const uncoveredActiveAsIsSpecs = primaryEntries
			.filter(
				(entry) =>
					entry.lifecycle === "active" &&
					entry.behaviorType === "as-is" &&
					!sourcesWithCodeRelations.has(entry.path),
			)
			.map((entry) => entry.path)
			.sort((left, right) => left.localeCompare(right));
		const primaryStatuses = statuses.filter((status) =>
			PRIMARY_KNOWLEDGE_CLASSIFICATIONS.has(status.classification),
		);
		const candidateSummary = summarizeKnowledgeCandidates(candidates);
		return {
			primarySpecCount: primaryEntries.length,
			currentPrimarySpecCount: primaryEntries.filter(currentLifecycle).length,
			freshCount: primaryStatuses.filter((status) => status.status === "fresh").length,
			unverifiedCount: primaryStatuses.filter(
				(status) => status.status === "unverified",
			).length,
			needsReviewCount: primaryStatuses.filter(
				(status) =>
					status.lifecycle !== "historical" &&
					status.lifecycle !== "superseded" &&
					status.status !== "fresh" &&
					status.status !== "unverified",
			).length,
			unresolvedReferenceCount: primaryEntries.reduce((sum, entry) => {
				const unresolved = entry.metadata?.unresolvedReferences;
				return sum + (Array.isArray(unresolved) ? unresolved.length : 0);
			}, 0),
			uncoveredActiveAsIsCount: uncoveredActiveAsIsSpecs.length,
			uncoveredActiveAsIsSpecs,
			statuses: primaryStatuses.sort((a, b) => a.path.localeCompare(b.path)),
			...candidateSummary,
			candidates,
		};
	}

	async renderCatalog(snapshotId: SnapshotId): Promise<string> {
		const entries = (await this.knowledge.listKnowledgeEntries(this.projectId)).filter(
			primary,
		);
		const statuses = new Map(
			(await Promise.all(entries.map((entry) => this.getStatus(entry)))).map(
				(status) => [status.path, status],
			),
		);
		const lifecycleRank: Record<KnowledgeLifecycle, number> = {
			active: 0,
			proposed: 1,
			unknown: 2,
			historical: 3,
			superseded: 4,
		};
		entries.sort((left, right) => {
			const rank = lifecycleRank[left.lifecycle] - lifecycleRank[right.lifecycle];
			return rank || left.title.localeCompare(right.title) || left.path.localeCompare(right.path);
		});
		const lines = [
			"# Knowledge Catalog",
			"",
			"> Generated routing metadata. Primary source documents remain authoritative.",
			"",
			"## Current / proposed primary knowledge",
			"",
		];
		for (const entry of entries.filter(currentLifecycle)) {
			const status = statuses.get(entry.path)?.status ?? "unverified";
			const topics = entry.topics.slice(0, 6).join(",") || "-";
			const summary = entry.summary.replace(/\s+/g, " ").trim();
			lines.push(
				`- **${entry.title || entry.path}** — \`${entry.path}\` · ${entry.behaviorType}/${entry.lifecycle} · **${status}** · ${topics} — ${summary}`,
			);
		}
		const archived = entries.filter((entry) => !currentLifecycle(entry));
		if (archived.length > 0) {
			lines.push("", "## Historical / superseded", "");
			for (const entry of archived) {
				lines.push(
					`- **${entry.title || entry.path}** — \`${entry.path}\` · ${entry.behaviorType}/${entry.lifecycle}`,
				);
			}
		}
		const rendered = `${lines.join("\n").trimEnd()}\n`;
		await this.metadata.upsertArtifact(this.projectId, {
			projectId: this.projectId,
			snapshotId,
			artifactType: "knowledge_catalog",
			scope: "project",
			dataJson: JSON.stringify({ text: rendered }),
		});
		return rendered;
	}
}
