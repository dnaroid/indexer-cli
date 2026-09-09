export type ProjectId = string;
export const DEFAULT_PROJECT_ID: ProjectId = "default";
export type SnapshotId = string;
export type ChunkId = string;
export type SymbolId = string;
export type DependencyId = string;

export type FileDomain = "code" | "document";

export type KnowledgeClassification =
	| "spec"
	| "spec-like"
	| "meta-index"
	| "design-only"
	| "guide"
	| "other";
export type KnowledgeBehaviorType = "as-is" | "change" | "mixed" | "unknown";
export type KnowledgeLifecycle =
	| "active"
	| "proposed"
	| "historical"
	| "superseded"
	| "unknown";
export type KnowledgeRelationTargetKind = "code" | "knowledge";
export type KnowledgeRelationKind =
	| "implements"
	| "tests"
	| "related"
	| "supersedes"
	| "superseded-by";
export type KnowledgeRelationProvenance = "explicit" | "inferred";

export type SnapshotStatus = "pending" | "indexing" | "completed" | "failed";

export interface Snapshot {
	id: SnapshotId;
	projectId: ProjectId;
	status: SnapshotStatus;
	createdAt: number;
	meta: SnapshotMeta;
	processedFiles?: number;
	totalFiles?: number;
	error?: string;
}

export interface SnapshotMeta {
	headCommit?: string;
	isDirty?: boolean;
	indexedAt: number;
	changedFiles?: string[];
	[key: string]: unknown;
}

export interface FileRecord {
	snapshotId: SnapshotId;
	path: string;
	sha256: string;
	mtimeMs: number;
	size: number;
	languageId: string;
	/** Omitted legacy records are code; document files are explicitly marked. */
	domain?: FileDomain;
}

export interface ChunkRecord {
	snapshotId: SnapshotId;
	chunkId: ChunkId;
	filePath: string;
	startLine: number;
	endLine: number;
	contentHash: string;
	tokenEstimate: number;
	chunkType?:
		| "full_file"
		| "imports"
		| "preamble"
		| "declaration"
		| "module_section"
		| "impl"
		| "types";
	primarySymbol?: string;
	hasOverlap?: boolean;
	metadata?: ChunkMetadata;
}

export interface ChunkMetadata {
	overlappingSymbols?: ChunkOverlapSymbol[];
	[key: string]: unknown;
}

export interface ChunkOverlapSymbol {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	signature?: string;
}

export interface SymbolRecord {
	snapshotId: SnapshotId;
	id: SymbolId;
	filePath: string;
	kind: string;
	name: string;
	containerName?: string;
	exported: boolean;
	range: Range;
	signature?: string;
	docComment?: string;
	metadata?: Record<string, unknown>;
}

export interface Range {
	start: { line: number; character: number };
	end: { line: number; character: number };
}

export interface DependencyRecord {
	snapshotId: SnapshotId;
	id: DependencyId;
	fromPath: string;
	toSpecifier: string;
	toPath?: string;
	kind: "import" | "require" | "dynamic_import";
	dependencyType?: "internal" | "external" | "builtin" | "unresolved";
}

export interface ArtifactRecord {
	projectId: ProjectId;
	snapshotId: SnapshotId;
	artifactType: string;
	scope: string;
	dataJson: string;
	updatedAt: number;
}

export interface FileMetricsRecord {
	snapshotId: SnapshotId;
	filePath: string;
	metrics: {
		complexity: number;
		maintainability: number;
		churn: number;
		testCoverage?: number;
	};
}

export interface VectorRecord {
	projectId: ProjectId;
	chunkId: ChunkId;
	snapshotId: SnapshotId;
	filePath: string;
	startLine: number;
	endLine: number;
	embedding: number[];
	contentHash: string;
	chunkType?: string;
	primarySymbol?: string;
	/** Omitted legacy records are code vectors. */
	domain?: FileDomain;
}

export interface VectorSearchFilters {
	projectId: ProjectId;
	snapshotId?: SnapshotId;
	filePath?: string;
	filePaths?: string[];
	pathPrefix?: string;
	chunkTypes?: string[];
	/** Defaults to code so document vectors never enter normal code search. */
	domain?: FileDomain;
}

export interface VectorSearchResult {
	chunkId: ChunkId;
	snapshotId: SnapshotId;
	filePath: string;
	startLine: number;
	endLine: number;
	contentHash: string;
	score: number;
	distance?: number;
	chunkType?: string;
	primarySymbol?: string;
	domain?: FileDomain;
}

export interface KnowledgeEntry {
	projectId: ProjectId;
	path: string;
	classification: KnowledgeClassification;
	behaviorType: KnowledgeBehaviorType;
	lifecycle: KnowledgeLifecycle;
	confidence: string;
	title: string;
	summary: string;
	topics: string[];
	indexedSourceHash: string;
	indexedAt: number;
	verifiedSourceHash?: string;
	verifiedRelationsHash?: string;
	verifiedAt?: number;
	metadata?: Record<string, unknown>;
}

export interface KnowledgeRelation {
	projectId: ProjectId;
	sourcePath: string;
	targetPath: string;
	targetKind: KnowledgeRelationTargetKind;
	relationKind: KnowledgeRelationKind;
	provenance: KnowledgeRelationProvenance;
	metadata?: Record<string, unknown>;
}

export interface KnowledgeVerifiedInput {
	projectId: ProjectId;
	sourcePath: string;
	inputPath: string;
	inputHash: string;
	verifiedAt: number;
}

export interface KnowledgeChunkRecord {
	projectId: ProjectId;
	snapshotId: SnapshotId;
	chunkId: ChunkId;
	filePath: string;
	startLine: number;
	endLine: number;
	contentHash: string;
	chunkType: "doc_title" | "doc_section" | "doc_full" | "doc_links";
	heading?: string;
	metadata?: Record<string, unknown>;
}

export interface KnowledgeStore {
	upsertKnowledgeEntry(entry: KnowledgeEntry): Promise<void>;
	getKnowledgeEntry(
		projectId: ProjectId,
		path: string,
	): Promise<KnowledgeEntry | null>;
	listKnowledgeEntries(projectId: ProjectId): Promise<KnowledgeEntry[]>;
	deleteKnowledgeEntry(projectId: ProjectId, path: string): Promise<void>;
	upsertKnowledgeRelation(relation: KnowledgeRelation): Promise<void>;
	listKnowledgeRelations(
		projectId: ProjectId,
		options?: { sourcePath?: string },
	): Promise<KnowledgeRelation[]>;
	deleteKnowledgeRelation(
		projectId: ProjectId,
		relation: Omit<KnowledgeRelation, "projectId" | "metadata"> & {
			metadata?: Record<string, unknown>;
		},
	): Promise<void>;
	upsertKnowledgeVerifiedInput(input: KnowledgeVerifiedInput): Promise<void>;
	listKnowledgeVerifiedInputs(
		projectId: ProjectId,
		sourcePath: string,
	): Promise<KnowledgeVerifiedInput[]>;
	deleteKnowledgeVerifiedInput(
		projectId: ProjectId,
		sourcePath: string,
		inputPath: string,
	): Promise<void>;
	replaceKnowledgeVerifiedInputs(
		projectId: ProjectId,
		sourcePath: string,
		inputs: Array<Omit<KnowledgeVerifiedInput, "projectId" | "sourcePath">>,
	): Promise<void>;
	clearKnowledgeVerification(
		projectId: ProjectId,
		sourcePath: string,
	): Promise<void>;
	replaceKnowledgeChunks(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		chunks: Omit<KnowledgeChunkRecord, "projectId" | "snapshotId" | "filePath">[],
	): Promise<void>;
	listKnowledgeChunks(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath?: string,
	): Promise<KnowledgeChunkRecord[]>;
}

export interface EmbeddingProvider {
	readonly id: string;
	initialize(): Promise<void>;
	close(): Promise<void>;
	getDimension(): number;
	embed(texts: string[]): Promise<number[][]>;
}

export interface MetadataStore {
	initialize(): Promise<void>;
	close(): Promise<void>;
	transaction<T>(callback: () => Promise<T>): Promise<T>;
	createSnapshot(projectId: ProjectId, meta: SnapshotMeta): Promise<Snapshot>;
	getSnapshot(id: SnapshotId): Promise<Snapshot | null>;
	getLatestSnapshot(projectId: ProjectId): Promise<Snapshot | null>;
	getLatestCompletedSnapshot(projectId: ProjectId): Promise<Snapshot | null>;
	listSnapshots(
		projectId: ProjectId,
		options?: { limit?: number; offset?: number },
	): Promise<Snapshot[]>;
	updateSnapshotStatus(
		id: SnapshotId,
		status: SnapshotStatus,
		error?: string,
	): Promise<void>;
	updateSnapshotProgress(
		id: SnapshotId,
		processedFiles: number,
		totalFiles: number,
	): Promise<void>;
	upsertFile(projectId: ProjectId, file: FileRecord): Promise<void>;
	listFiles(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		options?: { pathPrefix?: string; domain?: FileDomain },
	): Promise<FileRecord[]>;
	getFile(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		path: string,
		options?: { domain?: FileDomain },
	): Promise<FileRecord | null>;
	replaceChunks(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		chunks: Omit<ChunkRecord, "snapshotId" | "filePath">[],
	): Promise<void>;
	listChunks(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath?: string,
	): Promise<ChunkRecord[]>;
	replaceSymbols(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		symbols: Omit<SymbolRecord, "snapshotId" | "filePath">[],
	): Promise<void>;
	listSymbols(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath?: string,
	): Promise<SymbolRecord[]>;
	searchSymbols(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		namePattern: string,
	): Promise<SymbolRecord[]>;
	replaceDependencies(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		dependencies: Omit<DependencyRecord, "snapshotId" | "fromPath">[],
	): Promise<void>;
	listDependencies(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath?: string,
	): Promise<DependencyRecord[]>;
	getDependents(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		targetPath: string,
	): Promise<DependencyRecord[]>;
	upsertFileMetrics(
		projectId: ProjectId,
		metrics: FileMetricsRecord,
	): Promise<void>;
	getFileMetrics(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
	): Promise<FileMetricsRecord | null>;
	listFileMetrics(
		projectId: ProjectId,
		snapshotId: SnapshotId,
	): Promise<FileMetricsRecord[]>;
	upsertArtifact(
		projectId: ProjectId,
		artifact: Omit<ArtifactRecord, "updatedAt">,
	): Promise<void>;
	getArtifact(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		artifactType: string,
		scope: string,
	): Promise<ArtifactRecord | null>;
	listArtifacts(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		artifactType?: string,
	): Promise<ArtifactRecord[]>;
	copyUnchangedFileData(
		projectId: ProjectId,
		fromSnapshotId: SnapshotId,
		toSnapshotId: SnapshotId,
		unchangedPaths: string[],
	): Promise<void>;
	clearProjectMetadata(
		id: ProjectId,
		keepSnapshotId?: SnapshotId,
		options?: { preserveActiveIndexing?: boolean },
	): Promise<void>;
}

export interface VectorStore {
	initialize(): Promise<void>;
	close(): Promise<void>;
	upsert(vectors: VectorRecord[]): Promise<void>;
	search(
		queryEmbedding: number[],
		topK: number,
		filters: VectorSearchFilters,
	): Promise<VectorSearchResult[]>;
	countVectors(filters: VectorSearchFilters): Promise<number>;
	deleteBySnapshot(projectId: ProjectId, snapshotId: SnapshotId): Promise<void>;
	copyVectors(
		projectId: ProjectId,
		fromSnapshotId: SnapshotId,
		toSnapshotId: SnapshotId,
		excludeFilePaths: string[],
	): Promise<void>;
	deleteByProject(projectId: ProjectId): Promise<void>;
}

export interface GitDiff {
	added: string[];
	modified: string[];
	deleted: string[];
}

export interface GitOperations {
	getHeadCommit(repoRoot: string): Promise<string | null>;
	isDirty(repoRoot: string): Promise<boolean>;
	getChangedFiles(repoRoot: string, sinceCommit: string): Promise<GitDiff>;
	getWorkingTreeChanges(repoRoot: string): Promise<GitDiff>;
	getChurnByFile(
		repoRoot: string,
		options?: { sinceDays?: number },
	): Promise<Record<string, number>>;
}
