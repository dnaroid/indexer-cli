# Concurrent index access

Implementation: `src/core/lock.ts`, `src/storage/sqlite.ts`,
`src/storage/vectors.ts`, `src/core/snapshot-retention.ts`,
`src/engine/indexer.ts`, `src/cli/commands/ensure-indexed.ts`,
`src/cli/commands/audit.ts`, `src/cli/commands/context.ts`, `src/cli/commands/search.ts`,
`src/cli/commands/init.ts`, and `src/cli/format/compact.ts`.

`idx` sessions may share one SQLite database in the project index directory. Initialization of a
current metadata schema or vector schema with complete memberships is read-only:
it does not run schema DDL, migrations, vector backfills, or snapshot cleanup.
Required schema setup and transactional migration/backfill paths remain
available for new, legacy, or incomplete stores. Temporary vector membership
gaps in an in-progress snapshot do not by themselves trigger startup backfill.

Automatic hybrid/semantic query refresh remains enabled; offline search/context
uses the existing completed snapshot. If refresh finds work while another
process owns the index lock, it waits up to 10 seconds. After acquiring the lock,
it re-reads snapshots and the working tree before deciding whether it still
needs to index. A competing completed refresh can make this invocation a noop.
A lock timeout is surfaced to the caller with a stale-data diagnostic.
Context and search retain an explicitly warned fallback to a completed snapshot; failure
diagnostics include the reason code and a descriptive message even outside a TTY.

After one indexing pass, refresh performs one bounded freshness check. If files
changed while the pass ran, it returns an explicit stale result rather than
looping and reindexing indefinitely.

Snapshot status is not changed based only on its age during store initialization:
a live indexer is authoritative while it owns and renews the index lock.

## Snapshot retention and readers

Before search, context, or indexed audit selects a completed snapshot, it registers a filesystem
reader lease. Lease registration and pruning are serialized by a separate,
short retention guard. The retention guard targets the dedicated reader-lease
directory, rather than the index lock's data directory: `proper-lockfile`
tracks same-process locks by canonical target rather than lockfile path, so
these targets must remain distinct when the guards are nested. A publisher
therefore either observes the reader and defers all historical snapshot cleanup,
or finishes cleanup before the reader
selects the replacement snapshot. The lease is released in `finally`; abandoned
leases are removed only after PID liveness confirms their process is gone (not
by age). Deferral preserves metadata and vectors together and does not hold the
index lock during query, embedding, or network work.
Deferred historical snapshots are eligible for collection on a subsequent
publication once no live reader remains; finishing a read does not itself run
database cleanup. These leases protect search/context/audit against normal indexing
publication, not explicit destructive administrative actions.

## Regression evidence

- `tests/unit/storage/vectors-init.test.ts`: separate-process read initialization
  during a writer transaction, including in-progress memberships.
- `tests/unit/storage/sqlite.test.ts`: initialization and snapshot status safety.
- `tests/unit/cli/ensure-indexed-lock.test.ts`: wait and replan after another process.
- `tests/unit/cli/ensure-indexed-freshness.test.ts`: mutation during indexing versus
  a stable tree and subsequent noop.
- `tests/unit/core/lock.test.ts`: lock ownership and serialization.
- `tests/unit/core/snapshot-retention.test.ts`: real reader leases and crash recovery.
- `tests/unit/engine/snapshot-retention.test.ts`: metadata and vector retention
  across publication until a separate reader process releases its lease.
