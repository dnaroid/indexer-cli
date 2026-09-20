# Knowledge retrieval

Implementation: `src/knowledge/search.ts`, `src/knowledge/lexical-index.ts`,
`src/knowledge/context.ts`, `src/knowledge/document-indexer.ts`,
`src/knowledge/embedding.ts`, `src/cli/commands/wiki-search.ts`,
`src/cli/commands/wiki-search-runtime.ts`, `src/cli/commands/wiki-runtime.ts`,
`src/cli/commands/context.ts`.
Regression evidence: `tests/unit/knowledge/search.test.ts`,
`tests/unit/knowledge/document-indexer.test.ts`,
`tests/unit/knowledge/context.test.ts`, `tests/unit/cli/wiki-runtime.test.ts`,
`tests/evals/knowledge-retrieval.eval.test.ts`.

Document indexing stores each chunk's normalized source text in `KnowledgeChunkRecord.metadata.searchText`.  This is an existing metadata field, not a schema change.  The `knowledge-lexical-v1` index fingerprint forces document chunks produced before this format to be refreshed.

Knowledge search has `hybrid` (default), `lexical`, and `semantic` modes. Lexical search tokenizes indexed chunk text plus the existing entry/path/relation metadata scoring. It returns section line ranges and `body:*` evidence. It uses a per-engine, immutable-snapshot in-memory inverted index, capped at four snapshots and 2,000 distinct terms per chunk. It is bounded to indexed chunks and therefore **is not exhaustive repository search**.

Hybrid combines accepted vectors, body lexical hits, and metadata/relation evidence deterministically. The default vector floor is 0.5, a conservative cutoff covered by the retrieval fixtures that rejects weak cosine neighbours with no lexical evidence; callers may deliberately set `semanticMinScore` for a different corpus. The live multilingual fixture passes all 26 top-1 queries, but this is not a generally calibrated production cutoff. Vector retrieval can help multilingual wording where lexical overlap is absent, but it is bounded document retrieval rather than an exhaustive answer source. Scores below the floor are abstained (`semantic-abstained`). `semantic` uses vectors only and fails if unavailable; `lexical` never initializes vectors or an embedding provider. If embeddings fail, hybrid continues lexical-only and exposes diagnostics identifying the degraded source, snapshot, and indexed chunk coverage.

Freshness checks occur only after scoring, filtering, and limiting candidates. Selected entries are hydrated in one `getStatuses(entries)` batch when available (with a per-entry fallback for older services), so rejected entries do not incur filesystem status work.

Context ranks tracked, semantic, and graph implementation candidates together: semantic/code and query-path relevance lead, while tracked relations remain provenance and a modest tie-breaker rather than an unconditional alphabetical reservation. Test hints are ranked by direct dependency and query/path relevance. Formatting enforces a minimum 200-token hard budget and reserves a compact row (with omission counts) for each nonempty warnings, primary knowledge, implementation, and tests source before verbose details; warning source counts remain visible even when individual warnings are clipped. A spec path is always included in `readNext`, even where no section range is indexed. Text is snapshot-keyed; callers must create a new search engine (or use a different snapshot id) after indexing.
