# Code search ranking contract

## Scope

This specification defines retrieval and ranking semantics for `idx search` and
for code retrieval performed by `idx context`. It covers candidate generation,
ranking modes, score calibration, test/import handling, index maintenance, and
the regression/evaluation evidence required before changing search behavior. It
also defines snapshot isolation for vector retrieval, because search correctness
depends on a completed snapshot remaining readable while a replacement snapshot
is being built.

## Core invariant

`hybrid` is a **union of independent retrievers**, not a rerank of vector-only
candidates. A strong lexical, symbol, or path match must be able to enter the
candidate set even when semantic vector retrieval misses it completely.

The independent channels are:

1. **semantic** — cosine similarity over locally stored code-chunk embeddings;
2. **lexical** — SQLite FTS5/BM25 over indexed chunk content, searchable path
   tokens, and primary-symbol tokens;
3. **symbol** — the durable symbol index, including functions, methods, classes,
   interfaces, types, variables, modules, and language-specific symbol kinds;
4. **path** — exact and tokenized project-relative code paths.

`hybrid` unions these candidate sets before final ranking. No channel is gated
by another channel.

## Ranking modes

- `--mode semantic` retrieves and ranks only semantic vector candidates.
- `--mode lexical` retrieves and ranks only FTS lexical candidates. It does not
  call the query embedding provider or vector search when the current code index
  is already usable.
- `--mode symbol` retrieves and ranks only symbol-index candidates. It does not
  call the query embedding provider or vector search when the current code index
  is already usable.
- `--mode hybrid` unions semantic, lexical, symbol, and path candidates and then
  applies code-aware fusion/ranking.

All public final scores are calibrated to `0..1`, so `--min-score` has one
meaning across modes. The configured default threshold is applied to the final
post-ranking score, not to an intermediate channel score.

## Query normalization

- Lexical/symbol/path query parsing is Unicode-aware and preserves non-Latin
  terms such as Cyrillic rather than silently dropping them.
- camelCase/PascalCase, snake_case, kebab-case, and path separators produce
  searchable component tokens.
- Lightweight English suffix stemming is allowed as an additional matching
  signal, but the unstemmed query terms are also sent to FTS so stemming cannot
  hide an exact indexed token.
- Exact one-token identifiers remain eligible for exact compact symbol matching
  even when token splitting also produces components.

## Fusion and code-aware reranking

Hybrid ranking combines two kinds of evidence:

- calibrated per-channel confidence, where an exact symbol/path can express
  near-certain intent independently of semantic similarity;
- weighted reciprocal-rank support across channels, so agreement between
  independent retrievers strengthens a candidate without requiring their raw
  score scales to be numerically comparable.

The implementation uses symbol > lexical > semantic > path channel priors for
rank support, while keeping the strongest calibrated match as the dominant
signal. Exact weights are implementation details and may be tuned only with the
search regression/eval suite; the behavioral invariants in this spec must remain
true.

The final candidate penalty/order rules are:

- import chunks are down-ranked when explicitly included; otherwise imports and
  preamble chunks are excluded by default;
- preamble chunks are down-ranked when explicitly included;
- test files are down-ranked **after fusion**, so lexical/symbol/path evidence
  cannot bypass the normal production-source preference;
- the test penalty is disabled when the query itself clearly asks for tests,
  fixtures, mocks, specs, or e2e code, and `--include-tests` also opts out of the
  default penalty;
- `--exclude-tests` always removes test candidates regardless of query intent.

Result hydration (filesystem reads for returned content and function-level
display-symbol refinement) happens only after candidate ranking and threshold
filtering, so rejected candidates do not cause unnecessary file reads.

## Symbol and path semantics

- Exact symbol-name lookup must retrieve the defining source candidate even when
  that chunk is absent from vector results.
- Symbol retrieval is not limited to functions/methods. Type/class/interface and
  other indexed definitions participate as first-class candidates.
- When the same exact symbol is defined in production and test code, production
  wins by default unless the caller/query explicitly requests tests.
- An exact project-relative path is first-class retrieval evidence and can enter
  hybrid results without semantic or lexical support.

## Lexical side index

Code chunk text is persisted in a dedicated SQLite FTS5 side index together with
searchable path/symbol fields. The canonical chunk metadata table remains the
source of ranges/types/identity; FTS is derived retrieval state.

The side index follows snapshot semantics:

- full/incremental indexing writes FTS rows together with code chunk metadata;
- unchanged-file snapshot copies copy the matching FTS rows as well;
- replacing a file's chunks replaces that file's FTS rows atomically with the
  metadata operation;
- pruning project snapshots removes orphan FTS rows;
- after an upgrade, if a completed snapshot contains code chunks but its FTS row
  count does not match, read commands request a one-time full reindex before
  claiming lexical/hybrid search is current.

This prevents an upgraded repository from silently degrading `hybrid` into
semantic-only retrieval.

## Vector snapshot isolation

Vector retrieval follows the same completed-snapshot contract as canonical
chunk metadata and FTS. Starting an incremental or full reindex must not make
the latest completed snapshot lose semantic candidates before the replacement
snapshot is complete.

The durable vector representation therefore separates the embedding identity
from snapshot membership:

- `vec_chunks` stores one embedding per `chunk_id`;
- `vector_meta` may reference the same `chunk_id` from multiple snapshots and
  uses `(project_id, snapshot_id, chunk_id)` as its identity;
- copying unchanged vectors to a new snapshot adds snapshot membership instead
  of moving/deleting the previous membership;
- deleting/pruning a snapshot removes the physical embedding only when no
  remaining snapshot metadata references that `chunk_id`;
- a full reindex builds beside the previous completed snapshot and prunes old
  snapshots only after the new snapshot is marked completed;
- upgrading a legacy database with globally unique `vector_meta.chunk_id`
  automatically rebuilds snapshot-aware metadata and restores missing snapshot
  memberships from canonical code/document chunk tables when the embedding is
  still present in `vec_chunks`.

This repair path is metadata-only: unchanged embeddings are reused and do not
require a full re-embed merely to restore snapshot membership.

`idx index --status` reports canonical code `Chunks` separately from semantic
`Embeddings`. `Chunks` must never be implemented as an alias for vector count;
imports and other intentionally non-embedded chunks can make the two counts
legitimately differ.

## CLI compatibility

- Default CLI mode remains `hybrid`; `SearchEngine` API default remains
  `semantic` for direct callers that depended on the old API default.
- Default CLI output remains compact and includes `rank=<mode>` plus `why=`
  channel evidence.
- `--path-prefix`, `--chunk-types`, `--include-imports`, test controls, dedupe,
  cluster, content output, and `--min-score` continue to filter/rank the unioned
  candidate set.
- Channel-specific retrieval never bypasses these filters. In particular, a
  symbol hit is returned only when it maps to an indexed chunk that satisfies
  the requested file/path/chunk-type constraints.
- Exact identifier/path lookup may still be cheaper with `rg`/LSP when the caller
  already knows what it wants; that workflow guidance does not weaken the search
  correctness contract.

## Neural reranking policy

The default local search pipeline does not add a cross-encoder/LLM reranker after
fusion. Independent candidate recall plus deterministic code-aware fusion is the
required baseline and keeps search local, fast, explainable, and usable without a
second inference model.

A neural reranker may be added later only as an optional final stage over a small
already-unioned candidate set when retrieval evals demonstrate a material top-1/
MRR improvement at an acceptable latency cost. It must never replace lexical,
symbol, path, or semantic candidate generation because a reranker cannot recover a
candidate that was never retrieved.

## Regression traps and evaluation

The TypeScript e2e fixture intentionally includes search traps:

- a production symbol with an identically named test double;
- a semantically plausible distractor that lacks the exact symbol/lexical fact;
- a unique lexical-only sentinel phrase;
- Cyrillic source text that must remain searchable lexically.

Coverage must include at least:

- vector miss rescued by lexical candidate generation;
- exact class/type symbol retrieval without vector participation;
- exact path retrieval;
- Unicode lexical retrieval;
- post-fusion source-vs-test preference;
- independent `semantic`, `lexical`, and `symbol` mode behavior;
- legacy FTS refresh detection and incremental FTS snapshot copying;
- vector snapshot membership surviving incremental copy and pruning;
- legacy vector metadata migration/backfill without re-embedding;
- full reindex preserving the previous completed snapshot until commit;
- index status reporting canonical chunks separately from embeddings;
- existing natural-language domain ranking scenarios.

Ranking changes should be judged on top-1/top-3 correctness plus candidate
recall and MRR for the trap/eval set, not by a handful of manually inspected
scores. The eval also reports semantic-only top-1 on hybrid cases as an ablation
baseline so multi-channel fusion must justify itself empirically.

## Evidence

- Search pipeline: `src/engine/searcher.ts`
- CLI behavior: `src/cli/commands/search.ts`
- FTS storage/migration: `src/storage/sqlite.ts`
- Vector storage/migration: `src/storage/vectors.ts`
- Code indexing: `src/engine/indexer.ts`
- Auto-index compatibility: `src/cli/commands/ensure-indexed.ts`
- Unit ranking coverage: `tests/unit/engine/searcher.test.ts`
- Storage coverage: `tests/unit/storage/sqlite.test.ts`
- Auto-index refresh coverage: `tests/unit/cli/ensure-indexed.test.ts`
- Index lifecycle coverage: `tests/unit/engine/indexer.test.ts`
- Dedicated CLI ranking coverage: `tests/cli/search-ranking.test.ts`
- CLI/e2e ranking coverage: `tests/cli/commands.test.ts`
- Real-embedding retrieval eval: `tests/evals/code-search-retrieval.eval.test.ts`
  with cases in `evals/code-search/retrieval-evals.json`
- Production exact-symbol/lexical trap: `fixtures/projects/e2e-app/src/search/hybrid-needle.ts`
- Semantic distractor: `fixtures/projects/e2e-app/src/search/hybrid-decoy.ts`
- Unicode lexical trap: `fixtures/projects/e2e-app/src/search/window-layout.ts`
- Exact-symbol test double: `fixtures/projects/e2e-app/tests/search/hybrid-needle.test.ts`
