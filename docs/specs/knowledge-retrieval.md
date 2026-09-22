# Knowledge retrieval

Implementation: `src/knowledge/search.ts`, `src/knowledge/service.ts`,
`src/knowledge/lexical-index.ts`, `src/knowledge/context.ts`,
`src/knowledge/document-indexer.ts`,
`src/knowledge/embedding.ts`, `src/cli/commands/wiki-search.ts`,
`src/cli/commands/wiki-search-runtime.ts`, `src/cli/commands/wiki-runtime.ts`,
`src/cli/commands/wiki.ts`, `src/cli/commands/context.ts`,
`src/cli/commands/skills.ts`.
Regression evidence: `tests/unit/knowledge/search.test.ts`,
`tests/unit/knowledge/service.test.ts`,
`tests/unit/knowledge/document-indexer.test.ts`,
`tests/unit/knowledge/context.test.ts`, `tests/unit/cli/wiki-runtime.test.ts`,
`tests/unit/cli/wiki-command-registration.test.ts`,
`tests/evals/knowledge-retrieval.eval.test.ts`, `tests/cli/commands.test.ts`.

Document indexing stores each chunk's normalized source text in
`KnowledgeChunkRecord.metadata.searchText`. This is an existing metadata field,
not a schema change. The `knowledge-lexical-v1` index fingerprint forces
document chunks produced before this format to be refreshed.

Knowledge search has `hybrid` (default), `lexical`, and `semantic` modes.
Lexical search tokenizes indexed chunk text plus the existing
entry/path/relation metadata scoring. It returns section line ranges and
`body:*` evidence. It uses a per-engine, immutable-snapshot in-memory inverted
index, capped at four snapshots and 2,000 distinct terms per chunk. It is
bounded to indexed chunks and therefore **is not exhaustive repository
search**.

Reviewed `spec`/`spec-like` entries remain the primary retrieval tier. Search
may also use indexed document chunks whose paths have no `knowledge_entries`
row. When registered results match, the default allowance is one labeled
indexed-document result and `limit=1` keeps a matching registered result
exclusive. When no registered result matches, indexed documents may fill the
entire requested result limit so a freshly indexed repository is immediately
useful without a classification pass. Registered results are always emitted
before indexed unclassified results. Callers may disable fallback or change its
allowance. Indexed unclassified results are explicitly
`authority=unreviewed-indexed`, `classification=unclassified`, and
`status=unreviewed`; they never become registered knowledge. Retrieval does
**not** create a synthetic knowledge entry, relation, lifecycle, verification
receipt, or authority claim for the document. A registered non-primary entry
(for example `guide`, `other`, or a `design-only` entry not requested with
`includeSecondary`) is not relabeled as unreviewed fallback.

Trust and verification are separate. Registered knowledge is `trust=default`
when it has no current verification receipt or explicit trust binding, so
retrieval uses it but emits a warning when freshness is not `fresh`. Indexed
unclassified documents are also `trust=default` for retrieval while remaining
`status=unreviewed`; default trust is permission to use evidence with warnings,
not semantic verification or classification. `idx wiki trust`
stores an explicit trust binding in entry metadata without creating or changing
a verification receipt; `--all` applies it to all recorded entries and `--clear`
returns entries to default trust. Explicit trust binds to the current source hash,
so a later source edit automatically falls back to `trust=default`. A currently
fresh attested entry reports `trust=verified`. Default trust never promotes an
indexed document into `knowledge_entries` or gives it primary-spec relations.

Hybrid combines accepted vectors, body lexical hits, and metadata/relation
evidence deterministically. The default vector floor is 0.5, a conservative
cutoff covered by the retrieval fixtures that rejects weak cosine neighbours
with no lexical evidence; callers may deliberately set `semanticMinScore` for
a different corpus. The live multilingual fixture passes all 26 top-1 queries,
but this is not a generally calibrated production cutoff. Vector retrieval can
help multilingual wording where lexical overlap is absent, but it is bounded
document retrieval rather than an exhaustive answer source. Scores below the
floor are abstained (`semantic-abstained`). `semantic` uses vectors only and
fails if unavailable; `lexical` never initializes vectors or an embedding
provider. If embeddings fail, hybrid continues lexical-only and exposes
diagnostics identifying the degraded source, snapshot, and indexed chunk
coverage. Unreviewed fallback uses the same snapshot-keyed document chunks
produced by both full and incremental indexing, so no classification pass is
required before its text becomes retrievable.

Freshness checks occur only after scoring, filtering, and limiting candidates.
Selected entries are hydrated in one `getStatuses(entries)` batch when
available (with a per-entry fallback for older services), so rejected entries
do not incur filesystem status work.

Context ranks tracked, semantic, and graph implementation candidates together:
semantic/code and query-path relevance lead, while tracked relations remain
provenance and a modest tie-breaker rather than an unconditional alphabetical
reservation. Test hints are ranked by direct dependency and query/path
relevance. Indexed unreviewed documents are separated from `Primary knowledge`,
emit an explicit default-trusted/unreviewed warning, do not contribute knowledge
relations, and are labeled `Indexed knowledge (unreviewed)` plus
an unreviewed evidence/read row in formatted context. When no registered primary knowledge
matches, context may use up to its normal `maxSpecs` allowance from this tier;
when registered primary knowledge matches, only one indexed unreviewed result is
reserved by default. Formatting enforces a minimum 200-token hard budget and
reserves a compact row for each nonempty warnings, primary knowledge,
unreviewed fallback, implementation, tests, knowledge-relations, and
read-next-only source before using remaining budget for additional selected rows.
It emits each evidence path once where possible (rather than repeating it in
`Read next`), retains warnings and knowledge relations, and reports the exact
count of source rows hidden by the budget. After reserving source coverage,
remaining space restores exact paths, complete warnings, reasons and brief
summaries; budget-shortened rows are counted separately as `clipped` in `TRUNC`.
Distinct follow-up ranges are retained even when their file already appears.
Knowledge relation rows retain both source and target identity.
Each full knowledge row includes its range, status/trust, and brief summary.
A matched knowledge or fallback document
path is included in `readNext`, even where no section range is indexed. Text is snapshot-keyed;
callers must create a new search engine (or use a different snapshot id) after
indexing.

CLI text is intentionally more compact than JSON. `idx wiki search` emits one
evidence-bearing row per result (including its best range when available), and
does not run discovery merely to repeat review guidance; `--verbose` adds full
title/summary and reason-code details plus an optional discovery recommendation.
Its JSON payload retains the established discovery counts and recommendation
fields. `idx wiki discover` defaults to 40 one-line candidates,
retains total/cursor/next-cursor omission information, and exposes signals with
`--verbose`. `idx wiki status`/`audit` use a short discovery pointer by default
and retain the full recommendation under `--verbose`; JSON is unchanged.
`idx context` does not emit unrelated discovery recommendations. Its default
source rows include paths, ranges, status/trust, and knowledge summaries,
then state omitted counts rather than duplicating those paths in detailed and
`Read next` sections. `--verbose` adds titles and reason-code detail within the
same budget. Auto incremental refresh, freshness, trust, unreviewed, and degradation
warnings remain enabled in both modes.
