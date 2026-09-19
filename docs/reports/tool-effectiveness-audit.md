# Indexed-tool effectiveness audit

## Scope and method

All seven indexed agent tools were exercised on this repository: architecture,
structure, AST, search, explain, dependencies, and knowledge. Representative
results were compared with source files, including line ranges, module imports,
symbol declarations, and knowledge freshness behavior. This is a small functional
audit, not an exhaustive correctness claim or a production performance benchmark.

The warm-index timings below use the checkout CLI (`node bin/indexer-cli.js
--no-auto-update …`), one invocation per case. They include process startup and
are not interchangeable with the tool's `IDX noop ms=…` freshness-check timing.
Source edits were underway; these invocations reported `IDX noop`.

## Representative results

| Tool | Scenario | Wall time | Output bytes | Outcome |
| --- | --- | ---: | ---: | --- |
| `repo_architecture` | `architecture --path-prefix src` | 1.129 s | 2561 | Entrypoint and 73 source TypeScript files reported |
| `repo_structure` | `structure --path-prefix src --max-files 3 --max-depth 2` | 0.667 s | 294 | Three files and continuation cursor |
| `repo_ast` | `ast src/engine/searcher.ts --max-depth 2 --max-nodes 40 --no-include-text` | 0.500 s | 1190 | Bounded outline and continuation cursor |
| `repo_search` | Six behavior queries below | 0.741–0.997 s | 445–514 | Expected implementation in top three for all six |
| `repo_explain` | `explain SearchEngine --path-prefix src --signature-only` | 0.505 s | 147 | Correct class, file, and range |
| `repo_deps` | `deps src/engine/searcher.ts --depth 1` | 0.490 s | 496 | Eight importers and two imports |
| `repo_knowledge` | `context "knowledge freshness and implementation" --path-prefix src --max-code 3 --max-specs 2 --max-tests 1 --budget 500` | 1.311 s | 1663 | Primary knowledge, implementation, test hints |

Search used `--path-prefix src --max-files 3 --dedupe-file`, with default hybrid
ranking. Expected files were independently checked against implementation.

| Query | Expected implementation | Rank |
| --- | --- | ---: |
| automatically refresh index when files change | `src/engine/indexer.ts` | 2 |
| scan files respecting gitignore patterns | `src/engine/scanner.ts` | 2 |
| combine semantic and lexical ranking scores | `src/engine/searcher.ts` | 2 |
| detect stale knowledge documents freshness | `src/knowledge/service.ts` | 3 |
| resolve imported module dependency paths | `src/engine/dependency-resolver.ts` | 1 |
| estimate tokens for context budget | `src/utils/token-estimator.ts` | 2 |

Hit@3 was **6/6** on this intentionally small sample. This does not measure
precision of every returned chunk or generalize to other repositories. A separate
query about multiline signature extraction returned chunking/structure code,
requiring narrower follow-up; natural-language retrieval is not infallible.

## Confirmed defects addressed

1. `explain src/cli/commands/ensure-indexed.ts::ensureIndexed --signature-only`
   returned only `export async function ensureIndexed(`. Function/method
   extraction now retains the complete AST-delimited declaration without the
   executable body. Explain also repairs matching legacy truncated or body-containing signatures
   from current TS/JS source at display time. See
   [symbol signature contract](../specs/symbol-signatures.md).
2. `deps src/engine/indexer.ts --mode calls --direction callees --show-edges`
   attributed `this.normalizePath()` calls to unrelated declarations in
   `architecture.ts`, `dependency-resolver.ts`, and other imported modules.
   Receiver-aware resolution retains same-class calls and suppresses these
   false edges. See the [call-graph contract](../specs/call-graph-deps.md).

## Remaining limitations

- Scoped architecture graphs omit cross-boundary module dependencies. For
  example, `--path-prefix src/knowledge` can show an empty module edge despite
  imports into other source directories. Use `deps` for boundary analysis.
- An unknown `--path-prefix` can fall back to the entire repository with an
  explicit warning. Inspect warnings rather than treating the result as scoped.
- Call graphs are static approximations, not runtime traces. Unknown receivers,
  dynamic dispatch, and other languages retain limitations described in their
  implementation/contracts.
- Knowledge inspection found existing unverified knowledge and unclassified
  candidates. They were not indiscriminately marked verified or authoritative.
- The installed global `idx` is separate from the checkout build. Local fixes do
  not update that installation automatically.
- The pre-existing worktree deletion of `CLAUDE.md` was left untouched.

## Verification

Baseline: `npm test` passed 562 tests across 50 files; `npx tsc --noEmit` passed.
Final combined verification passed **609 tests across 53 files**:

```sh
npm run build
INDEXER_CLI_TEST_USE_DIST=1 npx vitest run tests/cli/deps-call-graph.test.ts tests/unit/ tests/plugins/typescript.test.ts
```

The built checkout CLI also passed two real-project smoke assertions: complete
`ensureIndexed` signature and only the appropriate `IndexerEngine.normalizePath`
target among the previously false `normalizePath` edges. Final test log:
`/tmp/indexer-final-shadowing.BWLd84`; smoke outputs:
`/tmp/indexer-final-smoke.iwb33O/`. Temporary logs are local evidence, not durable
project dependencies.

Independent review requested additional regressions/fixes for lexical
receiver scope, reassignment, object-literal `this`, and legacy one-line signature
body leakage, followed by a static-class fallback regression for shadowed names.
All received fixes and passing regression coverage.
The final independent review approved the changes with no remaining blocker;
its direct/imported static receiver smoke check also passed both expected edges.
The broad `tests/cli/commands.test.ts` run was interrupted before completion;
it is **incomplete**, not passing. Dedicated regression coverage and the unit
suite are the verification scope for this audit.
