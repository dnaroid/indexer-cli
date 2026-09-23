---
kind: spec
status: active
---

# Documentation search and task-scoped drift signals

## Purpose

Index project Markdown alongside code, and help a coding agent determine which
behavioral descriptions to check after a task. Source documents are authoritative;
the index and optional machine classifications are disposable derived data.

## Document selection and retrieval

All project `.md` documents are eligible regardless of directory or purpose,
subject to project ignore rules and configured document exclusions. There is no
spec-only directory, registration step, or separate wiki collection. Search,
context, and ask retrieve documents and code through the shared hybrid retrieval
workflow. A documents-only search filter is available. Plans, notes, and archives
remain searchable: classification must never be an admission filter.

Lexical search/context uses the existing completed snapshot without contacting
embedding providers or refreshing the index. Hybrid retrieval visibly degrades
to lexical evidence if embedding retrieval is unavailable. A failed automatic
refresh may use the last completed snapshot with an explicit staleness warning.
Mixed search preserves result scores without per-domain rank normalization.
For budgets of at least two results, one slot is reserved for a missing domain
when it has a candidate scoring at least 0.55 and meeting the requested threshold;
weak singleton matches cannot displace stronger evidence merely for diversity.

## Document purpose

An explicit Markdown frontmatter `kind` (`spec`, `guide`, `plan`, `archive`, or
`other`) and `status` (`active`, `proposed`, `historical`, or `superseded`) take
precedence over inference. Missing information remains unknown unless inferred.
Invalid metadata must not silently acquire authoritative spec status.

When ask's LLM is configured, indexing may use that provider to infer document
purpose. Classification is bounded, cached by source content and classifier
configuration/version, and advisory. Document text is untrusted data, not model
instructions; the classifier has no tools and cannot execute actions. Explicit
metadata needs no LLM classification. Missing credentials, provider failures, or
invalid responses do not prevent indexing or retrieval. Unknown documents remain
eligible audit candidates, including when no LLM is configured. No credentials
are stored in classification caches or printed in diagnostics.

## Recommended spec format

Initialization supplies a recommended Markdown template and agent instructions.
It describes behavior, guarantees, failure cases, and relevant tests, not an
inventory of implementation details. Existing documents need not be reformatted.
Doctor restores a missing template for registered projects during skills-version
checks (even when skills are current), and for projects selected for skills-only
repair or workspace repair. It does not overwrite an existing template. Full
doctor reinitialization preserves the contents of a user-edited template even
though uninstall removes project data; cancellation leaves it untouched.

The `Implementation` section declares project-root-relative paths in backticks,
optionally followed by `::Symbol` (class, method, or function). The `Tests` section
declares test paths in the same notation. Symbols refine navigation; whole-file
changes remain a conservative signal unless symbol-level comparison is available.
Ordinary prose links are navigation candidates, not explicit implementation
declarations, and Markdown links resolve relative to their containing document.
Missing targets and unresolved symbols are reported rather than
silently asserted to resolve. References cannot escape the project boundary.

## End-of-task audit

`idx audit <changed-paths...>` reports documents whose explicitly declared
implementation or tests intersect the task changes separately from possible
candidates found through ordinary references, dependencies, or hybrid retrieval.
The output includes source paths, changed paths, the basis of each match, and
classification provenance. Only explicit current specs belong in the strongest
spec signal; inferred classification and unknown documents remain distinguishable.

The scope is the task's changed files, including deletions, not accumulated
project-wide review obligations. Missing links and unavailable semantic retrieval
are visible. Files with no discovered document relationship are reported without
requiring a spec for every file. An empty candidate list is not proof of no drift.
Declarations are scanned from current source. Indexed dependency, symbol, and
retrieval signals use a completed snapshot and carry an explicit warning that
task changes may be absent until `idx index` refreshes that snapshot.

The audit means **code beneath a document changed**, not **the document is wrong**.
The calling agent compares the source text to implementation/tests and fixes real
semantic drift before finishing. Leaving an already-correct document unchanged is
valid. Audit does not edit source prose, run model-suggested commands, certify
correctness, or require acknowledgments.

## Interface

The wiki command family, registry administration, receipts, trust states,
manifests, review baselines, and durable review obligations are removed. There is
no legacy compatibility workflow. Normal usage is
`index → ask/search/context → change code/docs → audit task paths → fix drift`.
Database migration removes obsolete registry/receipt tables while retaining
code, document chunks, and snapshots.

## Implementation

- `src/knowledge/document-indexer.ts`
- `src/knowledge/document-scanner.ts`
- `src/knowledge/document-metadata.ts`
- `src/knowledge/document-metadata-types.ts`
- `src/knowledge/search.ts`
- `src/knowledge/context.ts`
- `src/knowledge/audit.ts`
- `src/engine/unified-search.ts`
- `src/cli/commands/audit.ts`
- `src/cli/commands/search.ts`
- `src/cli/commands/context.ts`
- `src/cli/commands/init.ts`
- `src/cli/commands/doctor.ts`
- `src/cli/spec-template.ts`
- `src/cli/commands/skills.ts`
- `src/core/config.ts`
- `src/storage/sqlite.ts`

## Tests

- `tests/unit/knowledge/document-indexer.test.ts`
- `tests/unit/knowledge/document-scanner.test.ts`
- `tests/unit/knowledge/document-metadata.test.ts`
- `tests/unit/knowledge/search.test.ts`
- `tests/unit/knowledge/context.test.ts`
- `tests/unit/knowledge/audit.test.ts`
- `tests/unit/engine/unified-search.test.ts`
- `tests/unit/storage/sqlite.test.ts`
- `tests/unit/cli/spec-template.test.ts`
- `tests/unit/cli/doctor.test.ts`
- `tests/unit/cli/skills.test.ts`
- `tests/cli/commands.test.ts`
