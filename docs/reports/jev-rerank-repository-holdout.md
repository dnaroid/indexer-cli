---
kind: archive
status: historical
---

# Jev reranking on repository-grounded queries — 2026-10-01

> Archive note: the experimental code, tests, dataset, and npm scripts were
> subsequently removed at the user's request. Commands and implementation paths
> below describe the historical run, not currently available tooling. Results
> and local evidence references are preserved; rerunning requires restoring or
> recreating the harness and dataset first.

## Decision

**Do not enable reranking by default on this evidence.** On 24 newly authored
queries, Jev fixed three labeled Top-1 misses but displaced seven previously
first-ranked labeled files. Code Top-3 improved, while Top-1 and MRR declined
in both domains. The reranker added about 410 ms median latency.

These are **target-file metrics against sparse synthetic labels**, not an
exhaustive judgment of answer usefulness. Some unlabelled files are valid
answers, and the code payload was heavily truncated. This evaluates the tested
integration and budget, not Jev's general ability or a production workload.

This follows the [development-fixture experiment](jev-rerank-experiment.md);
its results remain separate and unchanged.

## Protocol and corpus

- Command: `npm run eval:rerank:jev:repository`.
- Dataset: `evals/jev-rerank/repository-holdout.json`, 16 code and 8 document
  queries, 22 English and 2 Russian. Code includes 12 behavior questions,
  2 exact-symbol/path guards, and 2 explicit test-intent questions.
- Two source-only research passes authored queries and expected paths without
  viewing retrieval rankings or Jev outputs. The parent checked source evidence
  and fixed labels before retrieval. No post-result relabeling or prompt tuning.
  This is a small repository-grounded synthetic holdout, not user logs or an
  independently human-adjudicated, cross-repository benchmark.
- Corpus: 369 indexed files (353 code, 16 documents), completed snapshot
  `748af2d2-b3c5-479e-bb7b-7752899475e9`, git HEAD
  `9f0c5ddb5de3fbd1dec7f7fff4b79599cbb633c4`, with uncommitted eval/doc additions.
  Full indexed hashes and worktree paths are in the archived provenance.
- Label SHA-256:
  `40edd5e3fe4c25158e47a4deb5b42a4aa339aab9811796499594d13107a3cbd8`.
- Ollama embeddings: `jina-8k` for code, `nomic-embed-text-v2-moe` for documents,
  768 dimensions, `ollamaNumCtx: 512`.
- Requested Jev: `typesafe/jev-1.13`; returned build:
  `typesafe/jev-1.13-20260917`. One sequential request per query, 5-second timeout,
  no retries; all 24 requests succeeded and reported cost.

Both arms use the same hybrid candidates, `minScore: 0`, and hydrated content.
Code uses 20 chunks per query (6–15 distinct files); documents use up to 20 files
(all 16 corpus documents returned). Domains are searched separately: this does
not test unified code/document competition. All candidates were archived before
any reranking call. Labels and baseline scores were not sent to Jev.

File metrics collapse repeated chunks to their first occurrence. Binary nDCG@10
and candidate Recall@20 use the frozen expected paths, not graded relevance.
The baseline is this top-20 retrieval, not the normal CLI default result limit
or latency. Recall cannot improve by reordering an unchanged pool.

The harness checks labeled/retrieved files against normalized snapshot hashes
and holds a snapshot read lease. Two preflight attempts stopped before Jev:
first a harness raw-vs-normalized hash mismatch, then a genuinely stale indexed
hash for `src/cli/commands/uninstall.ts`. After correcting the harness and doing
`npm run start -- index --full`, the comparison passed. The stale incremental
state's root cause was not investigated in this experiment. Labels and scoring
were unchanged; no production code was modified.

## Whole-sample quality

| Domain | Queries | Top-1 baseline → Jev | Top-3 baseline → Jev | MRR baseline → Jev | nDCG@10 baseline → Jev | Candidate recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Code | 16 | 62.50% → 50.00% | 68.75% → 81.25% | 0.6757 → 0.6563 | 0.7049 → 0.6972 | 81.25% |
| Documents | 8 | 75.00% → 50.00% | 100% → 100% | 0.8542 → 0.7500 | 0.8914 → 0.8155 | 100% |

## Descriptive error subsets

These subsets are selected by baseline outcomes and **must not be presented as
unbiased overall improvements**.

| Subset | Code | Documents |
| --- | --- | --- |
| Baseline Top-1 errors | 6; Jev fixes 2 | 2; Jev fixes 1 |
| Recoverable errors: labeled file in candidates | 3; Jev fixes 2, all 3 reach Top-3 | 2; Jev fixes 1 |
| Initially correct Top-1 | 10; Jev retains 6 | 6; Jev retains 3 |
| No labeled file among candidates | 3; none recoverable by reranking | 0 |

- `code-01`, `code-02`, `code-05`: the labeled `src/engine/searcher.ts` is absent
  from the top-20 chunks. Investigate candidate retrieval before adding a reranker.
- `code-09`: `src/knowledge/context.ts` moves from file rank 9 to 2.
- `code-15`: the labeled search unit tests move from rank 5 to 1;
  `code-16`: an expected freshness/lock test moves from rank 2 to 1.
- `code-03`, `code-06`, `code-07`, `code-10`: labeled owners fall from rank 1
  to 2, displaced respectively by document search, CLI search, audit, and
  document search implementations. Exact-symbol/path guards stay first.
- `doc-01`: the concurrency spec moves from rank 3 to 2; `doc-04`: the
  knowledge-maintenance spec moves from rank 2 to 1.
- `doc-05`, `doc-06`, `doc-07`: README displaces the labeled spec from rank 1
  to 2. **At least `doc-06` is a label-coverage problem rather than a clear
  semantic regression:** the submitted README excerpt directly contains the
  Node range, unpinned development runtime, and native-addon rebuild instruction.
  The other README excerpts also contain relevant supporting information.
  Frozen labels were not retroactively expanded to improve either arm's score.

## Content-budget limitation

The unchanged experiment policy allows at most 2,000 UTF-8 bytes per candidate,
18,000 content bytes total, with further halving to fit a 30,000-byte serialized
request. In this run, the actual code budget fell to **450 bytes per chunk**;
306 of 320 code inputs were truncated. Document inputs allowed 1,125 bytes;
33 of 128 were truncated.

Several code inputs therefore showed constructors, declarations, or option
lists rather than the answering branch. For example, `code-03`'s expected
`UnifiedSearchEngine` excerpt stops inside its constructor. This is a plausible
contributor, not a measured causal explanation: no larger-budget ablation was
run. Document search supplies one best range rather than the entire document;
even untruncated ranges can omit other relevant sections. Sparse file labels
also penalize useful alternatives (including the baseline's alternate test
files). These limitations prevent treating the metric changes as seven proven
answer-quality regressions.

## Latency and cost

| Domain | Baseline p50 / p95 | Added Jev p50 / p95 | With Jev p50 / p95 | Rerank cost | Projection / 100k queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| Code | 313 / 402 ms | 409 / 1027 ms | 715 / 1364 ms | $0.004495764 | $28.10 |
| Documents | 294 / 357 ms | 410 / 720 ms | 712 / 1014 ms | $0.001924944 | $24.06 |

Completed reranking cost: **$0.006420708**, 152,874 input tokens. This excludes
embedding/indexing/classification costs, including corpus preparation. The two
failed preflights made no Jev reranking calls. Projections apply only to the
observed candidate and payload distribution. Timings are one sequential pass,
include cold/warm effects, and are not production latency estimates or confidence
intervals; the eight-document p95 is particularly unstable.

## Evidence, verification, and reproduction

Local generated evidence (ignored, not portable tracked fixtures):

- `.indexer-cli/evals/jev-rerank/repository-1790881895448-baseline.json`
- `.indexer-cli/evals/jev-rerank/code-repository-1790881910273.json`
- `.indexer-cli/evals/jev-rerank/knowledge-repository-1790881914072.json`
- `.pi/artifacts/jev-repository-index-full-1790881705.log`
- `.pi/artifacts/jev-repository-live-v3-1790881894.log`

Verification: the live repository eval passed (1 test, 24 successful calls);
45 targeted unit tests passed, with the opt-in repository eval skipped in that
unit run. Strict Node16 TypeScript checking passed for all five touched eval/
helper/unit files. Passing the live test establishes completion, not superiority.

The harness is `tests/evals/jev-rerank-repository.eval.test.ts`; shared request,
metrics, fallback, and subset coverage live in `tests/evals/jev-rerank.ts` and
`tests/unit/evals/jev-rerank.test.ts`. See the
[ranking contract](../specs/code-search-ranking.md) for the full eval protocol.
The harness requires an existing, source-consistent completed index and rejects
one containing this report. To rerun, prepare a corpus excluding this report
and any answer-bearing analysis; do not blindly index the result back into its
own benchmark. A changed corpus/model is a new run, not exact reproduction.

## Next decision gate

Before a production change, independently adjudicate all plausible relevant
files, collect broader real user queries, and separate development from a new
untouched evaluation set. On development data, test query-focused/larger content
budgets and candidate recall separately. Only then evaluate any selective rerank
policy with whole-sample quality, latency, and cost; selecting baseline errors
after seeing their labels is not a deployable routing policy.
