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
import { getDocumentMetadata } from "./document-metadata.js";
import type { DocumentClassifierFailureReason } from "./document-metadata.js";
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
}

export interface DocumentIndexResult {
	indexed: number;
	paths: string[];
	errors: string[];
	classification: {
		attempted: number;
		degraded: number;
		reasons: Partial<Record<DocumentClassifierFailureReason, number>>;
		humanActionRequired: boolean;
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
		status: classification.degraded > 0 ? "degraded" : "ok",
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

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export class DocumentIndexer {
	constructor(
		private readonly repoRoot: string,
		private readonly metadata: MetadataStore,
		private readonly knowledgeStore: KnowledgeStore,
		private readonly vectors: VectorStore,
		private readonly embedder: EmbeddingProvider,
	) {}

	async scan(): Promise<string[]> {
		return scanProjectDocuments(this.repoRoot);
	}

	async planIncremental(
		projectId: ProjectId,
		previousSnapshotId: SnapshotId,
		gitDiff: GitDiff,
	): Promise<DocumentIncrementalPlan> {
		const [previousFiles, currentPaths] = await Promise.all([
			this.metadata.listFiles(projectId, previousSnapshotId, {
				domain: "document",
			}),
			this.scan(),
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
		const result = await this.indexPaths(
			projectId,
			snapshotId,
			options.paths ?? (await this.scan()),
			options,
		);
		await writeKnowledgeIndexConfigArtifact(this.metadata, projectId, snapshotId);
		await writeClassificationStatus(this.repoRoot, result.classification).catch(() => undefined);
		return result;
	}

	async indexIncremental(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		plan: DocumentIncrementalPlan,
		progress: DocumentIndexProgress = {},
	): Promise<DocumentIndexResult> {
		const result = await this.indexPaths(
			projectId,
			snapshotId,
			[...plan.added, ...plan.modified],
			progress,
		);
		await writeKnowledgeIndexConfigArtifact(this.metadata, projectId, snapshotId);
		await writeClassificationStatus(this.repoRoot, result.classification).catch(() => undefined);
		return result;
	}

	private async indexPaths(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		paths: string[],
		progress: DocumentIndexProgress,
	): Promise<DocumentIndexResult> {
		const errors: string[] = [];
		const classification: DocumentIndexResult["classification"] = { attempted: 0, degraded: 0, reasons: {}, humanActionRequired: false };
		let indexed = 0;
		const orderedPaths = uniqueSorted(paths);

		for (const [index, filePath] of orderedPaths.entries()) {
			progress.onFileStart?.(filePath, index + 1, orderedPaths.length);
			try {
				await this.indexOne(projectId, snapshotId, filePath, classification);
				indexed += 1;
			} catch (error) {
				errors.push(
					`${filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			await progress.onProgress?.(index + 1, orderedPaths.length);
		}

		if (classification.attempted >= 3 && classification.degraded === classification.attempted) classification.humanActionRequired = true;
		return { indexed, paths: orderedPaths, errors, classification };
	}

	private async indexOne(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		classification: DocumentIndexResult["classification"],
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

		const maxTokens = Math.max(
			64,
			Math.min(
				700,
				config.get("embeddingContextSize"),
				Math.max(64, config.get("ollamaNumCtx") - 32),
			),
		);
		const chunks = chunkDocument(filePath, content, {
			maxTokens,
			fullFileMaxTokens: Math.min(400, maxTokens),
		});
		const parsedBeforeClassification = await getDocumentMetadata(this.repoRoot, filePath, content);
		const needsClassification = parsedBeforeClassification.kindSource !== "explicit" || parsedBeforeClassification.statusSource !== "explicit";
		if (needsClassification) classification.attempted += 1;
		const documentMetadata = await getDocumentMetadata(this.repoRoot, filePath, content, {
			classify: true,
			onClassifierDiagnostic: (diagnostic) => {
				classification.degraded += 1;
				classification.reasons[diagnostic.reason] = (classification.reasons[diagnostic.reason] ?? 0) + 1;
				if (diagnostic.humanActionRequired) classification.humanActionRequired = true;
			},
		});

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
