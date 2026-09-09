# LLM Knowledge Layer / Wiki — implementation plan

Status: **planned / implementation not started**  
Owner: indexer-cli  
Primary data directory: `.indexer-cli/`  
Last updated: 2026-09-09

## Goal

Turn `indexer-cli` from a code-discovery index into a project knowledge engine
that can maintain behavioral specifications and other useful project knowledge,
connect that knowledge to implementation/tests, detect drift after code changes,
and return compact LLM-ready context.

The existing repository documents remain the source of truth. The index is
derived navigation, retrieval, relationship, and freshness metadata.

The intended end state is:

```text
repository files
  ├─ source code / tests
  └─ specs / RFCs / design docs / guides
          ↓
    indexer-cli snapshot + knowledge index
          ├─ semantic/lexical retrieval
          ├─ code dependency graph
          ├─ knowledge ↔ code/spec relations
          ├─ lifecycle / precedence
          ├─ verification baselines / drift
          └─ changed-path impact analysis
                    ↓
              idx context / idx wiki
                    ↓
                 LLM agent
```

## Architectural boundary

`indexer-cli` owns deterministic and indexed facts:

- project/document discovery;
- hashes and Git/snapshot state;
- embeddings and lexical retrieval;
- dependency/call graph evidence;
- knowledge metadata and relationship provenance;
- lifecycle, verification baselines, and freshness computation;
- changed-path coverage and impact candidates;
- compact context assembly.

The calling LLM/agent owns semantic judgments:

- whether a candidate document is truly a behavioral spec;
- `as-is` vs intended `change` meaning when it is not explicit;
- whether code changes actually alter documented behavior;
- whether an uncovered code path should become a durable spec relation;
- whether overlapping documents are historical/superseded/current;
- semantic verification before a baseline is accepted.

There must be **no hidden generative LLM call** inside normal indexing,
auto-indexing, `post-commit`, `search`, or `status` flows. Ollama embeddings are
retrieval infrastructure, not semantic authority.

## Non-goals

- Automatically rewrite primary specs from changed code.
- Treat a matching hash as proof of semantic correctness.
- Turn Markdown/docs into normal code modules visible in `idx architecture` or
  `idx structure` by default.
- Require repositories to move specs into a fixed folder or template.
- Require a separate `.spec-wiki/` state directory in the final design.
- Replace exact code lookup (`rg`, LSP) with semantic wiki search.

## Core invariants

1. Primary source documents are authoritative; generated summaries/catalogs are
   never primary evidence.
2. Classification and semantic verification are separate operations.
3. A clean bootstrap/index may produce `unverified`; it must never manufacture
   `fresh`.
4. Verification fingerprints both source/input hashes and the durable relation
   map. Adding/removing tracked inputs invalidates the old baseline.
5. Changed implementation requests review; it does not automatically change spec
   semantics.
6. Lifecycle (`active`, `proposed`, `historical`, `superseded`) is independent
   from behavioral type (`as-is`, `change`, `mixed`).
7. Explicit and inferred relationships retain provenance.
8. Missing retrieval results never prove that no relevant spec exists.
9. Task-scoped changed paths take precedence over the whole dirty worktree for
   impact analysis.
10. An uncovered changed path must be semantically reviewed before a material
    behavior-changing task is considered knowledge-complete.

---

## Target architecture

## 1. One project index, two file domains

Extend the snapshot model so indexable files have a domain/kind:

```text
code
document
```

Do **not** register Markdown as a normal `LanguagePlugin` and let it leak into
existing code commands.

Expected behavior:

- `idx architecture`, `idx structure`, `idx ast`, `idx explain`, and normal code
  dependency output remain code-focused by default.
- document files use the same project root, Git/snapshot lifecycle, hash model,
  embedding provider, and SQLite database.
- wiki commands query the document/knowledge domain explicitly.
- `idx context` may intentionally combine both domains.

Candidate document extensions initially:

```text
.md .mdx .rst .adoc .txt
```

Repository config can override/include/exclude/force document paths.

## 2. Durable knowledge state vs ephemeral snapshots

Code/document file content belongs to snapshots.

Semantic knowledge metadata and accepted verification baselines are
**project-scoped durable state**, because the engine intentionally prunes old
snapshots after successful indexing.

At runtime freshness is computed by comparing durable knowledge baselines with
the latest completed snapshot / current filesystem hashes.

## 3. Proposed SQLite schema

### `knowledge_entries`

One row per classified knowledge source path.

```text
project_id               TEXT
path                     TEXT
classification           TEXT
behavior_type            TEXT
lifecycle                TEXT
confidence               TEXT
title                    TEXT
summary                  TEXT
topics_json              TEXT
indexed_source_hash      TEXT
indexed_at               INTEGER
verified_source_hash     TEXT NULL
verified_relations_hash  TEXT NULL
verified_at              INTEGER NULL
metadata_json            TEXT NULL
PRIMARY KEY(project_id, path)
```

Classifications:

```text
spec
spec-like
meta-index
design-only
guide
other
```

Behavior types:

```text
as-is
change
mixed
unknown
```

Lifecycle:

```text
active
proposed
historical
superseded
unknown
```

### `knowledge_relations`

```text
project_id
source_path
target_path
target_kind       code | knowledge
relation_kind     implements | tests | related | supersedes | superseded-by
provenance        explicit | inferred
metadata_json
PRIMARY KEY(project_id, source_path, target_path, target_kind, relation_kind,
            provenance)
```

The initial CLI may expose only the relation kinds already proven useful by
`spec-wiki`, while the storage schema remains extensible.

### `knowledge_verified_inputs`

```text
project_id
source_path
input_path
input_hash
verified_at
PRIMARY KEY(project_id, source_path, input_path)
```

This is the accepted implementation/test baseline. It is rewritten only by an
explicit semantic `verify` operation.

### `knowledge_chunks`

Document chunks should have structured metadata rather than masquerading as code
symbols:

```text
project_id
snapshot_id
chunk_id
file_path
start_line
end_line
content_hash
chunk_type        doc_title | doc_section | doc_full | doc_links
heading
metadata_json
```

Vectors can reuse `vec_chunks`; add a vector/file-domain discriminator to
`vector_meta` (or an equivalent filter) so normal code search does not return
wiki documents unless requested.

### Generated project catalog

Use the existing `artifacts` mechanism for derived views only:

```text
artifact_type = knowledge_catalog
scope         = project
```

This artifact is the compact fallback/router analogous to the current
`.spec-wiki/index.md`. It is not the authoritative knowledge state.

## 4. Document chunking

Implement a document chunker independently of code language plugins.

Initial chunk strategy:

- title/preamble chunk;
- section chunks split by Markdown/RST/AsciiDoc headings;
- bounded full-file chunk for short documents;
- preserve line ranges;
- keep headings in embedded text;
- do not embed generated/fixture/resource noise by default;
- allow explicit include/force config.

For very long sections, reuse token-budget splitting with overlap but prefer
heading boundaries.

## 5. Document discovery heuristics

The deterministic scanner only creates candidates; it does not decide semantic
classification.

Signals migrated from the proven `spec-wiki` implementation:

- spec/contract/requirements/RFC/protocol-like names;
- spec-like directories;
- behavior/contracts/requirements/invariants/scope/non-goals/verification
  headings;
- explicit `Type` / lifecycle language;
- code/test path references;
- design/ADR/evidence signals;
- meta-index language and dense doc links;
- strong negative weights for fixtures/evals/examples/generated skill resources.

Deep coverage mode must be able to show all unclassified document-like files
regardless heuristic score while still excluding known resource/fixture noise.

## 6. Explicit relationship extraction

Resolve links/path references from primary docs with this search order:

1. document directory;
2. nearest ancestor package roots (`package.json`, `pyproject.toml`, `Cargo.toml`,
   `go.mod`, etc.);
3. repository root;
4. explicit prose hints such as "paths below are relative to `external/foo/`".

Keep unresolved strong path hints as diagnostics. Do not silently discard them.

Explicit document links become `knowledge` relations; code/test links become
`code` relations. Explicit edges and inferred supersession edges may coexist.

---

## CLI design

## `idx wiki discover`

```bash
idx wiki discover [--limit 40] [--cursor ...] [--all-unclassified]
```

Returns compact candidates with path/title/score/role hints/signals and existing
classification if present.

## `idx wiki record`

Semantic classification/index metadata only. Does not verify.

```bash
idx wiki record \
  --path docs/auth.md \
  --classification spec \
  --type as-is \
  --lifecycle active \
  --confidence high \
  --summary "Authentication lifecycle and refresh invariants." \
  --topic auth --topic sessions
```

Primary records require explicit type and lifecycle on first classification.

## `idx wiki verify`

```bash
idx wiki verify --path docs/auth.md
```

Only after the agent has semantically checked the source against relevant
implementation/tests/evidence.

Writes:

- verified source hash;
- verified durable relation hash;
- verified input hashes;
- verification timestamp.

## `idx wiki relate`

```bash
idx wiki relate --path docs/auth.md --add-code src/auth/refresh.ts
idx wiki relate --path docs/auth.md --remove-code src/auth/legacy.ts
idx wiki relate --path docs/auth.md --add-supersedes docs/auth-v1.md
```

Only inferred edges are removable through the CLI. Source-explicit edges require
editing the source document.

Any effective relation-map change invalidates `fresh` until re-verification.

## `idx wiki search`

```bash
idx wiki search "почему старый tool result нельзя удалять до provider request"
```

Use existing Ollama embeddings + lexical metadata + path/relation matching.

Searchable evidence:

- title;
- topics;
- summary;
- document chunks;
- source path;
- code relation paths;
- related/supersession paths;
- lifecycle.

Default ranking:

- semantic candidate generation;
- lexical/path/relation bonuses;
- active > proposed > historical > superseded tie preference;
- return freshness status with every primary result;
- do not bury a stale but highly relevant spec merely because it is stale.

The calling agent still semantically reranks the compact candidates before using
them as authoritative sources.

## `idx wiki status` / `idx wiki audit`

Report:

- total/current primary specs;
- fresh/unverified/stale counts;
- `spec-changed`, `inputs-changed`, `spec+inputs-changed`, `missing-source`;
- unresolved references;
- new/changed document candidates;
- active as-is specs with no tracked implementation inputs.

## `idx wiki impact`

```bash
idx wiki impact src/auth/session.ts src/auth/refresh-worker.ts
idx wiki impact --git
```

Task-scoped paths are preferred. Git fallback uses committed + workspace changes.

Output:

- `knownAffected` specs from durable relations;
- `uncoveredPaths` with no known spec relation;
- changed/new document obligations regardless heuristic score;
- missing/moved primary sources;
- dependency/call-graph expansion around changed code;
- semantic wiki candidates for uncovered implementation paths;
- a `semanticSweepRequired` flag/reason list.

Important: graph/semantic candidates are hints. The CLI does not automatically
persist a relation from similarity alone.

## `idx context`

```bash
idx context "session refresh retry"
idx context "session refresh retry" --budget 3000
idx context "session refresh retry" --path-prefix src/auth
```

Return one compact LLM context pack containing, in priority order:

1. primary contracts + freshness;
2. implementation ranges;
3. relevant tests;
4. durable knowledge/code relations;
5. optional secondary design context;
6. compact architecture/dependency hints when useful.

Context output must be token-budgeted and deduplicated. It should return paths
and smallest useful ranges by default, not dump source bodies.

Potential machine-readable output:

```json
{
  "query": "session refresh retry",
  "knowledge": [],
  "implementation": [],
  "tests": [],
  "freshnessWarnings": [],
  "readNext": []
}
```

---

## Incremental maintenance integration

## Snapshot/index flow

Extend `ensureIndexed` / incremental indexing so document-domain changes are
represented in the latest snapshot without forcing code architecture commands to
display them.

Rules:

- changed document bytes update document chunks/vectors and
  `indexed_source_hash` only when the semantic metadata is explicitly re-recorded;
- structural status can still report that a classified source changed before it
  is re-recorded;
- changed code immediately affects freshness when its hash differs from an
  accepted verified input baseline;
- relation-map changes invalidate verification independently of file bytes;
- new implementation files with no relation appear as uncovered paths in impact;
- deleted/moved docs become missing sources until the new path is classified and
  old metadata is explicitly removed;
- no auto-index/post-commit path may call `verify`.

## Git post-commit hook

Keep the existing post-commit index update. Knowledge indexing must be safe to
run there because it only updates deterministic document/file/vector state.

Semantic classification/verification remains explicit and agent-driven.

---

## Legacy `.spec-wiki`

Legacy `.spec-wiki` state is intentionally **not supported**.

- no importer;
- no schema compatibility layer;
- no automatic coexistence or state synchronization;
- no attempt to trust/import old verification baselines.

Projects adopting the knowledge layer bootstrap it from repository documents
and current code/test evidence. The standalone `spec-wiki` prototype may be
removed once `idx wiki` reaches feature/eval parity.

Compatibility obligations remain only for existing `.indexer-cli` databases
from earlier releases.

---

## Generated agent integration

Keep a **thin** generated `repo-discovery` skill rather than a second large wiki
skill during the first release.

Add routing rules:

```text
question about project behavior/requirements/contracts
  → idx wiki search or idx context

material behavior-changing implementation complete
  → idx wiki impact <task-scoped changed paths>

repo/code discovery only
  → existing idx search/structure/ast/explain/deps
```

When/if `indexer-cli` later exposes first-class MCP/Pi tools with strong tool
descriptions, reassess whether the generated skill is needed at all.

---

## Implementation phases and tracking

Legend: `[ ]` pending, `[~]` in progress, `[x]` complete.

## Phase 0 — architecture lock

- [x] Inspect current snapshots/storage/search/indexing/skill architecture.
- [x] Decide project-scoped semantic state + snapshot-scoped file/document data.
- [x] Decide documents must not pollute existing code discovery by default.
- [x] Decide no hidden generative LLM calls in core indexing.
- [x] Save this tracked implementation plan.

Exit criterion: architecture and sequencing are explicit enough to implement
without inventing data ownership during coding.

## Phase 1 — storage foundation

- [x] Add `FileDomain` / equivalent discriminator to types/storage where needed.
- [x] Add SQLite migrations for knowledge entries, relations, verified inputs,
  and document chunk metadata.
- [x] Add vector-domain filtering/migration without breaking existing vectors.
- [x] Add typed `KnowledgeStore` APIs (or extend `MetadataStore` cleanly).
- [x] Add unit tests for migration from an existing 0.12.x database.
- [x] Add unit tests for CRUD, transactions, relation provenance, and baseline
  persistence.

Exit criterion: old indexes open successfully; new knowledge rows persist and
are queryable without altering current command output.

## Phase 2 — document indexing/discovery

- [x] Add document scanner/config (`documentIncludePaths`, exclude/force options
  if separate config is preferable).
- [x] Add heading-aware document chunker with line ranges/token bounds.
- [x] Add document embeddings to the existing vector store/domain filter.
- [x] Add incremental copy/reindex/delete behavior for document files.
- [x] Port discovery signals/noise filters from `spec-wiki`.
- [x] Port package-relative/path-reference resolver + unresolved diagnostics.
- [x] Ensure architecture/structure/search code defaults remain unchanged.

Exit criterion: docs can be incrementally indexed and semantically searched as a
separate domain; code discovery regression tests remain green.

## Phase 3 — core wiki CLI

- [ ] Add `idx wiki discover`.
- [ ] Add `idx wiki record`.
- [ ] Add `idx wiki verify`.
- [ ] Add `idx wiki relate`.
- [ ] Add `idx wiki remove` (metadata only).
- [ ] Add freshness computation and relation-map fingerprint.
- [ ] Add `idx wiki status` / `audit`.
- [ ] Add compact `knowledge_catalog` artifact generation.

Exit criterion: all deterministic state/freshness behavior from `spec-wiki` has
feature parity in TypeScript/SQLite.

## Phase 4 — hybrid knowledge retrieval

- [ ] Add `idx wiki search` using document vectors.
- [ ] Blend semantic + lexical + title/topic/path/relation scoring.
- [ ] Support active/proposed/historical/superseded ranking semantics.
- [ ] Return machine-readable evidence/reason codes and freshness.
- [ ] Port 26 live retrieval regression cases.
- [ ] Target >=95% top-1 and 100% top-3/recall on the existing regression set.

Exit criterion: no query-expansion workaround is required for multilingual
paraphrases to achieve regression targets.

## Phase 5 — impact and maintenance

- [ ] Add task-scoped `idx wiki impact <paths...>`.
- [ ] Add Git fallback using existing `SimpleGitOperations` change model.
- [ ] Combine known durable relations with module/call graph expansion.
- [ ] Add semantic wiki candidate retrieval for uncovered paths.
- [ ] Surface every changed/new document for classification regardless discovery
  score.
- [ ] Detect moved/missing primary sources.
- [ ] Preserve no-impact as a valid semantic outcome; never create a relation just
  to make coverage non-empty.
- [ ] Port the 5 deterministic maintenance regression cases.
- [ ] Port semantic maintenance scenarios (new relation, move, score-0 spec,
  no-impact control).

Exit criterion: material changed paths are either linked to reviewed current
knowledge or explicitly surfaced for semantic no-impact review.

## Phase 6 — `idx context`

- [ ] Define context result schema and text formatter.
- [ ] Retrieve primary knowledge first, then code ranges/tests.
- [ ] Use dependency graph to enrich implementation evidence without exploding
  output.
- [ ] Add token budget and deduplication.
- [ ] Add `Read next:` recommendations.
- [ ] Add tests for stale/unverified knowledge warnings.
- [ ] Add tests for code-only queries where no spec exists.

Exit criterion: one command can produce a compact, useful project context pack
without reading the full wiki or broad source tree.

## Phase 7 — agent integration

- [ ] Update `src/cli/commands/skills.ts` routing guidance.
- [ ] Extend allowed commands for wiki/context.
- [ ] Keep progressive disclosure / one-cheapest-command behavior.
- [ ] Update `README.md` command docs and onboarding.
- [ ] Add `idx doctor` checks for knowledge/vector schema health if necessary.
- [ ] Verify `idx init --refresh-skills` upgrades existing generated skills.

Exit criterion: agents naturally use knowledge/context for behavioral questions
and impact checks without a separate `spec-wiki` skill.

## Phase 8 — compatibility and prototype retirement

- [x] Explicitly reject legacy `.spec-wiki` compatibility/import requirements.
- [ ] Test upgrade from existing pre-knowledge `.indexer-cli` databases.
- [ ] Document clean knowledge bootstrap for existing indexer projects.
- [ ] Decide retirement/removal point for standalone `spec-wiki` prototype.

Exit criterion: existing `indexer-cli` projects upgrade safely, while old
`.spec-wiki` state is neither read nor trusted.

## Phase 9 — full validation and release readiness

- [ ] `npm test` unit suite.
- [ ] CLI suite for all supported languages.
- [ ] knowledge-specific unit/CLI/integration tests.
- [ ] retrieval regression.
- [ ] maintenance regression.
- [ ] generated skill trigger evals / behavior evals.
- [ ] existing code-search/architecture/deps regression.
- [ ] fresh-init database test.
- [ ] upgrade-from-old-database migration test.
- [ ] incremental dirty-worktree test.
- [ ] post-commit hook test.
- [ ] large-repository document-index performance/token-output check.
- [ ] independent code review focused on migration, freshness, and false-positive
  relation risks.
- [ ] update README/version/release notes.

Exit criterion: no High/Medium review findings, all regression suites pass, and
the old code-discovery UX is unchanged unless the user invokes wiki/context.

---

## Acceptance scenarios

The implementation is not complete until all of these work end-to-end.

### A. Clean bootstrap

Scattered requirements/RFC/overview/guide files are indexed. Requirements and
behavioral RFCs can become primary knowledge; overview stays meta-index; guide is
not primary; code/tests are evidence; newly classified primary docs are
`unverified` until semantic verification.

### B. Multilingual semantic query

```text
"почему старый tool result нельзя удалять до отправки провайдеру"
```

finds the provider-cache stability contract without manual English query
expansion.

### C. New implementation surface

A new `refresh-worker.ts` implements an existing session refresh contract but has
no durable relation. `idx wiki impact` surfaces it as uncovered, graph/semantic
candidates point to the session spec, agent adds a durable relation, old baseline
becomes stale, then explicit verification returns it to fresh.

### D. No-impact control

A telemetry formatting helper appears near auth code but does not affect auth
behavior. Impact requires semantic review but no relation/spec edit is invented.

### E. Move

An active primary spec is `git mv`'d. Old path becomes missing, new path is a
document classification obligation, new entry is recorded/verified, then old
metadata is removed without duplicate current authority.

### F. Relation removal

Removing a tracked input changes the relation fingerprint and therefore cannot
silently leave the spec fresh.

### G. Historical precedence

An old MVP spec and newer active feature spec can both be retrieved, but active
knowledge ranks first and supersession/history remains explicit.

### H. Context pack

One `idx context` request returns primary spec metadata/freshness, relevant code
ranges, nearest tests, and read-next hints within the requested token budget.

---

## Risk register

<!-- markdownlint-disable MD013 -->

| Risk | Mitigation |
| --- | --- |
| Docs pollute existing code search/architecture | domain filters; code remains default |
| Snapshot pruning deletes semantic verification history | keep knowledge baselines project-scoped |
| Similarity creates false spec relations | retrieval/graph edges are candidates only; persistence is explicit |
| Auto-index declares semantic correctness | indexing never calls verify |
| Low-signal specs never discovered | changed-doc obligation + bounded all-unclassified audit |
| Stale spec hidden by ranking | freshness is reported, not used as a relevance veto |
| Relation removal hides drift | verified relation fingerprint |
| Dirty worktree mixes unrelated changes | task-scoped impact paths first |
| Embedding model/version changes affect retrieval | store/index model metadata and force vector rebuild when incompatible |
| Existing db migration breaks installed projects | idempotent migrations + old-db fixture tests |

<!-- markdownlint-enable MD013 -->

---

## Progress log

## 2026-09-09

- Completed architecture review of current `indexer-cli` 0.12.35.
- Confirmed existing reusable infrastructure: SQLite snapshots, incremental Git
  indexing, sqlite-vec, Ollama embeddings, hybrid code search, dependency/call
  graph, artifacts, post-commit hook, generated repo-discovery skill.
- Locked the knowledge-layer architecture and saved this implementation plan.
- Completed Phase 1 storage foundation: knowledge tables/APIs, file/vector domain
  isolation, legacy DB/vector migration, and verification-input persistence.
- Phase 1 focused storage/vector regression: 62/62 tests passed; TypeScript
  `--noEmit` compile passed.
- Completed Phase 2 document-domain indexing: scanner/config, heading-aware
  chunking, document embeddings, discovery signals, explicit relation resolver,
  and document-aware auto-indexing while code discovery remains the default.
- Phase 2 focused regressions: 88/88 config/storage/knowledge tests, 99/99
  existing engine/auto-index tests, plus the document-only auto-index regression;
  TypeScript `--noEmit` compile passed.
