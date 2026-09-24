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
spec-only directory, registration step, or separate wiki collection. Search and
context retrieve documents and code through the shared hybrid retrieval workflow.
A documents-only search filter is available. Plans, notes, and archives
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

When `OPENROUTER_API_KEY` is configured, indexing may use Jev through OpenRouter's
Decisions API to infer document purpose. Kind and status are separate `choice`
questions over a structure-aware representation capped at 20,000 characters.
Short documents are sent unchanged. Longer documents preserve bounded frontmatter,
the Markdown heading outline, the beginning, lifecycle/purpose/implementation/test
sections, and the ending, so a late supersession or lifecycle note is not lost to
simple prefix truncation. The project-relative path is supplied as supporting
classification evidence, not as an authoritative label. Classification is cached
by source content and classifier configuration/version and remains advisory.
Document text is untrusted data, not classifier instructions; the classifier has
no tools and cannot execute actions. Explicit metadata needs no classifier call.
Missing credentials, provider failures, timeouts, or invalid responses do not
prevent indexing or retrieval. Unknown documents remain eligible audit candidates
when classification is unavailable or uncertain. No credentials are stored in
classification caches or printed in diagnostics. The global `~/.config/idx/.env`
holds `OPENROUTER_API_KEY` plus optional `IDX_JEV_MODEL`, `IDX_JEV_URL`, and
`IDX_JEV_TIMEOUT_MS`; exported environment variables override file values.
Choice answers are accepted only above configurable confidence floors. The
defaults are `IDX_JEV_KIND_MIN_CONFIDENCE=0.90` and
`IDX_JEV_STATUS_MIN_CONFIDENCE=0.65`; a field below its floor becomes
`unknown` independently of the other field. This intentionally favors
classification precision over coverage because unknown documents remain fully
searchable and inferred metadata is advisory.

Classifier availability is also advisory rather than an indexing dependency.
Missing credentials, authentication failure, exhausted credits, rate limits,
provider failure, timeout, or invalid provider output never fail document
indexing and never promote unknown metadata to an authoritative value. The
affected fields remain `unknown`; document chunks and embeddings are still
written and remain searchable. Each indexing run records a non-authoritative
`.indexer-cli/document-classification-status.json` diagnostic summary with
attempt/degradation counts and sanitized reason codes. `idx index` reports the
degradation after a successful index; `idx doctor` reports the last persisted
degraded state. Missing credentials, authentication failure, and exhausted
credits require immediate human action. Rate limits, provider failures,
timeouts, and invalid responses are initially safe transient degradation; they
escalate to human action when at least three classification attempts in one run
all degrade. Recovery requires fixing the external condition and rerunning
`idx index`; no knowledge database repair, deletion, or migration is required.

The opt-in classifier eval uses `evals/knowledge/document-classification.json`
and `tests/evals/document-classification.eval.test.ts`. It classifies curated
project documents through the real configured Jev endpoint, removes explicit
`kind`/`status` frontmatter fields before inference to prevent answer leakage,
checks the 20,000-character input bound, reports per-field accuracy/failures, and
requires at least 80% accuracy for both kind and the subset with status labels.

An additional external regression fixture lives in
`evals/knowledge/document-classification-holdout.json`. It contains 19
standalone anonymized Markdown cases derived from the cross-project holdout used
during classifier evaluation. Real project names, repository paths, URLs,
infrastructure identifiers, and product-specific names are not retained. The
fixture is intentionally a privacy-preserving derivative rather than a verbatim
copy of private project documents, so it is suitable for regression testing but
must not be presented as an unchanged copy of the original holdout corpus.
`tests/evals/document-classification-holdout.eval.test.ts` runs semantic,
strict-blind, and hard-blind modes against this fixture and checks the
precision-first invariant after confidence gating. Because anonymization and
paraphrasing can shift model behavior, this derivative fixture uses regression
floors of 90% accepted-decision precision and 50% coverage rather than requiring
perfect agreement. Its first recorded run produced about 93% accepted precision
for both kind and status in semantic/strict-blind modes, with one intentionally
retained ambiguous desktop-baseline case accounting for the accepted errors.
Run it explicitly with `npm run eval:document-classifier-holdout`.

### Local classifier experiment: Laya MLX

On 2026-09-24, `aac6fef/laya-multilingual-mlx` was evaluated as a possible
local classifier/fallback on Apple Silicon. The checkpoint has about 322M
parameters; its FP16 `model.safetensors` was 643,835,426 bytes. On the 16 GB
arm64 macOS test machine, a warm process used roughly 1.1-1.15 GB RSS. Short
warm decisions took about 14-16 ms; document-sized two-question decisions in
the experiment took roughly 160-584 ms.

The quality result was not sufficient for production use with the current
multiclass taxonomy. Using a fixed 19-document holdout from four other projects,
without changing labels or criteria after observing predictions, strict `kind`
accuracy was 9/19 (47.4%) and strict `status` accuracy was 7/17 (41.2%). The
main failure mode was lifecycle classification: current documents were often
predicted as `proposed` or `superseded`. Confidence gating could recover high
precision only by abstaining on most examples, so it did not provide useful
coverage.

Therefore Laya MLX is not an approved primary classifier or automatic fallback
for this contract. The experiment left no runtime dependency in `indexer-cli`.
A future evaluation may revisit a different formulation, especially decomposing
`kind` and `status` into binary typed decisions and deterministically combining
them, or evaluating a task-specific fine-tuned checkpoint. Any such attempt must
use a fresh holdout rather than tuning against the 2026-09-24 evaluation set.

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
`index → context/search → change code/docs → audit task paths → fix drift`.
Database migration removes obsolete registry/receipt tables while retaining
code, document chunks, and snapshots.

## Implementation

- `src/knowledge/document-indexer.ts`
- `src/knowledge/document-scanner.ts`
- `src/knowledge/document-classifier-config.ts`
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
- `tests/unit/knowledge/document-classifier-config.test.ts`
- `tests/unit/knowledge/document-metadata.test.ts`
- `tests/evals/document-classification.eval.test.ts`
- `evals/knowledge/document-classification.json`
- `tests/evals/document-classification-holdout.eval.test.ts`
- `evals/knowledge/document-classification-holdout.json`
- `tests/unit/knowledge/search.test.ts`
- `tests/unit/knowledge/context.test.ts`
- `tests/unit/knowledge/audit.test.ts`
- `tests/unit/engine/unified-search.test.ts`
- `tests/unit/storage/sqlite.test.ts`
- `tests/unit/cli/spec-template.test.ts`
- `tests/unit/cli/doctor.test.ts`
- `tests/unit/cli/skills.test.ts`
- `tests/cli/commands.test.ts`
