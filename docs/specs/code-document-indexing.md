# Code and document indexing

Implementation: `src/engine/indexer.ts`,
`src/knowledge/document-indexer.ts`, `src/knowledge/embedding.ts`,
`src/cli/commands/index.ts`, `src/cli/commands/ensure-indexed.ts`.

Regression evidence: `tests/unit/engine/indexer-file-counts.test.ts`,
`tests/unit/cli/index-file-counts.test.ts`,
`tests/unit/cli/ensure-indexed.test.ts`,
`tests/unit/knowledge/document-indexer.test.ts`.

## Shared indexing lifecycle

Normal CLI indexing and automatic refresh process code and documents in the
same snapshot. Document indexing stores document file records, text chunks,
and embeddings independently of knowledge classification. Full indexing also
works for projects containing only documents. Incremental indexing copies
unchanged records and processes added or changed files in both domains.

## File counts and progress

On successful runs, `IndexResult.filesIndexed` and the CLI's `Files indexed`
count code and document files processed by that invocation. Unchanged records
copied from the previous snapshot and deleted files are excluded. An
incremental run that only copies existing records reports zero indexed files.
Automatic `IDX files=...` output uses the engine's count rather than the raw
number of Git changes, which can include unsupported or ignored paths.
Existing per-file errors continue to be reported separately.

Snapshot `totalFiles` and progress callbacks include both code and documents.
Incremental progress includes copied records in its initial processed offset,
then advances for the files processed in that run. File-start and progress
callbacks use the same total through both stages. A successful final progress
value equals the snapshot total, including for document-only or empty projects.
Full `idx index --dry-run` includes the scanned documents in `Files to index`.
The `Files` count and optional file tree in `idx index --status` include stored
code and document records from the selected snapshot.

## Refresh after document configuration changes

When the knowledge index fingerprint changes, automatic indexing combines
committed changes since the previous snapshot, current workspace changes, and
the current documents that require refreshing. Code additions, modifications,
and deletions remain in the plan. Document paths present in both the Git diff
and the refresh set are deduplicated while retaining added-file semantics.

A knowledge refresh takes precedence over the shortcut for workspace changes
whose content already matches the snapshot: unchanged document bytes may
still require new chunks or embeddings under the new configuration. A refresh
also proceeds when the current document selection is empty, allowing excluded
documents to be removed and the current fingerprint to be recorded. Planning
is rechecked against the latest completed snapshot after the index lock is
acquired.

Cross-session refresh coordination, timeout diagnostics, and snapshot retention
for concurrent wiki/context readers are specified in
[`concurrent-index-access.md`](concurrent-index-access.md).
