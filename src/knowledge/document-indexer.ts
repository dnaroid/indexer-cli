import { readFile, stat } from "node:fs/promises";
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
	): Promise<DocumentIndexResult> {
		const result = await this.indexPaths(projectId, snapshotId, await this.scan());
		await writeKnowledgeIndexConfigArtifact(this.metadata, projectId, snapshotId);
		return result;
	}

	async indexIncremental(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		plan: DocumentIncrementalPlan,
	): Promise<DocumentIndexResult> {
		const result = await this.indexPaths(projectId, snapshotId, [
			...plan.added,
			...plan.modified,
		]);
		await writeKnowledgeIndexConfigArtifact(this.metadata, projectId, snapshotId);
		return result;
	}

	private async indexPaths(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		paths: string[],
	): Promise<DocumentIndexResult> {
		const errors: string[] = [];
		let indexed = 0;

		for (const filePath of uniqueSorted(paths)) {
			try {
				await this.indexOne(projectId, snapshotId, filePath);
				indexed += 1;
			} catch (error) {
				errors.push(
					`${filePath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		return { indexed, paths: uniqueSorted(paths), errors };
	}

	private async indexOne(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
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

		await this.knowledgeStore.replaceKnowledgeChunks(
			projectId,
			snapshotId,
			filePath,
			chunks.map(({ content, ...chunk }) => ({
				...chunk,
				metadata: { ...chunk.metadata, searchText: content },
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
