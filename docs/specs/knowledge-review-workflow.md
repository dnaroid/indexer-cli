# Knowledge review workflow

Implementation: `src/knowledge/review.ts`, `src/knowledge/impact.ts`,
`src/storage/knowledge-reviews.ts`, `src/cli/commands/wiki-review.ts`,
`src/cli/commands/wiki-review-runtime.ts`.
Regression evidence: `tests/unit/knowledge/review.test.ts`,
`tests/unit/knowledge/impact.test.ts`, `tests/unit/cli/wiki-command-registration.test.ts`.

`wiki review collect [paths...] --scope <task>` converts `KnowledgeImpactEngine` facts into durable, project-scoped obligations. It stores them in `.indexer-cli/db.sqlite` tables that have no snapshot foreign keys, so snapshot pruning cannot discard review work.

One known contract receives one grouped obligation containing all changed paths. Uncovered paths, changed/new documents, and missing tracked primary contracts receive separate deterministic obligations. Each fingerprint contains exact-byte task-scoped current hashes (with distinct deleted and unreadable states), the selected paths, base ref and resolved base identity, plus runtime-supplied contract source, relation, and evidence state. Recollecting unchanged input reuses a resolution; any changed fingerprint, including a changed base with identical current bytes, clears it. Default path scopes use a digest rather than comma-joining paths. Scopes are independent.

Resolve with `wiki review resolve <id> --resolution updated-contract|new-contract|relations-updated|no-impact|needs-human --reviewer ... --rationale ... --evidence ...`. All three explanatory fields are required, including for `no-impact`; that resolution does not create a relation and cannot suppress a subsequently changed/new/missing obligation. Resolve reloads the persisted paths/base binding and recomputes fingerprints before writing, refusing stale IDs. `needs-human` remains `OPEN/NEEDS-HUMAN` and fails the gate.

Use `wiki check --base <ref> --scope <task>` in CI. It always recomputes impact and hashes before reconciling, then exits nonzero if relevant obligations lack a substantive resolution. `--json` is machine readable. Collection and checks only record/report facts; they do not alter contracts, relations, or make semantic decisions. Path collection rejects root escapes and external symlinks; unreadable files fail safe rather than being reported as deletions.
