---
kind: other
status: active
---

# Store document classification cache in SQLite

## Status

Accepted.

## Context and evidence

The user requested moving `.indexer-cli/doc-metadata` into the index database.
Previously, `getDocumentMetadata` wrote one JSON file per successful classification.
The project already shares `.indexer-cli/db.sqlite` between metadata and vectors.
The cache is disposable advisory data, not an authoritative document registry.
The governing contract is [knowledge maintenance](../specs/knowledge-maintenance.md).

## Decision and scope

Migration 7 adds `document_metadata_cache`, independent of project snapshots.
Reuse the metadata-store connection in indexing and audit, with optional cache
methods so stores without cache support still work. Preserve existing cache keys,
validation, explicit-frontmatter precedence, and best-effort failure behavior.
Only inferred kind/status are persisted; keys contain hashes, not credentials.

SQLite is the only supported cache. Do not read, import, or delete former JSON
entries. Audits remain read-only.

### Amendment: no legacy support

The user explicitly rejected legacy support after the initial implementation.
This amendment supersedes the initial lazy-import choice: the JSON fallback and
import/delete path are removed rather than retained for compatibility.

### Amendment: document-bound cache

The user approved one record per document after identifying unbounded accumulation
of content/settings versions. This supersedes hash-only row identity: migration 8
uses `(project_id, file_path)` as the primary key, retaining the hash as a reuse
guard. A successful classification replaces the result. Old SQLite entries cannot
recover their paths from hashes, so migration 8 discards this disposable cache
without attempting compatibility import. JSON remains unsupported.

After error-free document indexing, an independent complete scan removes cache
entries for documents no longer eligible in that project. Warnings or errors skip
cleanup to avoid mistaking an incomplete scan for deletion. A rename is removal
plus a new path; no cross-path reuse is promised. Audit only reads the cache.

Alternatives: LRU/TTL would impose arbitrary limits and evict live documents;
snapshot ownership would erase reusable classifications during snapshot retention.
Document identity bounds logical entries by the last successful scan's document
set without either policy. Assumption: runs are serialized by the existing index
lock; this change does not introduce concurrent classifier coordination.

## Alternatives

- Keep JSON files: retains filesystem independence, but does not satisfy the request.
- Separate cache database: survives index recreation, but adds another storage file.
- Bulk migration: removes the old directory sooner, but requires scanning unrelated
  or obsolete cache entries and additional startup writes.
- Lazy JSON import: initially implemented, then rejected by the user's explicit
  no-legacy requirement.

## Consequences and revisit triggers

New classifications no longer create many small files. Former JSON entries are
ignored and can be manually removed; classification may incur fresh provider calls.
Snapshot cleanup preserves
the cache, but deleting/recreating the database loses it and can incur provider
costs. Revisit separate storage if cache survival across database recreation becomes
a requirement. Revisit cleanup scheduling if projects rarely complete indexing;
SQLite may retain freed pages, so bounded logical entries do not guarantee that
the database file shrinks on deletion.

## Verification

`tests/unit/knowledge/document-metadata.test.ts` covers persistence, key invalidation,
legacy-file isolation, validation, and storage failures. `tests/unit/storage/sqlite.test.ts`
covers migration, reopen, upsert, and metadata cleanup. Audit and indexer regressions
exercise the caller integration.
