---
kind: spec
status: active
---

# Code and document indexing

## Implementation

`src/engine/indexer.ts`, `src/embedding/factory.ts`,
`src/embedding/openrouter.ts`, `src/embedding/presets.ts`,
`src/knowledge/document-indexer.ts`, `src/knowledge/embedding.ts`,
`src/cli/commands/init.ts`, `src/cli/commands/index.ts`,
`src/cli/commands/snapshot-diff.ts`, `src/cli/commands/ensure-indexed.ts`.

## Tests

`tests/unit/engine/indexer-file-counts.test.ts`,
`tests/unit/cli/index-file-counts.test.ts`,
`tests/unit/cli/ensure-indexed.test.ts`,
`tests/unit/cli/init.test.ts`, `tests/unit/embedding/openrouter.test.ts`,
`tests/unit/storage/vectors-init.test.ts`,
`tests/unit/knowledge/document-indexer.test.ts`,
`tests/evals/code-search-retrieval.eval.test.ts`,
`tests/evals/knowledge-retrieval.eval.test.ts`.

## Shared indexing lifecycle

Normal CLI indexing and automatic refresh process code and documents in the
same snapshot. All project Markdown is eligible regardless of directory or
purpose, subject to project ignore rules and configured document exclusions.
Document indexing stores file records, text chunks, and embeddings independently
of optional advisory purpose classification. Full indexing also works for
projects containing only documents. Incremental indexing copies
unchanged records and processes added or changed files in both domains.
Explicit incremental `idx index` compares merged committed and workspace Git
candidates with the latest completed snapshot's code and document hashes. A
persistently dirty file whose bytes were already indexed is copied rather than
reprocessed; a later content change or a newly added path is still indexed even
when other dirty paths are unchanged. Deletions already absent from the snapshot
are omitted. Before either no-op shortcut, the current document scanner set is
compared with the snapshot: explicitly included Git-ignored documents added or
removed without Git status changes still trigger an incremental index (and
appear in incremental dry-run counts). A root `.gitignore` change remains
actionable when the current scanner file set differs from the snapshot. When all
candidates are unchanged,
normal indexing reports up to date without creating another snapshot; a dry run
reports an incremental zero-change plan. Forced full indexing, changed path
masks, and an incomplete code lexical side index bypass this shortcut.
Knowledge fingerprint refresh still processes the selected documents even if
their bytes match the snapshot.

## Embedding provider modes

Project initialization owns the embedding preset. Plain `idx init` uses the
local preset: Ollama `jina-8k` for code, `nomic-embed-text-v2-moe` for documents,
Nomic query/document prefixes, and 768-dimensional vectors. Explicit
`idx init --embedding openrouter` uses
`perplexity/pplx-embed-v1-0.6b` for both domains, empty query/document prefixes,
and 1024-dimensional vectors. OpenRouter credentials come from
`OPENROUTER_API_KEY` in the process environment or the shared
`~/.config/idx/.env` file; the process environment takes precedence.

All semantic CLI paths construct providers through the shared embedding factory,
so indexing, automatic refresh, search, context, and audit use the same persisted
project mode. The OpenRouter provider batches requests, preserves input order,
validates the configured vector dimension, and retries transient network/HTTP
failures. Provider initialization validates credentials without making a paid
probe request.

Changing the embedding preset is a destructive operation only for derived index
state: `idx init --embedding ...` removes and rebuilds the project SQLite index
before reindexing, while source files and project documents are left untouched.
The vector store independently rejects an existing `vec_chunks` table whose
declared dimension differs from `vectorSize`, preventing mixed embedding spaces
from being queried accidentally.

Document chunking retains the normal 700-token upper bound. The additional
`ollamaNumCtx` limit applies only to the Ollama provider; remote providers use
their configured embedding context size instead.

The real retrieval evals share the same provider selector. `npm run
eval:retrieval` exercises the local preset; `npm run eval:retrieval:openrouter`
runs the identical code and knowledge cases through the OpenRouter preset. This
keeps provider quality comparisons on the same chunks, queries, and ranking
logic instead of maintaining a separate benchmark implementation.

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
During `idx index`, full and incremental runs print one `[current/total] path`
line per file-start callback, using the repository-relative code or document
path. `current` uses the snapshot total, so incremental paths start after the
copied-record offset; copied and deleted records do not get path lines. Batch
progress callbacks do not print duplicate count-only lines after file starts.
If there are no files to process, the final callback prints count-only progress
(for example, `2/2 files...` when only records were copied, or `0/0 files...`
for an empty full index). The final `Files indexed` value still counts only
files handled in this invocation, not carried records.
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
for concurrent search/audit/context readers are specified in
[`concurrent-index-access.md`](concurrent-index-access.md).
