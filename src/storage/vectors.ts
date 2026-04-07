import { existsSync, rmSync } from 'node:fs';
import * as lancedb from 'vectordb';
import type {
  ChunkId,
  ProjectId,
  SnapshotId,
  VectorRecord,
  VectorSearchFilters,
  VectorSearchResult,
  VectorStore,
} from '../core/types.js';
import { SystemLogger } from '../core/logger.js';

const logger = new SystemLogger('vector-lancedb');

export interface LanceDbVectorStoreOptions {
  dbPath: string;
  vectorSize: number;
  tableName?: string;
  cacheTTL?: number;
}

export const REQUIRED_COLUMNS = [
  'project_id',
  'chunk_id',
  'snapshot_id',
  'file_path',
  'start_line',
  'end_line',
  'content_hash',
  'chunk_type',
  'primary_symbol',
  'vector',
] as const;

const COPY_VECTORS_QUERY_LIMIT = 1_000_000;

export class LanceDbVectorStore implements VectorStore {
  private readonly dbPath: string;
  private readonly vectorSize: number;
  private readonly tableName: string;
  private readonly cacheTTL: number;
  private db: any;
  private table: any;
  private initialized = false;
  private lastCacheRefresh = 0;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: LanceDbVectorStoreOptions) {
    this.dbPath = options.dbPath;
    this.vectorSize = options.vectorSize;
    this.tableName = options.tableName ?? 'vectors';
    this.cacheTTL = options.cacheTTL ?? 5 * 60 * 1000;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.db = await lancedb.connect(this.dbPath);

    const tables = await this.db.tableNames();
    if (!tables.includes(this.tableName)) {
      await this.createTable();
    } else {
      this.table = await this.db.openTable(this.tableName);
      const schema = await this.table.getSchema();
      if (!this.hasRequiredSchema(schema)) {
        logger.warn(`[LanceDB] Schema mismatch for table "${this.tableName}", recreating.`);
        await this.db.dropTable(this.tableName);
        await this.createTable();
      }
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.db = null;
    this.table = null;
  }

  async upsert(vectors: VectorRecord[]): Promise<void> {
    await this.runSerialized(async () => {
      await this.withTransientIoRetry('upsert', async () => {
        if (vectors.length === 0) {
          return;
        }

        if (!this.initialized) {
          await this.initialize();
        }

        const batchSize = 200;
        for (let index = 0; index < vectors.length; index += batchSize) {
          const batch = vectors.slice(index, index + batchSize);
          const data = batch.map((vector) => ({
            project_id: vector.projectId,
            chunk_id: vector.chunkId,
            snapshot_id: vector.snapshotId,
            file_path: vector.filePath,
            start_line: vector.startLine,
            end_line: vector.endLine,
            content_hash: vector.contentHash,
            chunk_type: vector.chunkType ?? '',
            primary_symbol: vector.primarySymbol ?? '',
            vector: Array.from(vector.embedding),
          }));

          await this.table.add(data);
        }
      });
    });
  }

  async search(
    queryEmbedding: number[],
    topK: number,
    filters: VectorSearchFilters
  ): Promise<VectorSearchResult[]> {
    return this.runSerialized(async () => {
      return this.withTransientIoRetry('search', async () => {
        if (!filters.projectId) {
          throw new Error('projectId is required in filters for search');
        }

        if (!this.initialized) {
          await this.initialize();
        }

        await this.refreshCacheIfNeeded();
        await this.reopenTableIfNeeded();

        const prefilter = await this.buildPrefilter(filters);
        let results: any[];

        if (
          prefilter &&
          (typeof this.table.query === 'function' || typeof this.table.filter === 'function')
        ) {
          const rows =
            typeof this.table.query === 'function'
              ? await this.table
                  .query()
                  .where(prefilter)
                  .limit(COPY_VECTORS_QUERY_LIMIT)
                  .select([
                    'chunk_id',
                    'snapshot_id',
                    'file_path',
                    'start_line',
                    'end_line',
                    'content_hash',
                    'chunk_type',
                    'primary_symbol',
                    'vector',
                  ])
                  .toArray({ batchSize: 1024 })
              : await this.table
                  .filter(prefilter)
                  .limit(COPY_VECTORS_QUERY_LIMIT)
                  .select([
                    'chunk_id',
                    'snapshot_id',
                    'file_path',
                    'start_line',
                    'end_line',
                    'content_hash',
                    'chunk_type',
                    'primary_symbol',
                    'vector',
                  ])
                  .execute();

          results = rows
            .map((row: any) => {
              const vector = Array.isArray(row.vector) ? row.vector : Array.from(row.vector ?? []);
              return {
                ...row,
                _distance: this.euclideanDistance(queryEmbedding, vector),
              };
            })
            .sort((left: any, right: any) => left._distance - right._distance)
            .slice(0, topK);
        } else {
          const searchQuery = this.table.search(queryEmbedding).limit(topK);
          results = prefilter
            ? await searchQuery.where(prefilter).execute()
            : await searchQuery.execute();
        }

        return results.map((result: any) => ({
          chunkId: result.chunk_id as ChunkId,
          snapshotId: result.snapshot_id as SnapshotId,
          filePath: result.file_path,
          startLine: result.start_line,
          endLine: result.end_line,
          contentHash: result.content_hash,
          chunkType: typeof result.chunk_type === 'string' ? result.chunk_type : undefined,
          primarySymbol:
            typeof result.primary_symbol === 'string' ? result.primary_symbol : undefined,
          score: 1 / (1 + (typeof result._distance === 'number' ? result._distance : 0)),
          distance: typeof result._distance === 'number' ? result._distance : 0,
        }));
      });
    });
  }

  async countVectors(filters: VectorSearchFilters): Promise<number> {
    return this.runSerialized(async () => {
      return this.withTransientIoRetry('countVectors', async () => {
        if (!filters.projectId) {
          throw new Error('projectId is required in filters for countVectors');
        }

        if (!this.initialized) {
          await this.initialize();
        }

        await this.refreshCacheIfNeeded();
        await this.reopenTableIfNeeded();

        const prefilter = await this.buildPrefilter(filters);
        if (typeof this.table.countRows === 'function') {
          return prefilter ? await this.table.countRows(prefilter) : await this.table.countRows();
        }

        if (typeof this.table.filter === 'function') {
          logger.warn('[LanceDB] countRows not available, falling back to filter-based count');
          const results = await this.table
            .filter(prefilter || '1 = 1')
            .limit(COPY_VECTORS_QUERY_LIMIT)
            .select(['chunk_id'])
            .execute();
          return results.length;
        }

        if (typeof this.table.query === 'function') {
          logger.warn('[LanceDB] countRows not available, falling back to query-based count');
          const query = this.table.query();
          const results = prefilter
            ? await query
                .where(prefilter)
                .limit(COPY_VECTORS_QUERY_LIMIT)
                .select(['chunk_id'])
                .toArray({ batchSize: 1024 })
            : await query.limit(COPY_VECTORS_QUERY_LIMIT).select(['chunk_id']).toArray({
                batchSize: 1024,
              });
          return results.length;
        }

        throw new Error(
          '[LanceDB] countVectors requires countRows(), filter(), or query() support for exhaustive results'
        );
      });
    });
  }

  async deleteBySnapshot(projectId: ProjectId, snapshotId: SnapshotId): Promise<void> {
    await this.runSerialized(async () => {
      await this.withTransientIoRetry('deleteBySnapshot', async () => {
        void projectId;

        if (!this.initialized) {
          await this.initialize();
        }

        await this.table.delete(`snapshot_id = '${this.escapeSqlLiteral(snapshotId.toString())}'`);
      });
    });
  }

  async copyVectors(
    projectId: ProjectId,
    fromSnapshotId: SnapshotId,
    toSnapshotId: SnapshotId,
    excludeFilePaths: string[]
  ): Promise<void> {
    await this.runSerialized(async () => {
      await this.withTransientIoRetry('copyVectors', async () => {
        if (!this.initialized) {
          await this.initialize();
        }

        await this.refreshCacheIfNeeded();
        await this.reopenTableIfNeeded();

        const filter = `snapshot_id = '${this.escapeSqlLiteral(fromSnapshotId.toString())}'`;
        const results =
          typeof this.table.query === 'function'
            ? await this.table
                .query()
                .where(filter)
                .limit(COPY_VECTORS_QUERY_LIMIT)
                .select([
                  'project_id',
                  'chunk_id',
                  'snapshot_id',
                  'file_path',
                  'start_line',
                  'end_line',
                  'content_hash',
                  'chunk_type',
                  'primary_symbol',
                  'vector',
                ])
                .toArray({ batchSize: 1024 })
            : typeof this.table.filter === 'function'
              ? await this.table
                  .filter(filter)
                  .limit(COPY_VECTORS_QUERY_LIMIT)
                  .select([
                    'project_id',
                    'chunk_id',
                    'snapshot_id',
                    'file_path',
                    'start_line',
                    'end_line',
                    'content_hash',
                    'chunk_type',
                    'primary_symbol',
                    'vector',
                  ])
                  .execute()
              : await this.table
                  .search(Array(this.vectorSize).fill(0))
                  .limit(COPY_VECTORS_QUERY_LIMIT)
                  .where(filter)
                  .execute();

        const filtered = results.filter(
          (row: any) => !excludeFilePaths.includes(String(row.file_path))
        );
        if (filtered.length === 0) {
          return;
        }

        await this.table.add(
          filtered.map((row: any) => ({
            project_id: (row.project_id as string | undefined) ?? projectId.toString(),
            chunk_id: row.chunk_id as ChunkId,
            snapshot_id: toSnapshotId.toString(),
            file_path: row.file_path,
            start_line: row.start_line,
            end_line: row.end_line,
            content_hash: row.content_hash,
            chunk_type: row.chunk_type ?? '',
            primary_symbol: row.primary_symbol ?? '',
            vector: row.vector,
          }))
        );
      });
    });
  }

  async deleteByProject(projectId: ProjectId): Promise<void> {
    await this.runSerialized(async () => {
      await this.withTransientIoRetry('deleteByProject', async () => {
        void projectId;
        await this.close();

        if (!existsSync(this.dbPath)) {
          return;
        }

        rmSync(this.dbPath, { recursive: true, force: true });
      });
    });
  }

  private async runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private isTransientIoError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('LanceError(IO)') &&
      (message.includes('Not found:') ||
        message.includes('Did not find any data files') ||
        message.includes('/vectors.lance/data/'))
    );
  }

  private async withTransientIoRetry<T>(
    operationName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!this.isTransientIoError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[LanceDB] ${operationName} hit transient IO error, reopening and retrying once: ${message}`
      );
      await this.close();
      await this.initialize();
      return operation();
    }
  }

  private async refreshCacheIfNeeded(): Promise<void> {
    const now = Date.now();
    if (this.cacheTTL <= 0) {
      if (this.table) {
        this.table = null;
      }
      this.lastCacheRefresh = now;
      return;
    }

    if (this.table && now - this.lastCacheRefresh > this.cacheTTL) {
      this.table = null;
      this.lastCacheRefresh = now;
      logger.debug(`[LanceDB] Cache refreshed (TTL: ${this.cacheTTL}ms)`);
    }
  }

  private async reopenTableIfNeeded(): Promise<void> {
    if (!this.table) {
      this.table = await this.db.openTable(this.tableName);
    }
  }

  private async buildPrefilter(filters: VectorSearchFilters): Promise<string> {
    const conditions: string[] = [];

    if (filters.snapshotId) {
      conditions.push(`snapshot_id = '${this.escapeSqlLiteral(filters.snapshotId)}'`);
    }

    if (filters.filePath) {
      conditions.push(`file_path = '${this.escapeSqlLiteral(filters.filePath)}'`);
    } else if (filters.pathPrefix) {
      conditions.push(`file_path LIKE '${this.escapeSqlLike(filters.pathPrefix)}%'`);
    }

    if (filters.chunkTypes && filters.chunkTypes.length > 0) {
      const normalizedChunkTypes = filters.chunkTypes
        .map((chunkType) => chunkType.trim())
        .filter((chunkType) => chunkType.length > 0)
        .map((chunkType) => `'${this.escapeSqlLiteral(chunkType)}'`);
      if (normalizedChunkTypes.length > 0) {
        conditions.push(`chunk_type IN (${normalizedChunkTypes.join(', ')})`);
      }
    }

    return conditions.join(' AND ');
  }

  private euclideanDistance(a: number[], b: number[]): number {
    const length = Math.min(a.length, b.length);
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      const delta = a[index] - b[index];
      sum += delta * delta;
    }
    return Math.sqrt(sum);
  }

  private async createTable(): Promise<void> {
    this.table = await this.db.createTable(this.tableName, [
      {
        project_id: '',
        chunk_id: '',
        snapshot_id: '',
        file_path: '',
        start_line: 0,
        end_line: 0,
        content_hash: '',
        chunk_type: '',
        primary_symbol: '',
        vector: Array(this.vectorSize).fill(0),
      },
    ]);
  }

  private hasRequiredSchema(schema: any): boolean {
    if (!schema?.fields) {
      return false;
    }

    const fields = new Set(schema.fields.map((field: any) => field.name));
    for (const column of REQUIRED_COLUMNS) {
      if (!fields.has(column)) {
        return false;
      }
    }

    return true;
  }

  private escapeSqlLiteral(value: string): string {
    return value.replace(/'/g, "''");
  }

  private escapeSqlLike(value: string): string {
    return this.escapeSqlLiteral(value).replace(/[%_]/g, (char) => `\\${char}`);
  }
}
