---
kind: archive
status: historical
---

# Jev reranking exploratory A/B — 2026-10-01

> Archive note: the experimental code, tests, and npm scripts were subsequently
> removed at the user's request. Commands below describe the historical run and
> are no longer available. Results and local evidence references are preserved.

## Result

Do not enable Jev reranking by default on this evidence. The existing ordering
already achieved perfect file-level metrics on this small development fixture
set. Jev introduced one code regression and no measured improvements. This
does not establish that Jev is generally worse: a harder, independently labeled
holdout is needed before tuning the prompt or making a production decision.

## Method

- Command: `npm run eval:rerank:jev`.
- Requested model: `typesafe/jev-1.13`; returned build:
  `typesafe/jev-1.13-20260917`.
- Local embeddings: `jina-8k` for code, `nomic-embed-text-v2-moe` for documents.
- 13 existing code queries (10 hybrid, 2 lexical, 1 symbol), 26 hybrid document
  queries. One sequential Jev call per query, no retries; zero rerank failures.
- Each pair uses the same fresh top-20 retrieval, `minScore: 0`, and hydrated
  content. Code returns up to 20 chunks; documents returned 12 files per query.
  File labels collapse repeated chunks to their first rank. This baseline is
  not the legacy top-5 eval or default CLI latency.
- Content is truncated to the experiment's byte budget. Labels are not sent.
  Binary nDCG uses existing expected file labels, not graded human judgments.
- Latency is a single pass including cold/warm effects, without statistical
  confidence intervals. These are development fixtures, not a held-out benchmark.

## Quality

| Domain | Queries | Top-1 baseline → Jev | MRR baseline → Jev | nDCG@10 baseline → Jev |
| --- | ---: | ---: | ---: | ---: |
| Code | 13 | 100% → 92.31% | 1.000 → 0.962 | 1.000 → 0.972 |
| Documents | 26 | 100% → 100% | 1.000 → 1.000 | 1.000 → 1.000 |

Top-3 and candidate Recall@20 remained 100% for both domains. Recall is unchanged
by reordering. On the 10 hybrid code cases alone, Top-1 fell from 100% to 90%.

The regression is `explicit-test-intent`: query `HybridNeedleIndex test fixture`.
Jev scored `src/search/hybrid-needle.ts` 2.44 and
`tests/search/hybrid-needle.test.ts` 1.88, moving the expected test from first to
second. Neither of these two candidate contents was truncated. No prompt tuning
or selective re-run was performed after inspecting this result.

## Latency and cost

| Domain | Baseline p50 / p95 | With Jev p50 / p95 | Added attempt p50 / p95 | Rerank cost | Projection / 100k queries |
| --- | ---: | ---: | ---: | ---: | ---: |
| Code | 156 / 428 ms | 566 / 1211 ms | 381 / 783 ms | $0.003185616 | $24.50 |
| Documents | 469 / 492 ms | 798 / 855 ms | 324 / 390 ms | $0.003265878 | $12.56 |

The completed run reported **$0.006451494** for 153,607 Jev input tokens; all
39 responses provided cost. Projections apply only to this candidate/content
distribution. Embedding/indexing costs are excluded. A preliminary run was
stopped during development; any charges from that interrupted attempt could
not be established and are not included in the completed-run total.

## Evidence and checks

Local artifacts (ignored/generated, not portable tracked fixtures):

- `.indexer-cli/evals/jev-rerank/code-local-1790880703768.json`
- `.indexer-cli/evals/jev-rerank/knowledge-local-1790880687980.json`
- `.pi/artifacts/jev-live-eval-20261001-205050-94775.log`

Verification: 2 live eval tests passed, 36 targeted unit tests passed, and strict
Node16 TypeScript checking of the four touched test/helper files passed. Live
eval success means the comparison completed without request failures, not that
Jev improved quality. Production search code was not changed.

## Next experiment

Completed follow-up: [repository-grounded 24-query experiment](jev-rerank-repository-holdout.md).
The original fixture results above are preserved as measured.

Collect harder real repository queries where the baseline makes ranking errors,
plus exact-path/symbol/test-intent guards. Label before examining Jev outputs;
separate development from held-out evaluation. Keep the same retrieval pool for
each pair, assess content-budget sensitivity, and repeat latency measurements.
Only then consider an optional reranking stage.
