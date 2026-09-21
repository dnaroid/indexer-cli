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
	KnowledgeVerificationReceipt,
	KnowledgeVerificationSelector,
	LocalVerificationRunnerChecks,
	MetadataStore,
	ProjectId,
	SnapshotId,
} from "../core/types.js";
import { parseGitignore, type GitignoreFilter } from "../utils/gitignore.js";
import { documentTitle, knowledgeDiscoverySignals } from "./discovery.js";
import { scanProjectDocuments } from "./document-scanner.js";
import { extractExplicitKnowledgeRelations } from "./relations.js";
import { validateLocallyExecutedVerificationReceipt, validateVerificationReceipt, type VerificationFacts } from "./verification/evidence.js";
import { isTrustedLocalRunnerChecks } from "./verification/runner.js";
import { resolveVerificationSelector } from "./verification/selectors.js";
import { computeHash } from "../utils/hash.js";

export const PRIMARY_KNOWLEDGE_CLASSIFICATIONS = new Set<KnowledgeClassification>([
	"spec",
	"spec-like",
]);

/** Metadata marker added when indexing switched from normalized text to source bytes. */
const EXACT_SOURCE_HASH_FORMAT = "sha256-exact-v1";

export type KnowledgeFreshnessStatus =
	| "fresh"
	| "unverified"
	| "spec-changed"
	| "inputs-changed"
	| "spec+inputs-changed"
	| "missing-source"
	| "classified";

export type KnowledgeTrustState = "verified" | "explicit" | "default";

interface ExplicitKnowledgeTrustMetadata {
	mode: "explicit";
	trustedAt: number;
	sourceHash: string;
	rationale?: string;
}

export interface KnowledgeStatus {
	path: string;
	classification: KnowledgeClassification;
	lifecycle: KnowledgeLifecycle;
	status: KnowledgeFreshnessStatus;
	/** Trust is separate from verification. Registered knowledge is trusted by default with warnings. */
	trust: KnowledgeTrustState;
	reasons: string[];
	/** Selector hashes are not read during status checks; whole-file drift remains authoritative. */
	selectorHints?: string[];
	trackedInputCount?: number;
	ignoredInputCount?: number;
	verificationState?: "legacy-unattested" | "attested";
}

export interface KnowledgeRelateStatus extends KnowledgeStatus {
	changed: boolean;
	warnings: string[];
}

export interface KnowledgeTrustResult {
	path: string;
	trust: KnowledgeTrustState;
	explicit: boolean;
	trustedAt?: number;
	rationale?: string;
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
	specCandidateCount: number;
	unclassifiedCandidateCount: number;
	changedClassifiedCandidateCount: number;
}

export function summarizeKnowledgeCandidates(
	candidates: readonly KnowledgeCandidate[],
): KnowledgeCandidateReviewSummary {
	let unclassifiedCandidateCount = 0;
	let changedClassifiedCandidateCount = 0;
	let specCandidateCount = 0;
	for (const candidate of candidates) {
		if (candidate.roleHint === "spec-candidate") specCandidateCount += 1;
		if (!candidate.knownClassification) {
			unclassifiedCandidateCount += 1;
		} else if (candidate.changedSinceClassification) {
			changedClassifiedCandidateCount += 1;
		}
	}
	return {
		candidateCount: candidates.length,
		specCandidateCount,
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

export interface VerificationPreparation extends VerificationFacts {
	warnings: string[];
	/** This service never executes commands. Caller-supplied command records are attestations. */
	commandExecution: "not-executed";
}

export interface VerificationPreparationOptions {
	selectors?: Record<string, Pick<KnowledgeVerificationSelector, "kind" | "value">>;
	/** In-memory checks returned by runVerificationChecks; JSON/deserialized arrays are rejected. */
	localRunnerChecks?: LocalVerificationRunnerChecks;
}

function isTestPath(filePath: string): boolean {
	return /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(
		filePath.replace(/\\/g, "/"),
	);
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function knowledgeRelationsHash(relations: KnowledgeRelation[]): string {
	const canonical = relations
		.map((relation) => {
			// Declaration assertion IDs and selectors are verification evidence. Do not
			// hash arbitrary relation metadata (for example navigation annotations).
			const manifest = relation.metadata?.manifest;
			const declaration = manifest && typeof manifest === "object"
				? manifest as Record<string, unknown> : undefined;
			const evidence = declaration?.evidence;
			const selector = evidence && typeof evidence === "object"
				? (evidence as Record<string, unknown>).selector : undefined;
			return ({
			targetPath: relation.targetPath,
			targetKind: relation.targetKind,
			relationKind: relation.relationKind,
			provenance: relation.provenance,
			...(typeof declaration?.id === "string" ? { manifestId: declaration.id } : {}),
			...(typeof declaration?.assertionId === "string" ? { assertionId: declaration.assertionId } : {}),
			...(selector && typeof selector === "object" &&
				typeof (selector as Record<string, unknown>).kind === "string" &&
				typeof (selector as Record<string, unknown>).value === "string"
				? { selector: { kind: (selector as Record<string, string>).kind, value: (selector as Record<string, string>).value } }
				: {}),
			});
		})
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
			return sha256(await readFile(fullPath));
		} catch {
			return null;
		}
	}

	private async legacyHash(filePath: string): Promise<string | null> {
		try {
			return computeHash(await readFile(await this.resolveExistingProjectFile(filePath), "utf8"));
		} catch {
			return null;
		}
	}

	private async matchesIndexedSourceHash(entry: KnowledgeEntry, sourceHash: string): Promise<boolean> {
		if (sourceHash === entry.indexedSourceHash) return true;
		// Entries written before this marker used normalized-text hashes. Unmarked
		// entries are deliberately migrated only as a compatibility fallback; newly
		// recorded exact-byte entries must still report byte-level drift.
		if (entry.metadata?.indexedSourceHashFormat === EXACT_SOURCE_HASH_FORMAT) return false;
		return await this.legacyHash(entry.path) === entry.indexedSourceHash;
	}

	private explicitTrust(entry: KnowledgeEntry): ExplicitKnowledgeTrustMetadata | undefined {
		const value = entry.metadata?.trust;
		if (!value || typeof value !== "object") return undefined;
		const trust = value as Record<string, unknown>;
		if (
			trust.mode !== "explicit" ||
			typeof trust.trustedAt !== "number" ||
			!Number.isFinite(trust.trustedAt) ||
			typeof trust.sourceHash !== "string"
		) {
			return undefined;
		}
		return {
			mode: "explicit",
			trustedAt: trust.trustedAt,
			sourceHash: trust.sourceHash,
			...(typeof trust.rationale === "string" && trust.rationale.trim()
				? { rationale: trust.rationale }
				: {}),
		};
	}

	private trustState(
		entry: KnowledgeEntry,
		status: KnowledgeFreshnessStatus,
		currentSourceHash: string | null,
	): KnowledgeTrustState {
		if (status === "fresh" && entry.verificationReceipt) return "verified";
		const explicit = this.explicitTrust(entry);
		if (explicit && currentSourceHash && explicit.sourceHash === currentSourceHash) {
			return "explicit";
		}
		return "default";
	}

	private async getStatusWithGitignore(
		entry: KnowledgeEntry,
		gitignore: GitignoreFilter,
		hashes = new Map<string, Promise<string | null>>(),
	): Promise<KnowledgeStatus> {
		const current = (p: string) => {
			let result = hashes.get(p); if (!result) { result = this.currentHash(p); hashes.set(p, result); } return result;
		};
		const sourceHash = await current(entry.path);
		if (!primary(entry)) {
			return {
				path: entry.path,
				classification: entry.classification,
				lifecycle: entry.lifecycle,
				status: "classified",
				trust: this.trustState(entry, "classified", sourceHash),
				reasons: [],
			};
		}

		if (!sourceHash) {
			return {
				path: entry.path,
				classification: entry.classification,
				lifecycle: entry.lifecycle,
				status: "missing-source",
				trust: "default",
				reasons: [entry.path],
			};
		}

		if (!entry.verifiedSourceHash || !entry.verifiedRelationsHash || !entry.verificationReceipt) {
			const indexedSourceMatches = await this.matchesIndexedSourceHash(entry, sourceHash);
			const legacyMatch = sourceHash !== entry.indexedSourceHash && indexedSourceMatches;
			const legacyUnattested = Boolean(entry.verifiedSourceHash || legacyMatch);
			const status = indexedSourceMatches ? "unverified" : "spec-changed";
			return {
				path: entry.path,
				classification: entry.classification,
				lifecycle: entry.lifecycle,
				status,
				trust: this.trustState(entry, status, sourceHash),
				reasons:
					indexedSourceMatches
						? [entry.verifiedSourceHash || legacyMatch ? "legacy/unattested verification baseline" : "semantic verification required"]
						: [`source:${entry.path}`],
				...(legacyUnattested ? { verificationState: "legacy-unattested" as const } : {}),
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
		const verifiedByPath = new Map(verifiedInputs.map((input) => [input.inputPath, input]));
		const codeTargets = [...new Set(relations.filter((relation) => relation.targetKind === "code").map((relation) => relation.targetPath))];
		const trackedTargets = codeTargets.filter((inputPath) => !gitignore.ignores(inputPath));
		const changedInputs: string[] = [];
		for (const inputPath of trackedTargets) {
			const verified = verifiedByPath.get(inputPath);
			const inputHash = await current(inputPath);
			if (!verified || !inputHash || inputHash !== verified.inputHash) changedInputs.push(inputPath);
		}
		const ignoredInputCount = codeTargets.length - trackedTargets.length;
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
			trust: this.trustState(entry, status, sourceHash),
			reasons,
			trackedInputCount: trackedTargets.length,
			ignoredInputCount,
			verificationState: "attested",
			selectorHints: changedInputs.filter((p) => p !== "[relation-map]").flatMap((p) => {
				const selected = entry.verificationReceipt?.inputs.find((input) => input.inputPath === p)?.selector;
				return selected ? [`selector:${p}:${selected.kind} requires review; whole-file hash changed`] : [];
			}),
		};
	}

	async getStatus(entry: KnowledgeEntry): Promise<KnowledgeStatus> {
		return this.getStatusWithGitignore(entry, parseGitignore(this.repoRoot));
	}

	async getStatuses(entries?: KnowledgeEntry[]): Promise<KnowledgeStatus[]> {
		const target = entries ?? await this.knowledge.listKnowledgeEntries(this.projectId);
		const gitignore = parseGitignore(this.repoRoot);
		const hashes = new Map<string, Promise<string | null>>();
		return Promise.all(
			target.map((entry) => this.getStatusWithGitignore(entry, gitignore, hashes)),
		);
	}

	async listStatuses(): Promise<KnowledgeStatus[]> { return this.getStatuses(); }

	async trust(
		inputPath: string,
		options: { clear?: boolean; rationale?: string } = {},
	): Promise<KnowledgeTrustResult> {
		const filePath = await this.normalizeProjectPath(inputPath);
		const entry = await this.knowledge.getKnowledgeEntry(this.projectId, filePath);
		if (!entry) throw new Error(`Recorded knowledge entry not found: ${filePath}`);
		const sourceHash = await this.currentHash(filePath);
		if (!sourceHash) throw new Error(`Knowledge source is missing or unreadable: ${filePath}`);

		const metadata = { ...(entry.metadata ?? {}) };
		if (options.clear) {
			delete metadata.trust;
		} else {
			metadata.trust = {
				mode: "explicit",
				trustedAt: Date.now(),
				sourceHash,
				...(options.rationale?.trim() ? { rationale: options.rationale.trim() } : {}),
			} satisfies ExplicitKnowledgeTrustMetadata;
		}
		await this.knowledge.upsertKnowledgeEntry({ ...entry, metadata });
		const updated = (await this.knowledge.getKnowledgeEntry(this.projectId, filePath)) ?? {
			...entry,
			metadata,
		};
		const status = await this.getStatus(updated);
		const explicit = this.explicitTrust(updated);
		return {
			path: filePath,
			trust: status.trust,
			explicit: Boolean(explicit && explicit.sourceHash === sourceHash),
			...(explicit?.trustedAt ? { trustedAt: explicit.trustedAt } : {}),
			...(explicit?.rationale ? { rationale: explicit.rationale } : {}),
		};
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
			let sourceBytes: Buffer;
			try {
				sourceBytes = await readFile(path.join(this.repoRoot, filePath));
			} catch {
				// A document can disappear or become unreadable after scanning.
				continue;
			}
			const sourceHash = sha256(sourceBytes);
			const content = sourceBytes.toString("utf8");
			const title = documentTitle(content, filePath);
			const signals = knowledgeDiscoverySignals(filePath, content);
			const existing = known.get(filePath);
			const changed = Boolean(existing && !await this.matchesIndexedSourceHash(existing, sourceHash));
			if (options.allUnclassified && existing) continue;
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
				title,
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
		const sourceBytes = await readFile(fullPath);
		const content = sourceBytes.toString("utf8");
		const sourceHash = sha256(sourceBytes);
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
		const declaration = previous?.metadata?.manifest as { authoritative?: boolean } | undefined;
		const manifestAuthoritative = declaration?.authoritative === true;
		for (const relation of previousRelations.filter(
			(relation) => relation.provenance === "explicit" && (!manifestAuthoritative || !isPrimary),
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
		if (isPrimary && !manifestAuthoritative) {
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
		// The legacy delete API matches both provenances. Restore reviewed inferred
		// relations after refreshing prose references; declarations are never replaced
		// by prose mentions in manifest-authoritative mode.
		if (isPrimary) {
			for (const relation of previousRelations.filter((item) => item.provenance === "inferred")) {
				await this.knowledge.upsertKnowledgeRelation(relation);
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
				indexedSourceHashFormat: EXACT_SOURCE_HASH_FORMAT,
				...(manifestAuthoritative ? { mentions: { code: explicit.code, knowledge: explicit.knowledge } } : {}),
				// A manifest declaration, not prose, owns dependency semantics.
				unresolvedReferences: isPrimary && !manifestAuthoritative ? explicit.unresolved : [],
			},
		};
		await this.knowledge.upsertKnowledgeEntry(entry);
		return (await this.knowledge.getKnowledgeEntry(this.projectId, filePath)) ?? entry;
	}

	async prepareVerification(inputPath: string, options: VerificationPreparationOptions = {}): Promise<VerificationPreparation> {
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
		const trackedPaths = new Set<string>();
		const ignoredPaths = new Set<string>();
		for (const relation of codeRelations) {
			if (gitignore.ignores(relation.targetPath)) ignoredPaths.add(relation.targetPath);
			else trackedPaths.add(relation.targetPath);
		}
		for (const inputPath of Object.keys(options.selectors ?? {})) {
			if (!trackedPaths.has(inputPath)) throw new Error(`Verification selector does not match a tracked input: ${inputPath}`);
		}
		const inputs = [] as Array<{
			inputPath: string;
			inputHash: string;
			selector?: KnowledgeVerificationReceipt["inputs"][number]["selector"];
		}>;
		const warnings = [...ignoredPaths]
			.sort((left, right) => left.localeCompare(right))
			.map((inputPath) => `${inputPath} is gitignored and excluded from tracked verification inputs.`);
		for (const inputPath of [...trackedPaths]) {
			const inputHash = await this.currentHash(inputPath);
			if (!inputHash) {
				throw new Error(`Tracked input is missing or unreadable: ${inputPath}`);
			}
			const declared = codeRelations
				.filter((relation) => relation.targetPath === inputPath)
				.flatMap((relation) => {
					const manifest = relation.metadata?.manifest;
					const selector = manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>).evidence : undefined;
					const value = selector && typeof selector === "object" ? (selector as Record<string, unknown>).selector : undefined;
					return value && typeof value === "object" && typeof (value as Record<string, unknown>).kind === "string" && typeof (value as Record<string, unknown>).value === "string"
						? [{ kind: (value as KnowledgeVerificationSelector).kind, value: (value as KnowledgeVerificationSelector).value }] : [];
				});
			const uniqueDeclared = [...new Map(declared.map((selector) => [`${selector.kind}\0${selector.value}`, selector])).values()];
			if (uniqueDeclared.length > 1) throw new Error(`Manifest selectors are ambiguous for tracked input: ${inputPath}`);
			const requested = options.selectors?.[inputPath];
			if (requested && uniqueDeclared[0] && (requested.kind !== uniqueDeclared[0].kind || requested.value !== uniqueDeclared[0].value)) {
				throw new Error(`Verification selector conflicts with manifest declaration: ${inputPath}`);
			}
			const selected = requested ?? uniqueDeclared[0];
			const fullPath = selected ? await this.resolveExistingProjectFile(inputPath) : undefined;
			inputs.push({
				inputPath,
				inputHash,
				...(selected ? { selector: resolveVerificationSelector(await readFile(fullPath!, "utf8"), selected.kind, selected.value) } : {}),
			});
		}
		return {
			sourcePath: filePath,
			sourceHash,
			relationsHash: knowledgeRelationsHash(relations),
			inputs: inputs.sort((a, b) => a.inputPath.localeCompare(b.inputPath)),
			warnings,
			commandExecution: "not-executed",
		};
	}

	async verify(inputPath: string, receipt?: KnowledgeVerificationReceipt, options: VerificationPreparationOptions = {}): Promise<KnowledgeEntry> {
		const prepared = await this.prepareVerification(inputPath, options);
		const entry = await this.knowledge.getKnowledgeEntry(this.projectId, prepared.sourcePath);
		if (!entry) throw new Error(`Knowledge entry disappeared during verify: ${prepared.sourcePath}`);
		// Never accept a receipt for source bytes different from the recorded source:
		// re-record classification/metadata first; verification cannot classify it.
		if (entry.indexedSourceHash !== prepared.sourceHash) {
			throw new Error(`Primary source changed since record: ${prepared.sourcePath}; record it before verification.`);
		}
		if (options.localRunnerChecks) {
			if (!isTrustedLocalRunnerChecks(options.localRunnerChecks)) throw new Error("Local runner checks must be returned by runVerificationChecks in this process.");
			validateLocallyExecutedVerificationReceipt(receipt, prepared, options.localRunnerChecks);
		} else {
			validateVerificationReceipt(receipt, prepared);
		}
		const reviewedFiles = new Map<string, Buffer>();
		for (const binding of [...receipt.assertionBindings, ...receipt.evidenceBindings]) {
			let bytes = reviewedFiles.get(binding.path);
			if (!bytes) {
				bytes = await readFile(await this.resolveExistingProjectFile(binding.path));
				reviewedFiles.set(binding.path, bytes);
			}
			if (sha256(bytes) !== binding.hash) throw new Error(`Evidence changed during verification: ${binding.path}`);
			if (binding.range && binding.range.endLine > bytes.toString("utf8").split(/\r?\n/).length) {
				throw new Error(`Evidence range exceeds current file: ${binding.path}`);
			}
		}
		const verifiedAt = Date.now();
		await this.knowledge.commitKnowledgeVerification({
			...entry,
			verifiedSourceHash: prepared.sourceHash,
			verifiedRelationsHash: prepared.relationsHash,
			verifiedAt,
			verificationReceipt: receipt,
		}, prepared.inputs.map((input) => ({ ...input, verifiedAt })),);
		const verified = await this.knowledge.getKnowledgeEntry(this.projectId, prepared.sourcePath);
		if (!verified) throw new Error(`Knowledge entry disappeared during verify: ${prepared.sourcePath}`);
		return verified;
	}

	async prepareVerificationSelector(
		inputPath: string,
		selector: Pick<KnowledgeVerificationSelector, "kind" | "value">,
	): Promise<KnowledgeVerificationSelector> {
		const filePath = await this.normalizeProjectPath(inputPath);
		const fullPath = await this.resolveExistingProjectFile(filePath);
		return resolveVerificationSelector(await readFile(fullPath, "utf8"), selector.kind, selector.value);
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
		verifiedTrustCount: number;
		explicitTrustCount: number;
		defaultTrustCount: number;
		unresolvedReferenceCount: number;
		uncoveredActiveAsIsCount: number;
		uncoveredActiveAsIsSpecs: string[];
		statuses: KnowledgeStatus[];
		candidateCount: number;
		specCandidateCount: number;
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
		const gitignore = parseGitignore(this.repoRoot);
		const sourcesWithCodeRelations = new Set(
			relations
				.filter((relation) => relation.targetKind === "code" && !gitignore.ignores(relation.targetPath))
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
			verifiedTrustCount: primaryStatuses.filter((status) => status.trust === "verified").length,
			explicitTrustCount: primaryStatuses.filter((status) => status.trust === "explicit").length,
			defaultTrustCount: primaryStatuses.filter((status) => status.trust === "default").length,
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
			const knowledgeStatus = statuses.get(entry.path);
			const status = knowledgeStatus?.status ?? "unverified";
			const trust = knowledgeStatus?.trust ?? "default";
			const topics = entry.topics.slice(0, 6).join(",") || "-";
			const summary = entry.summary.replace(/\s+/g, " ").trim();
			lines.push(
				`- **${entry.title || entry.path}** — \`${entry.path}\` · ${entry.behaviorType}/${entry.lifecycle} · **${status}** · trust=${trust} · ${topics} — ${summary}`,
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
