# Knowledge-quality evaluation

Implementation and fixture: `tests/evals/knowledge-quality.eval.test.ts`,
`evals/knowledge/quality-scenarios.json`.

`RUN_KNOWLEDGE_QUALITY_EVAL=1 npx vitest run tests/evals/knowledge-quality.eval.test.ts` runs an opt-in, local SQLite/filesystem regression harness. It makes no network or LLM calls.

The fixture has six declared drift cases: changed primary document, changed tracked input, changed relation map, removed/moved source, an old unattested baseline, and a verification attempt rejected for missing evidence (with tests not run stated as a limitation). **False-fresh rate** is `declared drift cases reported fresh / declared drift cases`; the expected result is `0/6`.

Whole-file input hashing also has one unrelated-comment control. Its `inputs-changed` result is counted as **review noise**, separately from semantic false-fresh: conservative whole-file invalidation does not prove a semantic change.

The fixture also records and independently verifies two deliberately contradictory active settlement contracts. Lexical retrieval may surface both eligible contracts; it does not mark either superseded, resolve the disagreement, or produce a semantic-proof claim (`semanticScore` remains zero in lexical mode). This is a deterministic regression boundary, not contradiction detection.

Lexical retrieval uses three positive truth queries and two negative queries. Precision and recall are `top-1 correct / positive queries`; negative abstention is `empty results / negative queries`. The test reports index/query wall time and approximate formatted-context tokens, and asserts the deterministic expected counts. It also checks that an untracked imported helper is surfaced by impact with an `untracked-dependency` reason while remaining uncovered and without changing the primary freshness claim.

The fake embeddings only make indexing deterministic; retrieval is explicitly lexical. These results do not calibrate production semantic or multilingual thresholds.
