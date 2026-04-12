export type ProjectId = string;
export const DEFAULT_PROJECT_ID: ProjectId = "default";
export type SnapshotId = string;
export type ChunkId = string;
export type SymbolId = string;
export type DependencyId = string;

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
}

export interface VectorSearchFilters {
	projectId: ProjectId;
	snapshotId?: SnapshotId;
	filePath?: string;
	pathPrefix?: string;
	chunkTypes?: string[];
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
		options?: { pathPrefix?: string },
	): Promise<FileRecord[]>;
	getFile(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		path: string,
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
