import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "../core/config.js";
import type {
	EmbeddingProvider,
	GitDiff,
	KnowledgeStore,
	MetadataStore,
	ProjectId,
	SnapshotId,
	VectorStore,
} from "../core/types.js";
import { computeHash } from "../utils/hash.js";
import { chunkDocument } from "./document-chunker.js";
import { documentClassifierKey, getDocumentMetadata } from "./document-metadata.js";
import type { DocumentClassifierFailureReason } from "./document-metadata.js";
import { loadDocumentClassifierConfig } from "./document-classifier-config.js";
import { scanProjectDocuments } from "./document-scanner.js";
import {
	knowledgeDocumentEmbeddingText,
	writeKnowledgeIndexConfigArtifact,
} from "./embedding.js";

export interface DocumentIncrementalPlan {
	currentPaths: string[];
	added: string[];
	modified: string[];
	deleted: string[];
	unchanged: string[];
	previousClassification?: DocumentClassificationState | null;
}

/**
 * Per-snapshot record of which classifier settings produced the stored advisory
 * metadata and which documents still lack an answer because classification failed.
 */
export interface DocumentClassificationState {
	classifierKey: string | null;
	pending: string[];
}

export const CLASSIFICATION_STATE_ARTIFACT = "document_classification_state";

export interface DocumentIndexResult {
	indexed: number;
	paths: string[];
	errors: string[];
	classification: {
		attempted: number;
		degraded: number;
		reasons: Partial<Record<DocumentClassifierFailureReason, number>>;
		humanActionRequired: boolean;
		/** Documents whose non-explicit fields still await a successful classification. */
		pending: number;
	};
}

export interface DocumentIndexProgress {
	onFileStart?: (filePath: string, current: number, total: number) => void;
	onProgress?: (processed: number, total: number) => void | Promise<void>;
}

export const CLASSIFICATION_STATUS_FILE = "document-classification-status.json";

async function writeClassificationStatus(root: string, classification: DocumentIndexResult["classification"]): Promise<void> {
	const directory = path.join(root, ".indexer-cli");
	const target = path.join(directory, CLASSIFICATION_STATUS_FILE);
	const temporary = `${target}.${randomUUID()}.tmp`;
	const payload = {
		version: 1,
		status: classification.degraded > 0 || classification.pending > 0 ? "degraded" : "ok",
		...classification,
		updatedAt: new Date().toISOString(),
	};
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(temporary, JSON.stringify(payload, null, 2), { mode: 0o600, flag: "wx" });
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

function currentClassifier(): { key: string | null; available: boolean } {
	try {
		const classifier = loadDocumentClassifierConfig();
		return { key: documentClassifierKey(classifier), available: Boolean(classifier.apiKey) };
	} catch {
		return { key: null, available: false };
	}
}

async function readClassificationState(
	metadata: MetadataStore,
	projectId: ProjectId,
	snapshotId: SnapshotId,
): Promise<DocumentClassificationState | null> {
	const artifact = await metadata.getArtifact(projectId, snapshotId, CLASSIFICATION_STATE_ARTIFACT, "project");
	if (!artifact) return null;
	try {
		const data = JSON.parse(artifact.dataJson) as Partial<DocumentClassificationState>;
		return {
			classifierKey: typeof data.classifierKey === "string" ? data.classifierKey : null,
			pending: Array.isArray(data.pending) ? data.pending.filter((item): item is string => typeof item === "string") : [],
		};
	} catch {
		return null;
	}
}

async function writeClassificationState(
	metadata: MetadataStore,
	projectId: ProjectId,
	snapshotId: SnapshotId,
	state: DocumentClassificationState,
): Promise<void> {
	await metadata.upsertArtifact(projectId, {
		projectId,
		snapshotId,
		artifactType: CLASSIFICATION_STATE_ARTIFACT,
		scope: "project",
		dataJson: JSON.stringify({ classifierKey: state.classifierKey, pending: uniqueSorted(state.pending) }),
	});
}

/**
 * True when an explicit index run can improve stored advisory metadata without
 * any document change: the classifier is usable and either earlier attempts
 * failed or the classifier settings changed since the metadata was produced.
 */
export async function documentClassificationNeedsRefresh(
	metadata: MetadataStore,
	projectId: ProjectId,
	snapshotId: SnapshotId,
): Promise<boolean> {
	const classifier = currentClassifier();
	if (!classifier.available) return false;
	const state = await readClassificationState(metadata, projectId, snapshotId);
	return !state || state.classifierKey !== classifier.key || state.pending.length > 0;
}

function emptyClassification(): DocumentIndexResult["classification"] {
	return { attempted: 0, degraded: 0, reasons: {}, humanActionRequired: false, pending: 0 };
}

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export interface DocumentIndexerOptions {
	/**
	 * Re-run classification for unchanged documents whose stored metadata is
	 * incomplete or stale. Explicit indexing enables it; automatic refresh before
	 * queries leaves it off so reads never wait on the remote classifier.
	 */
	retryClassification?: boolean;
}

export class DocumentIndexer {
	constructor(
		private readonly repoRoot: string,
		private readonly metadata: MetadataStore,
		private readonly knowledgeStore: KnowledgeStore,
		private readonly vectors: VectorStore,
		private readonly embedder: EmbeddingProvider,
		private readonly options: DocumentIndexerOptions = {},
	) {}

	async scan(): Promise<string[]> {
		return scanProjectDocuments(this.repoRoot);
	}

	async planIncremental(
		projectId: ProjectId,
		previousSnapshotId: SnapshotId,
		gitDiff: GitDiff,
	): Promise<DocumentIncrementalPlan> {
		const [previousFiles, currentPaths, previousClassification] = await Promise.all([
			this.metadata.listFiles(projectId, previousSnapshotId, {
				domain: "document",
			}),
			this.scan(),
			readClassificationState(this.metadata, projectId, previousSnapshotId),
		]);
		const previous = new Set(previousFiles.map((file) => file.path));
		const current = new Set(currentPaths);
		const gitAdded = new Set(gitDiff.added);
		const gitModified = new Set(gitDiff.modified);
		const gitDeleted = new Set(gitDiff.deleted);

		const added = currentPaths.filter(
			(filePath) => !previous.has(filePath) || gitAdded.has(filePath),
		);
		const deleted = [...previous].filter(
			(filePath) => !current.has(filePath) || gitDeleted.has(filePath),
		);
		const addedSet = new Set(added);
		const deletedSet = new Set(deleted);
		const modified = currentPaths.filter(
			(filePath) =>
				previous.has(filePath) &&
				!addedSet.has(filePath) &&
				!deletedSet.has(filePath) &&
				gitModified.has(filePath),
		);
		const changed = new Set([...added, ...modified, ...deleted]);
		const unchanged = [...previous].filter(
			(filePath) => current.has(filePath) && !changed.has(filePath),
		);

		return {
			currentPaths,
			added: uniqueSorted(added),
			modified: uniqueSorted(modified),
			deleted: uniqueSorted(deleted),
			unchanged: uniqueSorted(unchanged),
			previousClassification,
		};
	}

	async copyUnchanged(
		projectId: ProjectId,
		previousSnapshotId: SnapshotId,
		newSnapshotId: SnapshotId,
		paths: string[],
	): Promise<void> {
		await this.metadata.copyUnchangedFileData(
			projectId,
			previousSnapshotId,
			newSnapshotId,
			paths,
		);
	}

	async indexFull(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		options: DocumentIndexProgress & { paths?: string[] } = {},
	): Promise<DocumentIndexResult> {
		const pending: string[] = [];
		const result = await this.indexPaths(
			projectId,
			snapshotId,
			options.paths ?? (await this.scan()),
			options,
			pending,
		);
		result.classification.pending = pending.length;
		await writeKnowledgeIndexConfigArtifact(this.metadata, projectId, snapshotId);
		await writeClassificationState(this.metadata, projectId, snapshotId, {
			classifierKey: currentClassifier().key,
			pending,
		});
		await writeClassificationStatus(this.repoRoot, result.classification).catch(() => undefined);
		await this.pruneCache(projectId, result);
		return result;
	}

	async indexIncremental(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		plan: DocumentIncrementalPlan,
		progress: DocumentIndexProgress = {},
	): Promise<DocumentIndexResult> {
		const pending: string[] = [];
		const result = await this.indexPaths(
			projectId,
			snapshotId,
			[...plan.added, ...plan.modified],
			progress,
			pending,
		);

		const classifier = currentClassifier();
		const previous = plan.previousClassification ?? null;
		const unchanged = new Set(plan.unchanged);
		const settingsCurrent = previous !== null && previous.classifierKey === classifier.key;
		const retry = this.options.retryClassification && classifier.available
			? settingsCurrent
				? previous.pending.filter((filePath) => unchanged.has(filePath))
				: plan.unchanged
			: [];
		const retrySet = new Set(retry);
		// Unretried failures stay pending so a later explicit run can still fix them.
		pending.push(...(previous?.pending ?? []).filter((filePath) => unchanged.has(filePath) && !retrySet.has(filePath)));
		for (const filePath of uniqueSorted(retry)) {
			try {
				await this.reclassifyUnchanged(projectId, snapshotId, filePath, result.classification, pending);
			} catch {
				// Advisory metadata must never fail indexing; keep the document pending.
				pending.push(filePath);
			}
		}
		this.markHumanAction(result.classification);
		result.classification.pending = new Set(pending).size;

		await writeKnowledgeIndexConfigArtifact(this.metadata, projectId, snapshotId);
		await writeClassificationState(this.metadata, projectId, snapshotId, {
			// Without a full retry, unchanged documents keep metadata from the old settings.
			classifierKey: retry.length === plan.unchanged.length || settingsCurrent ? classifier.key : previous?.classifierKey ?? null,
			pending,
		});
		await writeClassificationStatus(this.repoRoot, result.classification).catch(() => undefined);
		await this.pruneCache(projectId, result);
		return result;
	}

	private async pruneCache(projectId: ProjectId, result: DocumentIndexResult): Promise<void> {
		if (result.errors.length || !this.metadata.pruneDocumentMetadataCache) return;
		try {
			let complete = true;
			const paths = await scanProjectDocuments(this.repoRoot, { onWarning: () => { complete = false; } });
			if (complete) await this.metadata.pruneDocumentMetadataCache(projectId, paths);
		} catch {
			// Cleanup is advisory; an incomplete scan must not be treated as deletion.
		}
	}

	/** Refreshes advisory metadata of an already-embedded document without re-embedding it. */
	private async reclassifyUnchanged(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		classification: DocumentIndexResult["classification"],
		pending: string[],
	): Promise<void> {
		const record = await this.metadata.getFile(projectId, snapshotId, filePath, { domain: "document" });
		const content = await readFile(path.join(this.repoRoot, filePath), "utf8");
		// Only metadata for the exact indexed bytes may be attached to the stored chunks.
		if (!record || computeHash(content) !== record.sha256) {
			pending.push(filePath);
			return;
		}
		const chunks = await this.knowledgeStore.listKnowledgeChunks(projectId, snapshotId, filePath);
		if (chunks.length === 0) return;
		const document = await this.classify(projectId, filePath, content, classification, pending);
		if (chunks.every((chunk) => JSON.stringify(chunk.metadata?.document) === JSON.stringify(document))) return;
		await this.knowledgeStore.replaceKnowledgeChunks(
			projectId,
			snapshotId,
			filePath,
			chunks.map(({ projectId: _projectId, snapshotId: _snapshotId, filePath: _filePath, ...chunk }) => ({
				...chunk,
				metadata: { ...chunk.metadata, document },
			})),
		);
	}

	private async classify(
		projectId: ProjectId,
		filePath: string,
		content: string,
		classification: DocumentIndexResult["classification"],
		pending: string[],
	) {
		const parsed = await getDocumentMetadata(filePath, content, { cache: this.metadata, projectId });
		if (parsed.kindSource !== "explicit" || parsed.statusSource !== "explicit") classification.attempted += 1;
		let failed = false;
		const documentMetadata = await getDocumentMetadata(filePath, content, {
			classify: true,
			cache: this.metadata,
			projectId,
			onClassifierDiagnostic: (diagnostic) => {
				failed = true;
				classification.degraded += 1;
				classification.reasons[diagnostic.reason] = (classification.reasons[diagnostic.reason] ?? 0) + 1;
				if (diagnostic.humanActionRequired) classification.humanActionRequired = true;
			},
		});
		if (failed) pending.push(filePath);
		return documentMetadata;
	}

	private markHumanAction(classification: DocumentIndexResult["classification"]): void {
		if (classification.attempted >= 3 && classification.degraded === classification.attempted) classification.humanActionRequired = true;
	}

	private async indexPaths(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		paths: string[],
		progress: DocumentIndexProgress,
		pending: string[],
	): Promise<DocumentIndexResult> {
		const errors: string[] = [];
		const classification = emptyClassification();
		let indexed = 0;
		const orderedPaths = uniqueSorted(paths);

		for (const [index, filePath] of orderedPaths.entries()) {
			progress.onFileStart?.(filePath, index + 1, orderedPaths.length);
			try {
				await this.indexOne(projectId, snapshotId, filePath, classification, pending);
				indexed += 1;
			} catch (error) {
				errors.push(
					`${filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			await progress.onProgress?.(index + 1, orderedPaths.length);
		}

		this.markHumanAction(classification);
		return { indexed, paths: orderedPaths, errors, classification };
	}

	private async indexOne(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		classification: DocumentIndexResult["classification"],
		pending: string[],
	): Promise<void> {
		const fullPath = path.join(this.repoRoot, filePath);
		const [content, fileStat] = await Promise.all([
			readFile(fullPath, "utf8"),
			stat(fullPath),
		]);
		await this.metadata.upsertFile(projectId, {
			snapshotId,
			path: filePath,
			sha256: computeHash(content),
			mtimeMs: fileStat.mtimeMs,
			size: fileStat.size,
			languageId: "document",
			domain: "document",
		});
		if (fileStat.size > config.get("documentMaxBytes")) {
			await this.knowledgeStore.replaceKnowledgeChunks(
				projectId,
				snapshotId,
				filePath,
				[],
			);
			return;
		}

		const providerContextLimit = config.get("embeddingProvider") === "ollama"
			? Math.max(64, config.get("ollamaNumCtx") - 32)
			: config.get("embeddingContextSize");
		const maxTokens = Math.max(
			64,
			Math.min(
				700,
				config.get("embeddingContextSize"),
				providerContextLimit,
			),
		);
		const chunks = chunkDocument(filePath, content, {
			maxTokens,
			fullFileMaxTokens: Math.min(400, maxTokens),
		});
		const documentMetadata = await this.classify(projectId, filePath, content, classification, pending);

		await this.knowledgeStore.replaceKnowledgeChunks(
			projectId,
			snapshotId,
			filePath,
			chunks.map(({ content, ...chunk }) => ({
				...chunk,
				metadata: { ...chunk.metadata, searchText: content, document: documentMetadata },
			})),
		);

		if (chunks.length === 0) return;
		const embeddings = await this.embedder.embed(
			chunks.map((chunk) => knowledgeDocumentEmbeddingText(chunk.content)),
		);
		if (embeddings.length !== chunks.length) {
			throw new Error(
				`embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`,
			);
		}
		await this.vectors.upsert(
			chunks.map((chunk, index) => ({
				projectId,
				chunkId: chunk.chunkId,
				snapshotId,
				filePath,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				contentHash: chunk.contentHash,
				chunkType: chunk.chunkType,
				primarySymbol: chunk.heading,
				embedding: embeddings[index] ?? [],
				domain: "document",
			})),
		);
	}
}
