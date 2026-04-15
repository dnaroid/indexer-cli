import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type {
	ChunkId,
	ProjectId,
	SnapshotId,
	VectorRecord,
	VectorSearchFilters,
	VectorSearchResult,
	VectorStore,
} from "../core/types.js";

export interface SqliteVecVectorStoreOptions {
	dbPath: string;
	vectorSize: number;
}

export type LanceDbVectorStoreOptions = SqliteVecVectorStoreOptions;

export const REQUIRED_COLUMNS = [
	"project_id",
	"chunk_id",
	"snapshot_id",
	"file_path",
	"start_line",
	"end_line",
	"content_hash",
	"chunk_type",
	"primary_symbol",
	"embedding",
] as const;

const UPSERT_BATCH_SIZE = 200;

type VectorMetaRow = {
	chunk_id: string;
	project_id: string;
	snapshot_id: string;
	file_path: string;
	start_line: number;
	end_line: number;
	content_hash: string;
	chunk_type: string;
	primary_symbol: string;
};

type VectorCopyRow = VectorMetaRow & {
	embedding: unknown;
};

type VectorSearchRow = VectorMetaRow & {
	distance: number;
};

export class SqliteVecVectorStore implements VectorStore {
	private readonly dbPath: string;
	private readonly vectorSize: number;
	private db: Database.Database | null;
	private initialized = false;

	constructor(options: SqliteVecVectorStoreOptions) {
		this.dbPath = options.dbPath;
		this.vectorSize = options.vectorSize;
		this.db = this.openDatabase();
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		const db = this.getDb();
		const initSchema = db.transaction(() => {
			db.exec(`
				CREATE TABLE IF NOT EXISTS vector_meta (
					chunk_id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL,
					snapshot_id TEXT NOT NULL,
					file_path TEXT NOT NULL,
					start_line INTEGER NOT NULL,
					end_line INTEGER NOT NULL,
					content_hash TEXT NOT NULL,
					chunk_type TEXT NOT NULL DEFAULT '',
					primary_symbol TEXT NOT NULL DEFAULT ''
				);

				CREATE INDEX IF NOT EXISTS idx_vector_meta_snapshot_id
				ON vector_meta(snapshot_id);

				CREATE INDEX IF NOT EXISTS idx_vector_meta_project_id
				ON vector_meta(project_id);

				CREATE INDEX IF NOT EXISTS idx_vector_meta_file_path
				ON vector_meta(file_path);
			`);

			const vecChunksExists = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'",
				)
				.get();
			if (!vecChunksExists) {
				db.exec(`
					CREATE VIRTUAL TABLE vec_chunks USING vec0(
						chunk_id TEXT PRIMARY KEY,
						embedding float[${this.vectorSize}]
					)
				`);
			}
		});

		initSchema.immediate();

		this.initialized = true;
	}

	async close(): Promise<void> {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
		this.initialized = false;
	}

	async upsert(vectors: VectorRecord[]): Promise<void> {
		if (vectors.length === 0) {
			return;
		}

		await this.initialize();
		const db = this.getDb();

		const deleteVectorStatement = db.prepare(
			"DELETE FROM vec_chunks WHERE chunk_id = ?",
		);
		const deleteMetaStatement = db.prepare(
			"DELETE FROM vector_meta WHERE chunk_id = ?",
		);
		const insertMetaStatement = db.prepare(`
			INSERT INTO vector_meta (
				chunk_id,
				project_id,
				snapshot_id,
				file_path,
				start_line,
				end_line,
				content_hash,
				chunk_type,
				primary_symbol
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertVectorStatement = db.prepare(
			"INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
		);

		const upsertBatch = db.transaction((batch: VectorRecord[]) => {
			for (const vector of batch) {
				deleteVectorStatement.run(vector.chunkId);
				deleteMetaStatement.run(vector.chunkId);
				insertMetaStatement.run(
					vector.chunkId,
					vector.projectId,
					vector.snapshotId,
					vector.filePath,
					vector.startLine,
					vector.endLine,
					vector.contentHash,
					vector.chunkType ?? "",
					vector.primarySymbol ?? "",
				);
				insertVectorStatement.run(
					vector.chunkId,
					this.embeddingToSqlValue(vector.embedding),
				);
			}
		});

		for (let index = 0; index < vectors.length; index += UPSERT_BATCH_SIZE) {
			const batch = vectors.slice(index, index + UPSERT_BATCH_SIZE);
			upsertBatch(batch);
		}
	}

	async search(
		queryEmbedding: number[],
		topK: number,
		filters: VectorSearchFilters,
	): Promise<VectorSearchResult[]> {
		if (!filters.projectId) {
			throw new Error("projectId is required in filters for search");
		}

		await this.initialize();
		const db = this.getDb();
		const conditions = ["vm.project_id = ?"];
		const values: Array<string | number | Buffer> = [filters.projectId];
		const prefilter = this.buildPrefilter(filters, "vm");
		if (prefilter) {
			conditions.push(prefilter);
		}

		const rows = db
			.prepare(`
				SELECT vm.*, vec_distance_cosine(vc.embedding, vec_f32(?)) AS distance
				FROM vec_chunks vc
				JOIN vector_meta vm ON vc.chunk_id = vm.chunk_id
				WHERE ${conditions.join(" AND ")}
				ORDER BY distance
				LIMIT ?
			`)
			.all(
				this.embeddingToJson(queryEmbedding),
				...values,
				topK,
			) as VectorSearchRow[];

		return rows.map((row) => ({
			chunkId: row.chunk_id as ChunkId,
			snapshotId: row.snapshot_id as SnapshotId,
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			contentHash: row.content_hash,
			chunkType: row.chunk_type || undefined,
			primarySymbol: row.primary_symbol || undefined,
			score: Math.max(0, 1 - row.distance / 2),
			distance: row.distance,
		}));
	}

	async countVectors(filters: VectorSearchFilters): Promise<number> {
		if (!filters.projectId) {
			throw new Error("projectId is required in filters for countVectors");
		}

		await this.initialize();
		const db = this.getDb();
		const conditions = ["project_id = ?"];
		const values: string[] = [filters.projectId];
		const prefilter = this.buildPrefilter(filters);
		if (prefilter) {
			conditions.push(prefilter);
		}

		const row = db
			.prepare(
				`SELECT COUNT(*) AS count FROM vector_meta WHERE ${conditions.join(" AND ")}`,
			)
			.get(...values) as { count: number };

		return row.count;
	}

	async deleteBySnapshot(
		projectId: ProjectId,
		snapshotId: SnapshotId,
	): Promise<void> {
		await this.initialize();
		const db = this.getDb();

		db.transaction(() => {
			db.prepare(`
				DELETE FROM vec_chunks
				WHERE chunk_id IN (
					SELECT chunk_id FROM vector_meta
					WHERE project_id = ? AND snapshot_id = ?
				)
			`).run(projectId, snapshotId);
			db.prepare(
				"DELETE FROM vector_meta WHERE project_id = ? AND snapshot_id = ?",
			).run(projectId, snapshotId);
		})();
	}

	async copyVectors(
		projectId: ProjectId,
		fromSnapshotId: SnapshotId,
		toSnapshotId: SnapshotId,
		excludeFilePaths: string[],
	): Promise<void> {
		await this.initialize();
		const db = this.getDb();

		const conditions = ["vm.project_id = ?", "vm.snapshot_id = ?"];
		const values: string[] = [projectId, fromSnapshotId];
		if (excludeFilePaths.length > 0) {
			const placeholders = excludeFilePaths.map(() => "?").join(", ");
			conditions.push(`vm.file_path NOT IN (${placeholders})`);
			values.push(...excludeFilePaths);
		}

		const rows = db
			.prepare(`
				SELECT vm.*, vc.embedding
				FROM vector_meta vm
				JOIN vec_chunks vc ON vc.chunk_id = vm.chunk_id
				WHERE ${conditions.join(" AND ")}
			`)
			.all(...values) as VectorCopyRow[];

		if (rows.length === 0) {
			return;
		}

		const deleteVectorStatement = db.prepare(
			"DELETE FROM vec_chunks WHERE chunk_id = ?",
		);
		const deleteMetaStatement = db.prepare(
			"DELETE FROM vector_meta WHERE chunk_id = ?",
		);
		const insertMetaStatement = db.prepare(`
			INSERT INTO vector_meta (
				chunk_id,
				project_id,
				snapshot_id,
				file_path,
				start_line,
				end_line,
				content_hash,
				chunk_type,
				primary_symbol
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertVectorStatement = db.prepare(
			"INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
		);

		const copyBatch = db.transaction((batch: VectorCopyRow[]) => {
			for (const row of batch) {
				deleteVectorStatement.run(row.chunk_id);
				deleteMetaStatement.run(row.chunk_id);
				insertMetaStatement.run(
					row.chunk_id,
					row.project_id,
					toSnapshotId,
					row.file_path,
					row.start_line,
					row.end_line,
					row.content_hash,
					row.chunk_type,
					row.primary_symbol,
				);
				insertVectorStatement.run(
					row.chunk_id,
					this.normalizeStoredEmbedding(row.embedding),
				);
			}
		});

		for (let index = 0; index < rows.length; index += UPSERT_BATCH_SIZE) {
			const batch = rows.slice(index, index + UPSERT_BATCH_SIZE);
			copyBatch(batch);
		}
	}

	async deleteByProject(projectId: ProjectId): Promise<void> {
		await this.initialize();
		const db = this.getDb();

		db.transaction(() => {
			db.prepare(`
				DELETE FROM vec_chunks
				WHERE chunk_id IN (
					SELECT chunk_id FROM vector_meta WHERE project_id = ?
				)
			`).run(projectId);
			db.prepare("DELETE FROM vector_meta WHERE project_id = ?").run(projectId);
		})();

		const legacyVectorsPath = path.join(path.dirname(this.dbPath), "vectors");
		if (existsSync(legacyVectorsPath)) {
			rmSync(legacyVectorsPath, { recursive: true, force: true });
		}
	}

	private openDatabase(): Database.Database {
		const db = new Database(this.dbPath);
		db.pragma("journal_mode = WAL");
		db.pragma("busy_timeout = 5000");
		sqliteVec.load(db);
		return db;
	}

	private getDb(): Database.Database {
		if (!this.db) {
			this.db = this.openDatabase();
		}

		return this.db;
	}

	private embeddingToSqlValue(embedding: number[]): Float32Array {
		this.validateEmbeddingArray(embedding);
		return new Float32Array(embedding);
	}

	private embeddingToJson(embedding: number[]): string {
		this.validateEmbeddingArray(embedding);
		return JSON.stringify(embedding);
	}

	private normalizeStoredEmbedding(embedding: unknown): Uint8Array {
		if (Buffer.isBuffer(embedding)) {
			return new Uint8Array(
				embedding.buffer,
				embedding.byteOffset,
				embedding.byteLength,
			);
		}

		if (embedding instanceof Uint8Array) {
			return new Uint8Array(
				embedding.buffer,
				embedding.byteOffset,
				embedding.byteLength,
			);
		}

		if (embedding instanceof ArrayBuffer) {
			return new Uint8Array(embedding);
		}

		throw new Error(
			"Unsupported sqlite-vec embedding value returned from database",
		);
	}

	private validateEmbeddingArray(embedding: number[]): void {
		if (embedding.length !== this.vectorSize) {
			throw new Error(
				`Expected embedding with ${this.vectorSize} dimensions, received ${embedding.length}`,
			);
		}

		for (let index = 0; index < embedding.length; index += 1) {
			if (!Number.isFinite(embedding[index])) {
				throw new Error(
					`Embedding contains non-finite value at index ${index}`,
				);
			}
		}
	}

	private buildPrefilter(filters: VectorSearchFilters, alias?: string): string {
		const conditions: string[] = [];
		const prefix = alias ? `${alias}.` : "";

		if (filters.snapshotId) {
			conditions.push(
				`${prefix}snapshot_id = '${this.escapeSqlLiteral(filters.snapshotId)}'`,
			);
		}

		if (filters.filePath) {
			conditions.push(
				`${prefix}file_path = '${this.escapeSqlLiteral(filters.filePath)}'`,
			);
		} else if (filters.pathPrefix) {
			conditions.push(
				`${prefix}file_path LIKE '${this.escapeSqlLike(filters.pathPrefix)}%'`,
			);
		}

		if (filters.chunkTypes && filters.chunkTypes.length > 0) {
			const normalizedChunkTypes = filters.chunkTypes
				.map((chunkType) => chunkType.trim())
				.filter((chunkType) => chunkType.length > 0)
				.map((chunkType) => `'${this.escapeSqlLiteral(chunkType)}'`);
			if (normalizedChunkTypes.length > 0) {
				conditions.push(
					`${prefix}chunk_type IN (${normalizedChunkTypes.join(", ")})`,
				);
			}
		}

		return conditions.join(" AND ");
	}

	private escapeSqlLiteral(value: string): string {
		return value.replace(/'/g, "''");
	}

	private escapeSqlLike(value: string): string {
		return this.escapeSqlLiteral(value).replace(/[%_]/g, (char) => `\\${char}`);
	}
}

export { SqliteVecVectorStore as LanceDbVectorStore };
