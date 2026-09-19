import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type {
	ChunkId,
	FileDomain,
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
	"file_domain",
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
	file_domain: FileDomain;
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
			this.ensureVectorMetaSchema(db);

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

			this.backfillSnapshotMemberships(db);
		});

		initSchema.immediate();

		this.initialized = true;
	}

	private ensureVectorMetaSchema(db: Database.Database): void {
		const exists = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vector_meta'",
			)
			.get();

		if (!exists) {
			this.createVectorMetaTable(db, "vector_meta");
		} else {
			let columns = db.prepare("PRAGMA table_info(vector_meta)").all() as Array<{
				name: string;
				pk: number;
			}>;
			if (!columns.some((column) => column.name === "file_domain")) {
				db.exec(
					"ALTER TABLE vector_meta ADD COLUMN file_domain TEXT NOT NULL DEFAULT 'code'",
				);
				columns = db.prepare("PRAGMA table_info(vector_meta)").all() as Array<{
					name: string;
					pk: number;
				}>;
			}

			const primaryKey = columns
				.filter((column) => column.pk > 0)
				.sort((left, right) => left.pk - right.pk)
				.map((column) => column.name);
			const snapshotAware =
				primaryKey.length === 3 &&
				primaryKey[0] === "project_id" &&
				primaryKey[1] === "snapshot_id" &&
				primaryKey[2] === "chunk_id";

			if (!snapshotAware) {
				db.exec("DROP TABLE IF EXISTS vector_meta_snapshot_aware");
				this.createVectorMetaTable(db, "vector_meta_snapshot_aware");
				db.exec(`
					INSERT OR IGNORE INTO vector_meta_snapshot_aware (
						chunk_id, project_id, snapshot_id, file_path, start_line,
						end_line, content_hash, chunk_type, primary_symbol, file_domain
					)
					SELECT
						chunk_id, project_id, snapshot_id, file_path, start_line,
						end_line, content_hash, chunk_type, primary_symbol, file_domain
					FROM vector_meta;
					DROP TABLE vector_meta;
					ALTER TABLE vector_meta_snapshot_aware RENAME TO vector_meta;
				`);
			}
		}

		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_vector_meta_snapshot_id
			ON vector_meta(snapshot_id);

			CREATE INDEX IF NOT EXISTS idx_vector_meta_project_id
			ON vector_meta(project_id);

			CREATE INDEX IF NOT EXISTS idx_vector_meta_file_path
			ON vector_meta(file_path);

			CREATE INDEX IF NOT EXISTS idx_vector_meta_file_domain
			ON vector_meta(file_domain);
		`);
	}

	private createVectorMetaTable(db: Database.Database, tableName: string): void {
		db.exec(`
			CREATE TABLE ${tableName} (
				chunk_id TEXT NOT NULL,
				project_id TEXT NOT NULL,
				snapshot_id TEXT NOT NULL,
				file_path TEXT NOT NULL,
				start_line INTEGER NOT NULL,
				end_line INTEGER NOT NULL,
				content_hash TEXT NOT NULL,
				chunk_type TEXT NOT NULL DEFAULT '',
				primary_symbol TEXT NOT NULL DEFAULT '',
				file_domain TEXT NOT NULL DEFAULT 'code',
				PRIMARY KEY (project_id, snapshot_id, chunk_id)
			)
		`);
	}

	private tableExists(db: Database.Database, tableName: string): boolean {
		return Boolean(
			db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get(tableName),
		);
	}

	private backfillSnapshotMemberships(db: Database.Database): void {
		if (!this.tableExists(db, "vec_chunks")) return;

		if (this.tableExists(db, "chunks")) {
			db.exec(`
				INSERT OR IGNORE INTO vector_meta (
					chunk_id, project_id, snapshot_id, file_path, start_line,
					end_line, content_hash, chunk_type, primary_symbol, file_domain
				)
				SELECT
					c.chunk_id,
					c.project_id,
					c.snapshot_id,
					c.file_path,
					c.start_line,
					c.end_line,
					c.content_hash,
					COALESCE(c.chunk_type, ''),
					COALESCE(c.primary_symbol, ''),
					'code'
				FROM chunks c
				WHERE EXISTS (
					SELECT 1 FROM vec_chunks vc WHERE vc.chunk_id = c.chunk_id
				)
			`);
		}

		if (this.tableExists(db, "knowledge_chunks")) {
			db.exec(`
				INSERT OR IGNORE INTO vector_meta (
					chunk_id, project_id, snapshot_id, file_path, start_line,
					end_line, content_hash, chunk_type, primary_symbol, file_domain
				)
				SELECT
					k.chunk_id,
					k.project_id,
					k.snapshot_id,
					k.file_path,
					k.start_line,
					k.end_line,
					k.content_hash,
					COALESCE(k.chunk_type, ''),
					COALESCE(k.heading, ''),
					'document'
				FROM knowledge_chunks k
				WHERE EXISTS (
					SELECT 1 FROM vec_chunks vc WHERE vc.chunk_id = k.chunk_id
				)
			`);
		}
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
			"DELETE FROM vector_meta WHERE project_id = ? AND snapshot_id = ? AND chunk_id = ?",
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
				primary_symbol,
				file_domain
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const insertVectorStatement = db.prepare(
			"INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
		);

		const upsertBatch = db.transaction((batch: VectorRecord[]) => {
			for (const vector of batch) {
				deleteVectorStatement.run(vector.chunkId);
				deleteMetaStatement.run(
					vector.projectId,
					vector.snapshotId,
					vector.chunkId,
				);
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
					vector.domain ?? "code",
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
		const prefilter = this.buildPrefilter(
			{ ...filters, domain: filters.domain ?? "code" },
			"vm",
		);
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
			domain: row.file_domain === "document" ? "document" : undefined,
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
		const prefilter = this.buildPrefilter({
			...filters,
			domain: filters.domain ?? "code",
		});
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

		const rows = db
			.prepare(
				"SELECT chunk_id FROM vector_meta WHERE project_id = ? AND snapshot_id = ?",
			)
			.all(projectId, snapshotId) as Array<{ chunk_id: string }>;

		db.transaction(() => {
			db.prepare(
				"DELETE FROM vector_meta WHERE project_id = ? AND snapshot_id = ?",
			).run(projectId, snapshotId);
			const hasReference = db.prepare(
				"SELECT 1 FROM vector_meta WHERE chunk_id = ? LIMIT 1",
			);
			const deleteVector = db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?");
			for (const row of rows) {
				if (!hasReference.get(row.chunk_id)) {
					deleteVector.run(row.chunk_id);
				}
			}
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
				SELECT vm.*
				FROM vector_meta vm
				WHERE ${conditions.join(" AND ")}
					AND EXISTS (
						SELECT 1 FROM vec_chunks vc WHERE vc.chunk_id = vm.chunk_id
					)
			`)
			.all(...values) as VectorMetaRow[];

		if (rows.length === 0) {
			return;
		}

		const insertMetaStatement = db.prepare(`
			INSERT OR IGNORE INTO vector_meta (
				chunk_id,
				project_id,
				snapshot_id,
				file_path,
				start_line,
				end_line,
				content_hash,
				chunk_type,
				primary_symbol,
				file_domain
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		const copyBatch = db.transaction((batch: VectorMetaRow[]) => {
			for (const row of batch) {
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
					row.file_domain,
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

		const rows = db
			.prepare("SELECT DISTINCT chunk_id FROM vector_meta WHERE project_id = ?")
			.all(projectId) as Array<{ chunk_id: string }>;

		db.transaction(() => {
			db.prepare("DELETE FROM vector_meta WHERE project_id = ?").run(projectId);
			const hasReference = db.prepare(
				"SELECT 1 FROM vector_meta WHERE chunk_id = ? LIMIT 1",
			);
			const deleteVector = db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?");
			for (const row of rows) {
				if (!hasReference.get(row.chunk_id)) {
					deleteVector.run(row.chunk_id);
				}
			}
		})();
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
		} else {
			if (filters.filePaths && filters.filePaths.length > 0) {
				const filePaths = [...new Set(filters.filePaths)]
					.map((filePath) => filePath.trim())
					.filter(Boolean)
					.map((filePath) => `'${this.escapeSqlLiteral(filePath)}'`);
				if (filePaths.length > 0) {
					conditions.push(`${prefix}file_path IN (${filePaths.join(", ")})`);
				}
			}
			if (filters.pathPrefix) {
				conditions.push(
					`${prefix}file_path LIKE '${this.escapeSqlLike(filters.pathPrefix)}%'`,
				);
			}
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

		if (filters.domain) {
			conditions.push(`${prefix}file_domain = '${filters.domain}'`);
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
