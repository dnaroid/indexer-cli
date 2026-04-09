import Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
	ArtifactRecord,
	ChunkRecord,
	DependencyRecord,
	FileMetricsRecord,
	FileRecord,
	MetadataStore,
	ProjectId,
	Snapshot,
	SnapshotId,
	SnapshotMeta,
	SnapshotStatus,
	SymbolRecord,
} from "../core/types.js";
import { SystemLogger } from "../core/logger.js";

const logger = new SystemLogger("storage-sqlite");

type TxCtx = { depth: number; spSeq: number };
const txCtx = new AsyncLocalStorage<TxCtx>();

type Migration = {
	version: number;
	name: string;
	up: (db: Database.Database) => void;
};

// To add a new migration:
// 1. Add an entry to this array with the next sequential version number
// 2. Use PRAGMA table_info / IF NOT EXISTS patterns to make migrations idempotent
// 3. Add a test case in tests/unit/storage/sqlite.test.ts
const migrations: Migration[] = [
	{
		version: 1,
		name: "add_symbol_metadata_json",
		up: (db) => {
			const columns = db.prepare("PRAGMA table_info(symbols)").all() as Array<{
				name: string;
			}>;
			const hasMetadataColumn = columns.some(
				(column) => column.name === "metadata_json",
			);

			if (!hasMetadataColumn) {
				db.exec("ALTER TABLE symbols ADD COLUMN metadata_json TEXT");
			}
		},
	},
];

export class SqliteMetadataStore implements MetadataStore {
	private db: Database.Database;
	private initialized = false;

	constructor(private readonly dbPath: string) {
		this.db = new Database(this.dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.pragma("busy_timeout = 5000");
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		logger.info("[SqliteMetadataStore] Initializing database at:", this.dbPath);
		this.db.pragma("foreign_keys = ON");
		this.createSchema();
		await this.runMigrations();
	}

	async close(): Promise<void> {
		this.db.close();
	}

	async transaction<T>(callback: () => Promise<T>): Promise<T> {
		const ctx = txCtx.getStore();

		if (ctx) {
			const spName = `sp_${ctx.depth}_${++ctx.spSeq}`;
			ctx.depth += 1;

			this.db.prepare(`SAVEPOINT ${spName}`).run();
			try {
				const result = await callback();
				this.db.prepare(`RELEASE ${spName}`).run();
				return result;
			} catch (error) {
				this.db.prepare(`ROLLBACK TO ${spName}`).run();
				this.db.prepare(`RELEASE ${spName}`).run();
				throw error;
			} finally {
				ctx.depth -= 1;
			}
		}

		return txCtx.run({ depth: 1, spSeq: 0 }, async () => {
			this.db.prepare("BEGIN IMMEDIATE").run();
			try {
				const result = await callback();
				this.db.prepare("COMMIT").run();
				return result;
			} catch (error) {
				this.db.prepare("ROLLBACK").run();
				throw error;
			}
		});
	}

	async createSnapshot(
		projectId: ProjectId,
		meta: SnapshotMeta,
	): Promise<Snapshot> {
		return this.transaction(async () => {
			const id = randomUUID();
			const createdAt = Date.now();

			this.db
				.prepare(
					"INSERT INTO snapshots (id, project_id, git_ref, status, created_at, failure_reason) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.run(id, projectId, meta.headCommit ?? "", "indexing", createdAt, null);

			return {
				id,
				projectId,
				status: "indexing",
				createdAt,
				meta: {
					...meta,
					indexedAt: createdAt,
				},
			};
		});
	}

	async getSnapshot(id: SnapshotId): Promise<Snapshot | null> {
		const row = this.db
			.prepare("SELECT * FROM snapshots WHERE id = ?")
			.get(id) as
			| {
					id: string;
					project_id: string;
					status: string;
					created_at: number;
					git_ref: string | null;
					processed_files: number | null;
					total_files: number | null;
					failure_reason: string | null;
			  }
			| undefined;

		return row ? this.mapSnapshotRow(row) : null;
	}

	async getLatestSnapshot(projectId: ProjectId): Promise<Snapshot | null> {
		const row = this.db
			.prepare(
				"SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
			)
			.get(projectId) as
			| {
					id: string;
					project_id: string;
					status: string;
					created_at: number;
					git_ref: string | null;
					processed_files: number | null;
					total_files: number | null;
					failure_reason: string | null;
			  }
			| undefined;

		return row ? this.mapSnapshotRow(row) : null;
	}

	async getLatestCompletedSnapshot(
		projectId: ProjectId,
	): Promise<Snapshot | null> {
		const row = this.db
			.prepare(
				"SELECT * FROM snapshots WHERE project_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT 1",
			)
			.get(projectId, this.mapToDbStatus("completed")) as
			| {
					id: string;
					project_id: string;
					status: string;
					created_at: number;
					git_ref: string | null;
					processed_files: number | null;
					total_files: number | null;
					failure_reason: string | null;
			  }
			| undefined;

		return row ? this.mapSnapshotRow(row) : null;
	}

	async listSnapshots(
		projectId: ProjectId,
		options?: { limit?: number; offset?: number },
	): Promise<Snapshot[]> {
		const limit = options?.limit ?? 25;
		const offset = options?.offset ?? 0;
		const rows = this.db
			.prepare(
				"SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
			)
			.all(projectId, limit, offset) as Array<{
			id: string;
			project_id: string;
			status: string;
			created_at: number;
			git_ref: string | null;
			processed_files: number | null;
			total_files: number | null;
			failure_reason: string | null;
		}>;

		return rows.map((row) => this.mapSnapshotRow(row));
	}

	async updateSnapshotStatus(
		id: SnapshotId,
		status: SnapshotStatus,
		error?: string,
	): Promise<void> {
		await this.transaction(async () => {
			this.db
				.prepare(
					"UPDATE snapshots SET status = ?, failure_reason = ? WHERE id = ?",
				)
				.run(this.mapToDbStatus(status), error ?? null, id);
		});
	}

	async updateSnapshotProgress(
		id: SnapshotId,
		processedFiles: number,
		totalFiles: number,
	): Promise<void> {
		await this.transaction(async () => {
			this.db
				.prepare(
					"UPDATE snapshots SET processed_files = ?, total_files = ? WHERE id = ?",
				)
				.run(processedFiles, totalFiles, id);
		});
	}

	async upsertFile(projectId: ProjectId, file: FileRecord): Promise<void> {
		await this.transaction(async () => {
			this.db
				.prepare(
					`INSERT INTO files (project_id, sha256, mtime_ms, size, path, snapshot_id, language_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, snapshot_id, path) DO UPDATE SET
             sha256 = excluded.sha256,
             mtime_ms = excluded.mtime_ms,
             size = excluded.size,
             language_id = excluded.language_id`,
				)
				.run(
					projectId,
					file.sha256,
					file.mtimeMs,
					file.size,
					file.path,
					file.snapshotId,
					file.languageId,
				);
		});
	}

	async listFiles(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		options?: { pathPrefix?: string },
	): Promise<FileRecord[]> {
		let sql = "SELECT * FROM files WHERE project_id = ? AND snapshot_id = ?";
		const params: Array<string | number> = [projectId, snapshotId];
		const pathPrefix = options?.pathPrefix?.replace(/\/+$/, "");

		if (pathPrefix) {
			sql += " AND (path = ? OR path LIKE ?)";
			params.push(pathPrefix, `${pathPrefix}/%`);
		}

		sql += " ORDER BY path";

		const rows = this.db.prepare(sql).all(...params) as Array<{
			snapshot_id: string;
			path: string;
			sha256: string;
			mtime_ms: number;
			size: number;
			language_id: string;
		}>;

		return rows.map((row) => ({
			snapshotId: row.snapshot_id,
			path: row.path,
			sha256: row.sha256,
			mtimeMs: row.mtime_ms,
			size: row.size,
			languageId: row.language_id,
		}));
	}

	async getFile(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		path: string,
	): Promise<FileRecord | null> {
		const row = this.db
			.prepare(
				"SELECT * FROM files WHERE project_id = ? AND snapshot_id = ? AND path = ?",
			)
			.get(projectId, snapshotId, path) as
			| {
					snapshot_id: string;
					path: string;
					sha256: string;
					mtime_ms: number;
					size: number;
					language_id: string;
			  }
			| undefined;

		if (!row) {
			return null;
		}

		return {
			snapshotId: row.snapshot_id,
			path: row.path,
			sha256: row.sha256,
			mtimeMs: row.mtime_ms,
			size: row.size,
			languageId: row.language_id,
		};
	}

	async replaceChunks(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		chunks: Omit<ChunkRecord, "snapshotId" | "filePath">[],
	): Promise<void> {
		const transaction = this.db.transaction(
			(nextChunks: Omit<ChunkRecord, "snapshotId" | "filePath">[]) => {
				this.db
					.prepare(
						"DELETE FROM chunks WHERE project_id = ? AND snapshot_id = ? AND file_path = ?",
					)
					.run(projectId, snapshotId, filePath);

				if (nextChunks.length === 0) {
					return;
				}

				const insertStmt = this.db.prepare(
					`INSERT INTO chunks (
          project_id,
          chunk_id,
          file_path,
          snapshot_id,
          start_line,
          end_line,
          content_hash,
          token_estimate,
          chunk_type,
          primary_symbol,
          has_overlap
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				);

				for (const chunk of nextChunks) {
					insertStmt.run(
						projectId,
						chunk.chunkId,
						filePath,
						snapshotId,
						chunk.startLine,
						chunk.endLine,
						chunk.contentHash,
						chunk.tokenEstimate,
						chunk.chunkType ?? "full_file",
						chunk.primarySymbol ?? null,
						chunk.hasOverlap ? 1 : 0,
					);
				}
			},
		);

		transaction(chunks);
	}

	async listChunks(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath?: string,
	): Promise<ChunkRecord[]> {
		let sql = "SELECT * FROM chunks WHERE project_id = ? AND snapshot_id = ?";
		const params: Array<string | number> = [projectId, snapshotId];

		if (filePath) {
			sql += " AND file_path = ?";
			params.push(filePath);
		}

		sql += " ORDER BY file_path, start_line";

		const rows = this.db.prepare(sql).all(...params) as Array<{
			snapshot_id: string;
			chunk_id: string;
			file_path: string;
			start_line: number;
			end_line: number;
			content_hash: string;
			token_estimate: number;
			chunk_type: ChunkRecord["chunkType"] | null;
			primary_symbol: string | null;
			has_overlap: number | null;
		}>;

		return rows.map((row) => ({
			snapshotId: row.snapshot_id,
			chunkId: row.chunk_id,
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			contentHash: row.content_hash,
			tokenEstimate: row.token_estimate,
			chunkType: row.chunk_type ?? "full_file",
			primarySymbol: row.primary_symbol ?? undefined,
			hasOverlap: Boolean(row.has_overlap),
		}));
	}

	async getChunk(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		chunkId: string,
	): Promise<ChunkRecord | null> {
		const row = this.db
			.prepare(
				"SELECT * FROM chunks WHERE project_id = ? AND snapshot_id = ? AND chunk_id = ?",
			)
			.get(projectId, snapshotId, chunkId) as
			| {
					snapshot_id: string;
					chunk_id: string;
					file_path: string;
					start_line: number;
					end_line: number;
					content_hash: string;
					token_estimate: number;
					chunk_type: ChunkRecord["chunkType"] | null;
					primary_symbol: string | null;
					has_overlap: number | null;
			  }
			| undefined;

		if (!row) {
			return null;
		}

		return {
			snapshotId: row.snapshot_id,
			chunkId: row.chunk_id,
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			contentHash: row.content_hash,
			tokenEstimate: row.token_estimate,
			chunkType: row.chunk_type ?? "full_file",
			primarySymbol: row.primary_symbol ?? undefined,
			hasOverlap: Boolean(row.has_overlap),
		};
	}

	async replaceSymbols(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		symbols: Omit<SymbolRecord, "snapshotId" | "filePath">[],
	): Promise<void> {
		const transaction = this.db.transaction(
			(nextSymbols: Omit<SymbolRecord, "snapshotId" | "filePath">[]) => {
				this.db
					.prepare(
						"DELETE FROM symbols WHERE project_id = ? AND snapshot_id = ? AND file_path = ?",
					)
					.run(projectId, snapshotId, filePath);

				if (nextSymbols.length === 0) {
					return;
				}

				const insertStmt = this.db.prepare(
					`INSERT INTO symbols (project_id, id, snapshot_id, file_path, kind, name, container_name, exported, range_json, signature, doc_comment, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				);

				for (const symbol of nextSymbols) {
					insertStmt.run(
						projectId,
						symbol.id,
						snapshotId,
						filePath,
						symbol.kind,
						symbol.name,
						symbol.containerName ?? null,
						symbol.exported ? 1 : 0,
						JSON.stringify(symbol.range),
						symbol.signature ?? null,
						symbol.docComment ?? null,
						symbol.metadata ? JSON.stringify(symbol.metadata) : null,
					);
				}
			},
		);

		transaction(symbols);
	}

	async listSymbols(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath?: string,
	): Promise<SymbolRecord[]> {
		let sql = "SELECT * FROM symbols WHERE project_id = ? AND snapshot_id = ?";
		const params: Array<string | number> = [projectId, snapshotId];

		if (filePath) {
			sql += " AND file_path = ?";
			params.push(filePath);
		}

		sql += " ORDER BY file_path, name";

		const rows = this.db.prepare(sql).all(...params) as Array<{
			snapshot_id: string;
			id: string;
			file_path: string;
			kind: string;
			name: string;
			container_name: string | null;
			exported: number;
			range_json: string;
			signature: string | null;
			doc_comment: string | null;
			metadata_json: string | null;
		}>;

		return rows.map((row) => ({
			snapshotId: row.snapshot_id,
			id: row.id,
			filePath: row.file_path,
			kind: row.kind,
			name: row.name,
			containerName: row.container_name ?? undefined,
			exported: row.exported === 1,
			range: JSON.parse(row.range_json),
			signature: row.signature ?? undefined,
			docComment: row.doc_comment ?? undefined,
			metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
		}));
	}

	async searchSymbols(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		namePattern: string,
	): Promise<SymbolRecord[]> {
		const rows = this.db
			.prepare(
				"SELECT * FROM symbols WHERE project_id = ? AND snapshot_id = ? AND name LIKE ? ORDER BY name",
			)
			.all(projectId, snapshotId, `%${namePattern}%`) as Array<{
			snapshot_id: string;
			id: string;
			file_path: string;
			kind: string;
			name: string;
			container_name: string | null;
			exported: number;
			range_json: string;
			signature: string | null;
			doc_comment: string | null;
			metadata_json: string | null;
		}>;

		return rows.map((row) => ({
			snapshotId: row.snapshot_id,
			id: row.id,
			filePath: row.file_path,
			kind: row.kind,
			name: row.name,
			containerName: row.container_name ?? undefined,
			exported: row.exported === 1,
			range: JSON.parse(row.range_json),
			signature: row.signature ?? undefined,
			docComment: row.doc_comment ?? undefined,
			metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
		}));
	}

	async replaceDependencies(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
		dependencies: Omit<DependencyRecord, "snapshotId" | "fromPath">[],
	): Promise<void> {
		const transaction = this.db.transaction(
			(
				nextDependencies: Omit<DependencyRecord, "snapshotId" | "fromPath">[],
			) => {
				this.db
					.prepare(
						"DELETE FROM dependencies WHERE project_id = ? AND snapshot_id = ? AND from_path = ?",
					)
					.run(projectId, snapshotId, filePath);

				if (nextDependencies.length === 0) {
					return;
				}

				const insertStmt = this.db.prepare(
					`INSERT INTO dependencies (project_id, id, snapshot_id, from_path, to_specifier, to_path, kind, dependency_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				);

				for (const dependency of nextDependencies) {
					insertStmt.run(
						projectId,
						dependency.id,
						snapshotId,
						filePath,
						dependency.toSpecifier,
						dependency.toPath ?? null,
						dependency.kind,
						dependency.dependencyType ?? "unresolved",
					);
				}
			},
		);

		transaction(dependencies);
	}

	async listDependencies(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath?: string,
	): Promise<DependencyRecord[]> {
		let sql =
			"SELECT * FROM dependencies WHERE project_id = ? AND snapshot_id = ?";
		const params: Array<string | number> = [projectId, snapshotId];

		if (filePath) {
			sql += " AND from_path = ?";
			params.push(filePath);
		}

		sql += " ORDER BY from_path, to_specifier";

		const rows = this.db.prepare(sql).all(...params) as Array<{
			snapshot_id: string;
			id: string;
			from_path: string;
			to_specifier: string;
			to_path: string | null;
			kind: DependencyRecord["kind"];
			dependency_type: DependencyRecord["dependencyType"];
		}>;

		return rows.map((row) => ({
			snapshotId: row.snapshot_id,
			id: row.id,
			fromPath: row.from_path,
			toSpecifier: row.to_specifier,
			toPath: row.to_path ?? undefined,
			kind: row.kind,
			dependencyType: row.dependency_type,
		}));
	}

	async getDependents(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		targetPath: string,
	): Promise<DependencyRecord[]> {
		const rows = this.db
			.prepare(
				"SELECT * FROM dependencies WHERE project_id = ? AND snapshot_id = ? AND to_path = ? ORDER BY from_path",
			)
			.all(projectId, snapshotId, targetPath) as Array<{
			snapshot_id: string;
			id: string;
			from_path: string;
			to_specifier: string;
			to_path: string | null;
			kind: DependencyRecord["kind"];
			dependency_type: DependencyRecord["dependencyType"];
		}>;

		return rows.map((row) => ({
			snapshotId: row.snapshot_id,
			id: row.id,
			fromPath: row.from_path,
			toSpecifier: row.to_specifier,
			toPath: row.to_path ?? undefined,
			kind: row.kind,
			dependencyType: row.dependency_type,
		}));
	}

	async upsertFileMetrics(
		projectId: ProjectId,
		metrics: FileMetricsRecord,
	): Promise<void> {
		await this.transaction(async () => {
			this.db
				.prepare(
					`INSERT INTO file_metrics (project_id, snapshot_id, file_path, metrics_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(project_id, snapshot_id, file_path) DO UPDATE SET
             metrics_json = excluded.metrics_json,
             updated_at = excluded.updated_at`,
				)
				.run(
					projectId,
					metrics.snapshotId,
					metrics.filePath,
					JSON.stringify(metrics.metrics),
					Date.now(),
				);
		});
	}

	async getFileMetrics(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		filePath: string,
	): Promise<FileMetricsRecord | null> {
		const row = this.db
			.prepare(
				"SELECT metrics_json FROM file_metrics WHERE project_id = ? AND snapshot_id = ? AND file_path = ?",
			)
			.get(projectId, snapshotId, filePath) as
			| { metrics_json: string }
			| undefined;

		if (!row) {
			return null;
		}

		return {
			snapshotId,
			filePath,
			metrics: this.parseMetrics(row.metrics_json),
		};
	}

	async listFileMetrics(
		projectId: ProjectId,
		snapshotId: SnapshotId,
	): Promise<FileMetricsRecord[]> {
		const rows = this.db
			.prepare(
				"SELECT file_path, metrics_json FROM file_metrics WHERE project_id = ? AND snapshot_id = ?",
			)
			.all(projectId, snapshotId) as Array<{
			file_path: string;
			metrics_json: string;
		}>;

		return rows.map((row) => ({
			snapshotId,
			filePath: row.file_path,
			metrics: this.parseMetrics(row.metrics_json),
		}));
	}

	async copyUnchangedFileData(
		projectId: ProjectId,
		fromSnapshotId: SnapshotId,
		toSnapshotId: SnapshotId,
		unchangedPaths: string[],
	): Promise<void> {
		if (unchangedPaths.length === 0) {
			return;
		}

		const placeholders = unchangedPaths.map(() => "?").join(",");
		const params = [
			projectId,
			toSnapshotId,
			projectId,
			fromSnapshotId,
			...unchangedPaths,
		];

		const transaction = this.db.transaction(() => {
			this.db
				.prepare(
					`INSERT INTO files (project_id, sha256, mtime_ms, size, path, snapshot_id, language_id)
           SELECT ?, sha256, mtime_ms, size, path, ?, language_id
           FROM files
           WHERE project_id = ? AND snapshot_id = ? AND path IN (${placeholders})`,
				)
				.run(...params);

			this.db
				.prepare(
					`INSERT INTO chunks (
            project_id,
            chunk_id,
            file_path,
            snapshot_id,
            start_line,
            end_line,
            content_hash,
            token_estimate,
            chunk_type,
            primary_symbol,
            has_overlap
          )
           SELECT ?, chunk_id, file_path, ?, start_line, end_line, content_hash, token_estimate, chunk_type, primary_symbol, has_overlap
           FROM chunks
           WHERE project_id = ? AND snapshot_id = ? AND file_path IN (${placeholders})`,
				)
				.run(...params);

			this.db
				.prepare(
					`INSERT INTO symbols (project_id, id, snapshot_id, file_path, kind, name, container_name, exported, range_json, signature, doc_comment, metadata_json)
           SELECT ?, id, ?, file_path, kind, name, container_name, exported, range_json, signature, doc_comment, metadata_json
           FROM symbols
           WHERE project_id = ? AND snapshot_id = ? AND file_path IN (${placeholders})`,
				)
				.run(...params);

			this.db
				.prepare(
					`INSERT INTO dependencies (project_id, id, snapshot_id, from_path, to_specifier, to_path, kind, dependency_type)
           SELECT ?, id, ?, from_path, to_specifier, to_path, kind, dependency_type
           FROM dependencies
           WHERE project_id = ? AND snapshot_id = ? AND from_path IN (${placeholders})`,
				)
				.run(...params);

			this.db
				.prepare(
					`INSERT INTO file_metrics (project_id, snapshot_id, file_path, metrics_json, updated_at)
           SELECT ?, ?, file_path, metrics_json, updated_at
           FROM file_metrics
           WHERE project_id = ? AND snapshot_id = ? AND file_path IN (${placeholders})`,
				)
				.run(...params);
		});

		transaction();
	}

	async upsertArtifact(
		projectId: ProjectId,
		artifact: Omit<ArtifactRecord, "updatedAt">,
	): Promise<void> {
		await this.transaction(async () => {
			this.db
				.prepare(
					`INSERT INTO artifacts (project_id, snapshot_id, artifact_type, scope, data_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, snapshot_id, artifact_type, scope) DO UPDATE SET
             data_json = excluded.data_json,
             updated_at = excluded.updated_at`,
				)
				.run(
					projectId,
					artifact.snapshotId,
					artifact.artifactType,
					artifact.scope,
					artifact.dataJson,
					Date.now(),
				);
		});
	}

	async getArtifact(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		artifactType: string,
		scope: string,
	): Promise<ArtifactRecord | null> {
		const row = this.db
			.prepare(
				"SELECT * FROM artifacts WHERE project_id = ? AND snapshot_id = ? AND artifact_type = ? AND scope = ?",
			)
			.get(projectId, snapshotId, artifactType, scope) as
			| {
					project_id: string;
					snapshot_id: string;
					artifact_type: string;
					scope: string;
					data_json: string;
					updated_at: number;
			  }
			| undefined;

		if (!row) {
			return null;
		}

		return {
			projectId: row.project_id,
			snapshotId: row.snapshot_id,
			artifactType: row.artifact_type,
			scope: row.scope,
			dataJson: row.data_json,
			updatedAt: row.updated_at,
		};
	}

	async listArtifacts(
		projectId: ProjectId,
		snapshotId: SnapshotId,
		artifactType?: string,
	): Promise<ArtifactRecord[]> {
		let sql =
			"SELECT * FROM artifacts WHERE project_id = ? AND snapshot_id = ?";
		const params: Array<string | number> = [projectId, snapshotId];

		if (artifactType) {
			sql += " AND artifact_type = ?";
			params.push(artifactType);
		}

		const rows = this.db.prepare(sql).all(...params) as Array<{
			project_id: string;
			snapshot_id: string;
			artifact_type: string;
			scope: string;
			data_json: string;
			updated_at: number;
		}>;

		return rows.map((row) => ({
			projectId: row.project_id,
			snapshotId: row.snapshot_id,
			artifactType: row.artifact_type,
			scope: row.scope,
			dataJson: row.data_json,
			updatedAt: row.updated_at,
		}));
	}

	async clearProjectMetadata(
		projectId: ProjectId,
		keepSnapshotId?: SnapshotId,
		options?: { preserveActiveIndexing?: boolean },
	): Promise<void> {
		await this.transaction(async () => {
			let sql = "DELETE FROM snapshots WHERE project_id = ?";
			const params: Array<string | number> = [projectId];

			if (keepSnapshotId) {
				sql += " AND id != ?";
				params.push(keepSnapshotId);
			}

			if (options?.preserveActiveIndexing) {
				// Protect "indexing" snapshots created within the last 5 minutes —
				// they may belong to a concurrent process still running.
				sql += " AND (status != 'indexing' OR created_at < ?)";
				params.push(Date.now() - 5 * 60 * 1000);
			}

			this.db.prepare(sql).run(...params);
		});
	}

	private parseMetrics(metricsJson: string): FileMetricsRecord["metrics"] {
		try {
			const parsed = JSON.parse(metricsJson || "{}") as Partial<
				FileMetricsRecord["metrics"]
			>;
			return {
				complexity: parsed.complexity ?? 0,
				maintainability: parsed.maintainability ?? 0,
				churn: parsed.churn ?? 0,
				testCoverage: parsed.testCoverage,
			};
		} catch {
			return {
				complexity: 0,
				maintainability: 0,
				churn: 0,
				testCoverage: undefined,
			};
		}
	}

	private mapSnapshotRow(row: {
		id: string;
		project_id: string;
		status: string;
		created_at: number;
		git_ref: string | null;
		processed_files: number | null;
		total_files: number | null;
		failure_reason: string | null;
	}): Snapshot {
		return {
			id: row.id,
			projectId: row.project_id,
			status: this.mapSnapshotStatus(row.status),
			createdAt: row.created_at,
			meta: {
				headCommit: row.git_ref ?? undefined,
				indexedAt: row.created_at,
			},
			processedFiles: row.processed_files ?? undefined,
			totalFiles: row.total_files ?? undefined,
			error: row.failure_reason ?? undefined,
		};
	}

	private createSchema(): void {
		this.db.exec(`
      DROP TABLE IF EXISTS logs;

      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        git_ref TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        failure_reason TEXT,
        processed_files INTEGER DEFAULT 0,
        total_files INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS files (
        project_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        size INTEGER NOT NULL,
        language_id TEXT NOT NULL,
        PRIMARY KEY (project_id, snapshot_id, path),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chunks (
        project_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        token_estimate INTEGER NOT NULL,
        chunk_type TEXT DEFAULT 'full_file',
        primary_symbol TEXT,
        has_overlap BOOLEAN DEFAULT 0,
        PRIMARY KEY (project_id, snapshot_id, chunk_id),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS symbols (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        container_name TEXT,
        exported INTEGER NOT NULL,
        range_json TEXT NOT NULL,
        signature TEXT,
        doc_comment TEXT,
        metadata_json TEXT,
        PRIMARY KEY (project_id, snapshot_id, id),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS dependencies (
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        from_path TEXT NOT NULL,
        to_specifier TEXT NOT NULL,
        to_path TEXT,
        kind TEXT NOT NULL,
        dependency_type TEXT DEFAULT 'unresolved',
        PRIMARY KEY (project_id, snapshot_id, id),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        project_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, snapshot_id, artifact_type, scope),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS file_metrics (
        project_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, snapshot_id, file_path),
        FOREIGN KEY (snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_snapshot_name
        ON symbols(snapshot_id, name);
      CREATE INDEX IF NOT EXISTS idx_symbols_project_kind
        ON symbols(project_id, kind);
      CREATE INDEX IF NOT EXISTS idx_symbols_file_path
        ON symbols(file_path);

      CREATE INDEX IF NOT EXISTS idx_files_project_path
        ON files(project_id, path);
      CREATE INDEX IF NOT EXISTS idx_files_snapshot
        ON files(snapshot_id);

      CREATE INDEX IF NOT EXISTS idx_chunks_file_path
        ON chunks(file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_primary_symbol
        ON chunks(primary_symbol);

      CREATE INDEX IF NOT EXISTS idx_dependencies_from_path
        ON dependencies(from_path);
      CREATE INDEX IF NOT EXISTS idx_dependencies_to_path
        ON dependencies(to_path);
      CREATE INDEX IF NOT EXISTS idx_dependencies_snapshot
        ON dependencies(snapshot_id);
    `);
	}

	private async runMigrations(): Promise<void> {
		const currentVersion = this.getCurrentSchemaVersion();
		logger.info(
			"[SqliteMetadataStore] Current schema version:",
			currentVersion,
		);

		for (const migration of migrations) {
			if (migration.version > currentVersion) {
				logger.info(
					`[SqliteMetadataStore] Running migration ${migration.version}: ${migration.name}`,
				);
				migration.up(this.db);
				this.db
					.prepare(
						"INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
					)
					.run(migration.version, Date.now());
			} else {
				logger.info(
					`[SqliteMetadataStore] Skipping migration ${migration.version}: ${migration.name} (already applied)`,
				);
			}
		}
	}

	private getCurrentSchemaVersion(): number {
		try {
			const row = this.db
				.prepare("SELECT MAX(version) as version FROM schema_migrations")
				.get() as { version: number | null } | undefined;
			return row?.version ?? 0;
		} catch {
			return 0;
		}
	}

	private mapSnapshotStatus(status: string): SnapshotStatus {
		const statusMap: Record<string, SnapshotStatus> = {
			pending: "pending",
			indexing: "indexing",
			ready: "completed",
			completed: "completed",
			failed: "failed",
		};
		return statusMap[status] ?? "pending";
	}

	private mapToDbStatus(status: SnapshotStatus): string {
		const statusMap: Record<SnapshotStatus, string> = {
			pending: "pending",
			indexing: "indexing",
			completed: "ready",
			failed: "failed",
		};
		return statusMap[status];
	}
}
