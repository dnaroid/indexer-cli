# Race Condition Mitigation Plan

> **Status**: Reviewed by Oracle — revised plan incorporating all findings.

## Problem Statement

When an AI agent (or developer) calls multiple `indexer-cli` commands without waiting for previous ones to complete, the lack of inter-process synchronization causes data corruption, failed operations, and wasted resources.

Each CLI invocation is a **separate Node.js process** with its own database connections. There are currently **zero** inter-process locks — no PID files, file locks, mutexes, or queues.

## Identified Race Conditions

### RC-1: Concurrent `index` — Mutual Data Destruction (Critical)

**Location**: `src/engine/indexer.ts` → `performFullReindex()` (line 1386)

**Scenario**: A `index --full` runs simultaneously with **any other indexing** (another `index`, a `search` triggering `ensureIndexed`, a post-commit hook, etc.).

**Mechanism**:
1. Process A calls `clearProjectMetadata()` → deletes ALL snapshots
2. Process A calls `deleteProjectVectorsWithRetry()` → deletes ALL vectors
3. Process A creates `snapshot-A`, begins indexing
4. Process B calls `clearProjectMetadata()` → deletes `snapshot-A`
5. Process B calls `deleteProjectVectorsWithRetry()` → deletes vectors from Process A
6. Process A encounters FOREIGN KEY errors or finds an empty database

**Impact**: Complete index corruption, data loss, user-facing errors.

**Oracle note**: The original plan limited this to full/full only. In reality, **any** concurrent indexing (full vs incremental, manual vs auto) triggers the same data destruction because all paths go through `performFullReindex()` or `prepareIncrementalSnapshot()` which both clear/copy data destructively.

---

### RC-2: `ensureIndexed()` Thundering Herd (Critical)

**Location**: `src/cli/commands/ensure-indexed.ts` (line 136)

**Scenario**: Agent calls `search`, `structure`, and `deps` simultaneously.

**Mechanism**:
1. All three commands call `ensureIndexed()`
2. Each checks `getLatestCompletedSnapshot()` → all see the same stale snapshot
3. Each calls `getIndexPlan()` → all get a non-null plan (changes detected)
4. All three create separate snapshots and start indexing independently
5. Three concurrent indexing processes compete for SQLite locks, Ollama resources, and disk I/O

**Impact**: 3x resource consumption, SQLite lock contention, conflicting snapshots, slow response times.

---

### RC-3: Post-commit Hook vs Manual Commands (High)

**Location**: `src/cli/commands/init.ts` (line 23)

**Scenario**: Developer commits code (triggers hook), then immediately runs a search command.

**Mechanism**:
```bash
# Git post-commit hook fires:
nohup npx indexer-cli index > /dev/null 2>&1 &

# Developer simultaneously runs:
npx indexer-cli search "authentication"
```
- Hook process starts `index` in background
- `search` command calls `ensureIndexed()` → detects stale index → starts its own indexing
- Two indexing processes run concurrently

**Impact**: Duplicate indexing work, SQLite lock contention, potential data conflicts.

**Oracle note**: RC-3 is a special case of RC-1/RC-2 (missing serialization). Once Phase 1 lock is in place, this is automatically mitigated.

---

### RC-4: Vector Store Missing `busy_timeout` (High)

**Location**: `src/storage/vectors.ts` → `openDatabase()` (line 375)

**Scenario**: Any concurrent write to the vector store.

**Mechanism**:
```typescript
// SqliteMetadataStore (correct):
this.db.pragma("journal_mode = WAL");
this.db.pragma("busy_timeout = 5000");

// SqliteVecVectorStore (broken):
private openDatabase(): Database.Database {
    const db = new Database(this.dbPath);
    sqliteVec.load(db);   // no WAL, no busy_timeout
    return db;
}
```
Without `busy_timeout`, any write conflict produces an **immediate SQLITE_BUSY error** with 0ms wait time.

**Impact**: Vector store operations fail instantly under any concurrent write load.

---

### RC-5: Snapshot Pruning Race (Medium)

**Location**: `src/engine/indexer.ts` → `pruneHistoricalSnapshots()` (line 1339)

**Scenario**: Long-running indexing process gets its data pruned by a faster concurrent process.

**Mechanism**:
1. Process A starts indexing, creates `snapshot-A` (status: "indexing")
2. Process B starts and finishes indexing faster, creates `snapshot-B`
3. Process B calls `pruneHistoricalSnapshots("snapshot-B")`:
   - Deletes vectors for `snapshot-A` (no protection for vectors)
   - `clearProjectMetadata()` with `preserveActiveIndexing: true` skips `snapshot-A` IF it's < 5 minutes old
4. If Process A took > 5 minutes → `snapshot-A` metadata is deleted too

**Impact**: Process A writes to a deleted snapshot → FOREIGN KEY errors, orphaned data.

---

### RC-6: Schema Migration + Init Race (Medium → upgraded from Low)

**Location**: `src/storage/sqlite.ts` → `runMigrations()` (line 1158) and `src/storage/vectors.ts` → `initialize()` (line 69)

**Scenario**: Two processes initialize against a newly created database simultaneously.

**Mechanism A** — Migration race: `runMigrations()` reads `currentVersion`, then applies migrations outside an exclusive transaction. Two processes can both see `version=0` and apply the same migration concurrently.

**Mechanism B** — Vector init TOCTOU (discovered by Oracle):
```typescript
// vectors.ts:99-111
const vecChunksExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'"
).get();
if (!vecChunksExists) {
    db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(...)`);
}
```
Two processes both see `vec_chunks` doesn't exist → both try to create the virtual table → one fails.

**Impact**: `SQLITE_BUSY` errors, duplicate column errors, or failed initialization. The `schema_migrations.version` PRIMARY KEY prevents duplicate migration rows, but the process still crashes on constraint violation.

---

### RC-7: `copyVectors()` Degrades Active Snapshot (Critical — discovered by Oracle)

**Location**: `src/storage/vectors.ts` → `copyVectors()` (line 274)

**Scenario**: Incremental indexing runs while a search query uses the current completed snapshot.

**Mechanism**:
```typescript
// copyVectors() "moves" vectors by deleting from old snapshot and inserting into new:
const copyBatch = db.transaction((batch: VectorCopyRow[]) => {
    for (const row of batch) {
        deleteVectorStatement.run(row.chunk_id);   // removes from old snapshot
        deleteMetaStatement.run(row.chunk_id);     // removes metadata
        insertMetaStatement.run(..., toSnapshotId, ...);  // inserts under new snapshot
        insertVectorStatement.run(row.chunk_id, ...);
    }
});
```

During incremental indexing, unchanged vectors are **moved** from the current completed snapshot to the new one. While this is in progress, the completed snapshot becomes **partially empty**. Any `search`/`structure`/`explain` command querying that snapshot gets incomplete results.

**Impact**: This means the original plan's strategy of "fail-fast auto-index, use stale results" is **NOT safe**. The "stale" completed snapshot may already be partially gutted by an in-progress incremental index.

**Implication**: `ensureIndexed` with `waitMs: 0` cannot simply skip and return stale data. It must either:
- Wait briefly for the lock and then serve fresh results, or
- The vector model must be redesigned so old snapshots remain intact until the new one is complete.

---

## Implementation Plan

### Revised Rollout Order

```
Phase 2 → Phase 3 → Phase 1 (revised) → Phase 1b (reader safety) → Phase 4 → Phase 5
```

Rationale: Phase 2 and 3 are independent, zero-risk SQLite hardening. Phase 1 is the critical serialization fix. Phase 1b addresses the `copyVectors()` reader-safety issue discovered by Oracle. Phase 4 and 5 become defense-in-depth once Phases 1–1b are correct.

---

### Phase 2: Fix Vector Store SQLite Configuration (RC-4)

**Goal**: Make vector store resilient to concurrent writes.

**Effort**: 15 minutes | **Risk**: Low | **Dependencies**: None

#### Step 2.1: Add WAL and busy_timeout to SqliteVecVectorStore

**File**: `src/storage/vectors.ts` → `openDatabase()` (line 375)

```typescript
private openDatabase(): Database.Database {
    const db = new Database(this.dbPath);
    db.pragma("journal_mode = WAL");       // ← ADD
    db.pragma("busy_timeout = 5000");      // ← ADD
    sqliteVec.load(db);
    return db;
}
```

**Note**: The metadata store and vector store both open the same `db.sqlite` file. WAL mode only needs to be set once, but setting it again is a no-op. The `busy_timeout` is per-connection, so it must be set on each connection.

#### Step 2.2: Verify WAL mode compatibility with sqlite-vec

**Testing**: Ensure sqlite-vec virtual tables work correctly under WAL mode. Run existing test suite with concurrent access patterns.

---

### Phase 3: Protect Schema Migrations + Init (RC-6)

**Goal**: Ensure migrations and vector table creation are atomic across processes.

**Effort**: 45 minutes | **Risk**: Low | **Dependencies**: None

#### Step 3.1: Wrap migrations in IMMEDIATE transaction

**File**: `src/storage/sqlite.ts` → `runMigrations()` (line 1158)

```typescript
private async runMigrations(): Promise<void> {
    // Use db.transaction().immediate() for exclusive access during migration
    const runInTransaction = this.db.transaction(() => {
        const currentVersion = this.getCurrentSchemaVersion();
        logger.info("[SqliteMetadataStore] Current schema version:", currentVersion);

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
            }
        }
    });

    runInTransaction.immediate();
}
```

**Oracle note**: `db.transaction()` in better-sqlite3 defaults to deferred mode (`BEGIN`). Must use `.immediate()` to get `BEGIN IMMEDIATE` behavior, which acquires a write lock immediately and prevents another process from also entering the migration block.

#### Step 3.2: Wrap vector table creation in transaction

**File**: `src/storage/vectors.ts` → `initialize()` (line 69)

```typescript
async initialize(): Promise<void> {
    if (this.initialized) return;

    const db = this.getDb();

    // Wrap schema creation in immediate transaction to prevent TOCTOU
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
```

---

### Phase 1: File-Level Advisory Lock (RC-1, RC-2, RC-3)

**Goal**: Ensure only one indexing operation runs at a time across all processes.

**Effort**: 3-4 hours | **Risk**: Medium | **Dependencies**: None (but benefits from Phase 2/3 being done first)

#### Step 1.1: Add dependency

```bash
npm install proper-lockfile
npm install -D @types/proper-lockfile
```

#### Step 1.2: Create lock utility module

**New file**: `src/core/lock.ts`

```typescript
import lockfile from "proper-lockfile";
import path from "node:path";
import { SystemLogger } from "./logger.js";

const logger = new SystemLogger("lock");

const LOCK_DIR = ".indexer-cli";
const LOCK_FILE = "indexer.lock";

/** Default stale threshold: 10 minutes (conservative for laptop sleep scenarios) */
const DEFAULT_STALE_MS = 10 * 60 * 1000;

/**
 * Acquire an exclusive advisory lock for indexing operations.
 * Returns a release function that MUST be called in a finally block.
 *
 * @param projectRoot - Absolute path to the project root
 * @param options - Lock acquisition options
 * @returns Release function
 * @throws Error if lock cannot be acquired
 */
export async function acquireIndexLock(
    projectRoot: string,
    options?: {
        /** Maximum time to wait for the lock in ms (default: 0 = fail immediately) */
        waitMs?: number;
        /** Retry interval in ms when waiting */
        retryIntervalMs?: number;
        /** Lock stale threshold in ms (default: 600000 = 10 min) */
        staleMs?: number;
    },
): Promise<() => Promise<void>> {
    const lockDir = path.join(projectRoot, LOCK_DIR);
    const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;

    const lockOptions: lockfile.LockOptions = {
        stale: staleMs,
        update: 10_000,                          // Refresh lock every 10s while held
        onCompromised: (err: Error) => {
            // Lock was compromised (another process stole it after stale period)
            logger.error("[lock] Lock compromised! Another process may be indexing concurrently.", {
                message: err.message,
            });
            // Abort current process to prevent data corruption
            process.exit(1);
        },
        retries: options?.waitMs
            ? {
                retries: Math.ceil(options.waitMs / (options.retryIntervalMs ?? 1000)),
                minTimeout: options.retryIntervalMs ?? 1000,
                maxTimeout: options.retryIntervalMs ?? 1000,
            }
            : 0,  // No retries by default — fail fast
    };

    try {
        const release = await lockfile.lock(lockDir, {
            ...lockOptions,
            lockfilePath: path.join(lockDir, LOCK_FILE),
        });
        logger.info("[lock] Acquired index lock");
        return release;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Indexing is already in progress by another process. ` +
            `Wait for it to finish. If stale, remove ${LOCK_DIR}/${LOCK_FILE}/. ` +
            `(${message})`
        );
    }
}
```

**Oracle corrections applied**:
- **Stale threshold increased to 10 minutes** (was 2 min). A short stale value causes split-brain when a laptop sleeps or a process is paused. 10 minutes gives enough margin for large repo indexing.
- **`onCompromised` handler added**. If the lock is detected as compromised (another process stole it), the current process exits immediately rather than silently proceeding with concurrent writes.
- **Removed `isIndexLocked()` function**. Oracle identified this as a TOCTOU bug — checking then acting is inherently racy. All code paths should attempt `acquireIndexLock()` directly.

#### Step 1.3: Integrate into `ensure-indexed.ts`

**File**: `src/cli/commands/ensure-indexed.ts`

Wrap the indexing section with the lock, using brief wait for reader-safety:

```typescript
import { acquireIndexLock } from "../../core/lock.js";

// In ensureIndexed(), after determining indexPlan is non-null:

// Auto-index waits briefly (5s) for an active indexing process to finish,
// so we can serve fresh results instead of partially-gutted stale data (RC-7).
const release = await acquireIndexLock(repoRoot, {
    waitMs: 5_000,
    retryIntervalMs: 1000,
}).catch(() => null);  // null = lock acquisition failed, skip indexing

if (!release) {
    // Another process is indexing and didn't finish in 5s.
    // Log and continue — the caller will use whatever snapshot is available.
    logger.info("[ensure-indexed] Skipping auto-index: another process holds the lock");
    return;
}

try {
    // RE-CHECK: After acquiring the lock, re-evaluate the plan.
    // Another process may have completed indexing while we waited.
    const updatedSnapshot =
        await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
    const updatedPlan = await getIndexPlan(git, repoRoot, metadata, updatedSnapshot);

    if (!updatedPlan) {
        // Another process already indexed — nothing to do
        return;
    }

    // ... existing indexing logic ...
} finally {
    await release();
}
```

**Key design changes (Oracle)**:
- **Brief wait instead of fail-fast**: `waitMs: 5_000` instead of `0`. Because of RC-7 (copyVectors degrades active snapshot), we cannot safely return stale results during indexing. Better to wait a few seconds for the other process to finish.
- **Re-check after lock**: Prevents thundering herd — only the first process to get the lock actually indexes.
- **Graceful fallback**: If lock fails after 5s, log and continue (don't crash the search/structure command).

#### Step 1.4: Integrate into `index.ts` command

**File**: `src/cli/commands/index.ts`

```typescript
import { acquireIndexLock } from "../../core/lock.js";

// In the action handler, after metadata.initialize():

const release = await acquireIndexLock(resolvedProjectPath, {
    waitMs: 60_000,  // Wait up to 60s for manual index commands
    retryIntervalMs: 2000,
});

try {
    // For non---full index: RE-CHECK plan after acquiring lock
    // (another process may have indexed while we waited)
    if (!options?.full && !options?.status && !options?.dryRun) {
        const latestSnapshot =
            await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
        const headCommit = await git.getHeadCommit(resolvedProjectPath);
        const changedFiles = latestSnapshot?.meta.headCommit
            ? mergeGitDiffs(
                await git.getChangedFiles(resolvedProjectPath, latestSnapshot.meta.headCommit),
                await git.getWorkingTreeChanges(resolvedProjectPath),
            )
            : undefined;

        if (latestSnapshot && headCommit === latestSnapshot.meta.headCommit) {
            // Already up to date — skip redundant indexing
            console.log("Index is already up to date.");
            return;
        }
    }

    // ... existing indexing logic ...
} finally {
    await release();
}
```

**Oracle correction**: Non-`--full` manual `index` must also re-check after acquiring lock, same as `ensureIndexed`. Without this, a waited command does redundant work from a stale plan.

#### Step 1.5: Update post-commit hook

**File**: `src/cli/commands/init.ts`

Change the hook to use `--skip-if-locked` which attempts lock acquisition with `waitMs: 0`:

```bash
# Old:
nohup npx indexer-cli index > /dev/null 2>&1 &

# New: attempt to index, exit cleanly if already indexing
nohup sh -c 'npx indexer-cli index --skip-if-locked > /dev/null 2>&1' &
```

Add `--skip-if-locked` option to the index command:

```typescript
// In registerIndexCommand:
.option("--skip-if-locked", "exit immediately if another index is in progress")
```

In the action handler — **no TOCTOU, use lock acquisition directly**:

```typescript
// Oracle correction: do NOT use isIndexLocked() then skip.
// That's a TOCTOU bug. Instead, attempt acquisition and catch the error.

if (options?.skipIfLocked) {
    try {
        const release = await acquireIndexLock(resolvedProjectPath, { waitMs: 0 });
        // Lock acquired — proceed with indexing in the finally block below
        // release() will be called when done
    } catch {
        // Lock NOT acquired — another process is indexing, exit silently
        process.exit(0);
    }
}
```

#### Step 1.6: Stale indexing snapshot cleanup on startup

**File**: `src/storage/sqlite.ts` — add to `initialize()`

After lock acquisition, mark any stale `status='indexing'` snapshots as failed (from crashed previous runs):

```typescript
async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.db.pragma("foreign_keys = ON");
    this.createSchema();
    await this.runMigrations();
    await this.cleanupStaleIndexingSnapshots();
}

/**
 * Mark any 'indexing' snapshots older than 30 minutes as 'failed'.
 * These are left behind by crashed processes.
 * Should be called after lock acquisition to avoid interfering with active indexing.
 */
private async cleanupStaleIndexingSnapshots(): Promise<void> {
    const staleThreshold = Date.now() - 30 * 60 * 1000;
    this.db
        .prepare(
            `UPDATE snapshots SET status = 'failed', failure_reason = 'Indexing process crashed'
             WHERE status = 'indexing' AND created_at < ?`,
        )
        .run(staleThreshold);
}
```

**Oracle note**: Crashed processes leave `status='indexing'` snapshots behind. Without cleanup, these accumulate and can confuse `getLatestCompletedSnapshot()` or trigger unnecessary re-indexing. Calling this after lock acquisition ensures we don't interfere with a genuinely active process.

---

### Phase 1b: Reader Safety During Incremental Indexing (RC-7)

**Goal**: Ensure read commands (search, structure, explain) get complete results even during active indexing.

**Effort**: 2-3 hours | **Risk**: Medium | **Dependencies**: Phase 1

This is the most architecturally significant change. Two options:

#### Option A: Lock-based wait (simpler, chosen for initial implementation)

Already addressed in Phase 1 Step 1.3: `ensureIndexed` waits up to 5 seconds for the lock before falling back. Combined with Phase 1 ensuring single-writer, this eliminates the window where `copyVectors()` could degrade the active snapshot during a read.

**Limitation**: If indexing takes > 5 seconds, readers still get a potentially degraded snapshot. Acceptable for now — the lock prevents the worst case (concurrent writers), and 5s covers most incremental reindexes.

#### Option B: Snapshot-preserving vector copy (future improvement)

Redesign `copyVectors()` so it **copies** vectors instead of **moving** them:

```typescript
// Instead of: DELETE from old snapshot, INSERT into new
// Do: INSERT into new snapshot only (keep old intact)

const copyBatch = db.transaction((batch: VectorCopyRow[]) => {
    for (const row of batch) {
        // DO NOT delete from old snapshot
        // Only insert into new snapshot with new chunk_id (or same chunk_id under new snapshot_id)
        insertMetaStatement.run(
            row.chunk_id,       // or generate new chunk_id
            row.project_id,
            toSnapshotId,       // new snapshot
            row.file_path,
            // ...
        );
        insertVectorStatement.run(row.chunk_id, row.embedding);
    }
});
```

This keeps the old completed snapshot fully intact during incremental indexing. Readers always get complete results. Pruning happens only after the new snapshot is fully committed.

**Trade-off**: Doubles storage usage during indexing (two complete copies of unchanged vectors). Pruning after completion frees the old space.

**Recommendation**: Implement Option A now. Track Option B as a future improvement if reader-safety during long-running indexes becomes a user complaint.

---

### Phase 4: Improve Snapshot Pruning Safety (RC-5)

**Goal**: Prevent pruning of in-use snapshots.

**Effort**: 1 hour | **Risk**: Low | **Dependencies**: Phase 1 (lock makes this defense-in-depth)

#### Step 4.1: Increase active indexing TTL

**File**: `src/storage/sqlite.ts` → `clearProjectMetadata()` (line 979)

```typescript
// Old: 5 minutes — too short for large repos
params.push(Date.now() - 5 * 60 * 1000);

// New: 30 minutes — conservative for any indexing duration
params.push(Date.now() - 30 * 60 * 1000);
```

#### Step 4.2: Delete vectors AFTER metadata cleanup

**File**: `src/engine/indexer.ts` → `pruneHistoricalSnapshots()` (line 1339)

Restructure to delete vectors only for snapshots that are confirmed deleted from metadata:

```typescript
private async pruneHistoricalSnapshots(
    projectId: ProjectId,
    keepSnapshotId: SnapshotId,
): Promise<void> {
    // 1. Get stale snapshot IDs
    const staleSnapshotIds = await this.listStaleSnapshotIds(projectId, keepSnapshotId);
    if (staleSnapshotIds.length === 0) return;

    // 2. Delete metadata FIRST (with preserveActiveIndexing protection)
    await this.metadata.clearProjectMetadata(projectId, keepSnapshotId, {
        preserveActiveIndexing: true,
    });

    // 3. Check which snapshots were actually deleted from metadata
    const remainingSnapshots = await this.metadata.listSnapshots(projectId);
    const remainingIds = new Set(remainingSnapshots.map(s => s.id));

    // 4. Only delete vectors for snapshots that are truly gone from metadata
    const confirmedDeletedIds = staleSnapshotIds.filter(id => !remainingIds.has(id));

    for (const snapshotId of confirmedDeletedIds) {
        await this.deleteSnapshotVectorsWithRetry(projectId, snapshotId);
    }
}
```

**Key insight**: By checking which snapshots were actually removed from metadata (vs. preserved by `preserveActiveIndexing`), we avoid deleting vectors for active indexing processes.

---

### Phase 5: Active Indexing Detection (Defense in Depth)

**Goal**: Commands can detect and report when indexing is in progress.

**Effort**: 1 hour | **Risk**: Low | **Dependencies**: Phase 1

#### Step 5.1: Add `getActiveIndexingInfo()` utility

**File**: `src/core/lock.ts` (add to existing)

```typescript
import type { SqliteMetadataStore } from "../storage/sqlite.js";

/**
 * Check the database for active indexing snapshots.
 * Returns snapshot info if indexing is in progress, null otherwise.
 */
export async function getActiveIndexingInfo(
    metadata: SqliteMetadataStore,
    projectId: string,
): Promise<{ snapshotId: string; startedAt: number } | null> {
    const snapshot = await metadata.getLatestSnapshot(projectId);
    if (snapshot?.status === "indexing") {
        return {
            snapshotId: snapshot.id,
            startedAt: snapshot.createdAt,
        };
    }
    return null;
}
```

#### Step 5.2: Use in `ensure-indexed.ts` for better logging

Already integrated into Phase 1 Step 1.3 — when lock acquisition fails after 5s, log active indexing info.

---

## Testing Strategy

### Unit Tests

**New file**: `tests/unit/core/lock.test.ts`

```typescript
describe("index lock", () => {
    it("acquires and releases lock successfully");
    it("fails when lock is already held by another process");
    it("waits and retries when waitMs > 0");
    it("auto-removes stale locks after staleMs");
    it("re-checks index plan after acquiring lock");
    it("onCompromised exits process when lock is stolen");
});
```

**New file**: `tests/unit/storage/vectors-init.test.ts`

```typescript
describe("vector store initialization", () => {
    it("handles concurrent initialize() without TOCTOU");
    it("sets WAL mode and busy_timeout on connection");
});
```

### Integration Tests

**New file**: `tests/integration/concurrent-index.test.ts`

```typescript
describe("concurrent indexing", () => {
    it("only one process indexes when two are started simultaneously");
    it("second search command uses index created by first");
    it("post-commit hook skips when manual index is running");
    it("vector store survives concurrent writes with busy_timeout");
    it("search returns complete results during incremental indexing");
    it("stale indexing snapshots cleaned up on startup");
});
```

### Manual Test Scripts

```bash
# Test 1: Concurrent index commands — only one should succeed
npx indexer-cli index --full &
npx indexer-cli index --full &
wait
npx indexer-cli search "test" --txt  # Should return valid results

# Test 2: Search while indexing — should wait briefly then serve results
npx indexer-cli index &
sleep 1
npx indexer-cli search "authentication"  # Should wait ~5s then return results

# Test 3: Post-commit hook — should skip if manual index is running
echo "// change" >> src/some-file.ts
git add . && git commit -m "test"
# Hook should start indexing or skip if locked
npx indexer-cli search "something"  # Should handle gracefully

# Test 4: Crash recovery — stale lock auto-removed
npx indexer-cli index &
kill -9 %1  # Force kill
sleep 11m   # Wait for stale threshold
npx indexer-cli index  # Should acquire lock successfully
```

---

## Migration Path

### No Breaking Changes Required

All changes are additive:
- File lock is transparent to users
- WAL/busy_timeout on vector store is internal
- Migration wrapping is internal
- `--skip-if-locked` is a new optional flag
- Stale snapshot cleanup is transparent

### Rollout Order

1. **Phase 2** (vector store WAL/busy_timeout) — Deploy immediately, zero risk
2. **Phase 3** (migration + init protection) — Deploy immediately, zero risk
3. **Phase 1** (file-level advisory lock) — Deploy after testing, highest impact
4. **Phase 1b** (reader safety: lock-based wait) — Included in Phase 1
5. **Phase 4** (pruning safety) — Deploy after Phase 1, defense-in-depth
6. **Phase 5** (detection UX) — Deploy last, quality-of-life improvement

### Dependencies

```
Phase 2 → independent (can deploy now)
Phase 3 → independent (can deploy now)
Phase 1 → benefits from Phase 2/3 being done first
Phase 1b → part of Phase 1 (lock-based wait)
Phase 4 → benefits from Phase 1 (defense-in-depth)
Phase 5 → depends on Phase 1 (uses lock module)
```

---

## Files to Create/Modify

| File | Action | Phase |
|------|--------|-------|
| `src/core/lock.ts` | **Create** | 1 |
| `src/cli/commands/ensure-indexed.ts` | Modify (add lock + re-check + brief wait) | 1 |
| `src/cli/commands/index.ts` | Modify (add lock + re-check + `--skip-if-locked`) | 1 |
| `src/cli/commands/init.ts` | Modify (update hook template) | 1 |
| `src/storage/vectors.ts` | Modify (add WAL + busy_timeout + wrap init in transaction) | 2, 3 |
| `src/storage/sqlite.ts` | Modify (wrap migrations in `.immediate()` + stale snapshot cleanup) | 3 |
| `src/engine/indexer.ts` | Modify (restructure pruning: metadata first, vectors second) | 4 |
| `tests/unit/core/lock.test.ts` | **Create** | Testing |
| `tests/unit/storage/vectors-init.test.ts` | **Create** | Testing |
| `tests/integration/concurrent-index.test.ts` | **Create** | Testing |

---

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|-----------|
| File lock | Lock left after crash | `stale: 600_000` (10 min) auto-removes stale locks + `onCompromised` handler prevents split-brain |
| File lock | Laptop sleep → lock stolen | 10-min stale threshold + `onCompromised` exits process rather than proceeding unsafely |
| File lock | NFS/network filesystem | `proper-lockfile` uses `mkdir` + `mtime` — document local-disk as recommended. On NFS, lock may be unreliable |
| WAL on vector store | sqlite-vec incompatibility | Test with existing vector test suite first. sqlite-vec uses standard virtual table API — expected to be compatible |
| Migration `.immediate()` | Longer lock hold during init | Migrations run once per schema version, acceptable overhead |
| Pruning restructure | Vectors accumulate if metadata delete fails | Reversed order: metadata first (source of truth), vectors second |
| `--skip-if-locked` | Hook silently skips needed indexing | Next `search`/`structure` call triggers indexing via `ensureIndexed` |
| Reader safety (Option A) | 5s wait may not cover long indexes | Adequate for incremental reindexes; full reindexes are triggered manually. Track Option B for future |
| Stale snapshot cleanup | Could mark active indexing as failed | Only marks snapshots > 30 min old; combined with Phase 1 lock, active indexing won't be affected |

---

## Estimated Effort

| Phase | Description | Effort |
|-------|-------------|--------|
| Phase 2 | Vector store SQLite config (WAL + busy_timeout) | 15 min |
| Phase 3 | Migration protection + vector init fix | 45 min |
| Phase 1 | File-level advisory lock + integration | 3-4 hours |
| Phase 1b | Reader safety (lock-based wait) | included in Phase 1 |
| Phase 4 | Pruning safety | 1 hour |
| Phase 5 | Active indexing detection | 1 hour |
| Testing | Unit + integration tests | 3-4 hours |
| **Total** | | **~1-2 days** |

---

## Oracle Review Summary

The plan was reviewed by Oracle (high-reasoning read-only consultant). Key findings incorporated:

1. **RC-1 scope expanded**: Full reindex vs **any** indexing, not just full/full
2. **RC-7 discovered**: `copyVectors()` degrades active snapshot — "fail fast + stale results" is not safe
3. **RC-6 upgraded**: Added vector init TOCTOU race; migration failure is `SQLITE_BUSY`/constraint violation, not just duplicate rows
4. **`isIndexLocked()` removed**: TOCTOU bug — all paths now use `acquireIndexLock()` directly
5. **Stale lock threshold increased**: 2 min → 10 min (laptop sleep safety)
6. **`onCompromised` handler added**: Prevents silent split-brain on lock compromise
7. **`ensureIndexed` uses brief wait**: 5s instead of 0s, because stale results aren't safe (RC-7)
8. **Re-check pattern applied everywhere**: Including non-`--full` manual `index` command
9. **Migration transaction uses `.immediate()`**: Not plain `db.transaction()` (deferred mode)
10. **Effort estimate revised**: 7-8 hours → **1-2 days** (medium)

### Future Consideration (not in scope)

If search must stay available during long-running background indexing, the vector schema should be redesigned so old snapshots remain fully intact until new ones are committed. This requires changing `copyVectors()` from "move" to "copy" semantics, at the cost of doubled storage during indexing.
