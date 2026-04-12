# CLI Tools Quality Check — indexer-cli self-test

**Date**: 2026-04-12
**Project**: indexer-cli v0.7.1
**Method**: All 6 CLI commands run against the project's own codebase (`src/`)

---

## 1. `search` — 🟢 Good (with caveats)

**Test**: `"semantic search implementation" --max-files 5 --include-content`

| Criterion            | Result                                                                   |
| -------------------- | ------------------------------------------------------------------------ |
| Relevance            | ✅ SearchEngine, registerSearchCommand — accurate hits                   |
| Output format        | ✅ `file:lines (score, symbol)` — compact                                |
| `--include-content`  | ✅ Works correctly                                                       |
| Two-phase model      | ✅ Without `--include-content`: 2 lines per result; with it: full source |

### Issues

- ⚠️ **Weak score differentiation**: 0.52–0.53 across all 5 results. `SearchEngine` and `SKILL_DEFINITIONS` share the same score (0.53), even though the former is the core search engine and the latter is generated skill text (noise).
- ⚠️ **SKILL_DEFINITIONS as noise**: Because skills are embedded directly in `src/cli/commands/skills.ts`, semantic search matches this file for any query overlapping with skill descriptions. This is systematic result pollution.
- ⚠️ **"adaptive chunking" test** returned only 2 results (AdaptiveChunker + SingleFileChunker) — missing `ModuleLevelChunker` and `FunctionLevelChunker`. Normal for vector search, but reveals completeness limitations.

### SKILL.md ↔ CLI consistency

All documented options (`--max-files`, `--path-prefix`, `--chunk-types`, `--min-score`, `--include-content`) work as described. ✅

---

## 2. `structure` — 🟢 Excellent

**Test**: `--path-prefix src --max-depth 3` and `--path-prefix src/engine --kind class`

| Criterion            | Result                                              |
| -------------------- | --------------------------------------------------- |
| Tree with symbols    | ✅ Files + exported symbols + kind                  |
| `--path-prefix`      | ✅ Filters output accurately                        |
| `--kind class`       | ✅ Shows only classes                               |
| `--max-depth`        | ✅ Truncates tree correctly                         |
| Token efficiency     | ✅ "(no exported symbols)" instead of empty lines    |

### Issues

- ⚠️ Directories with many children show `... (12 children)` — fine for token savings, but agents might need `--max-files` to see full listing.

### SKILL.md ↔ CLI consistency

Fully consistent. Options `--path-prefix`, `--kind`, `--max-depth`, `--max-files` all functional. ✅

---

## 3. `architecture` — 🟢 Excellent

**Test**: no arguments (full snapshot)

| Criterion                | Result                                                         |
| ------------------------ | -------------------------------------------------------------- |
| File stats               | ✅ typescript: 95                                              |
| Entry points             | ✅ src/index.ts, src/chunking/index.ts, src/cli/commands/index.ts |
| Dependency graph         | ✅ 8 edges, readable format                                    |
| Cyclic dependencies      | ✅ Detected: `src/cli ↔ src/core`, `src/core ↔ src/storage`        |
| External dependencies    | ✅ With file counts                                            |
| Unresolved               | ✅ "none" — clean                                              |

### Issues

None found.

### SKILL.md ↔ CLI consistency

Consistent. `--path-prefix`, `--include-fixtures` described accurately. ✅

---

## 4. `context` — 🔴 Critical scope filtering bug

**Tests**: `--scope all`, `--scope relevant-to:src/engine/searcher.ts`, `--scope relevant-to:src/engine --compact`

| Criterion                    | Result                                                    |
| ---------------------------- | --------------------------------------------------------- |
| `--scope all`                | ✅ Full dump of all modules + symbols + dependency graph  |
| `--scope relevant-to:<path>` | ❌ **DOES NOT FILTER** — returns ALL modules/symbols       |
| `--compact`                  | ✅ Removes signatures, keeps `name (kind)` format          |
| `--max-deps`                 | ⚠️ Not verified (graph was short)                         |

### 🔴 Critical Issue

`--scope relevant-to:src/engine/searcher.ts` returned **all 38 modules** and **all ~100 symbols** — identical output to `--scope all`. Expected: only modules in the dependency neighborhood of `searcher.ts` (searcher → core/types, core/logger + its callers).

SKILL.md explicitly promises: *"ALWAYS pass --scope; without it the output can exceed 5000 tokens"*. But `--scope relevant-to` provides zero filtering — misleading for agents relying on compressed context.

Comparison `--scope all` vs `--scope relevant-to:src/engine/searcher.ts`:
- Modules: 38 vs 38 (identical)
- Symbols: ~100 vs ~100 (identical)
- Dependency edges: 8 vs 4 (minor difference)

### SKILL.md ↔ CLI consistency

**No.** `--scope relevant-to:<path>` is documented as "dependency neighborhood" but does not actually filter. This is the most critical discrepancy found.

---

## 5. `explain` — 🟢 Excellent

**Tests**: `searchIndex` (fuzzy), `src/engine/indexer.ts::IndexerEngine` (file::symbol syntax)

| Criterion              | Result                                                                      |
| ---------------------- | --------------------------------------------------------------------------- |
| Fuzzy match            | ✅ "searchIndex" → SearchEngine, registerSearchCommand, search, searchSymbols |
| `file::symbol` syntax  | ✅ Exact match: IndexerEngine in indexer.ts                                 |
| Callers/Callees        | ✅ Correct: IndexerEngine → 3 callers, 15 callees                           |
| Signature              | ✅ Shown                                                                    |
| ~80 tokens per symbol  | ✅ As documented                                                            |

### Issues

None found.

### SKILL.md ↔ CLI consistency

Fully consistent. `<file>::<symbol>` syntax, `--path-prefix`, `--include-fixtures` all documented and working. ✅

---

## 6. `deps` — 🟡 Partial (depth > 1 doesn't expand transitives)

**Tests**: `src/engine/searcher.ts --direction both --depth 2`, `src/engine/indexer.ts --direction callers --depth 2`

| Criterion              | Result                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| Callers depth 1        | ✅ searcher.ts → 4 callers (search.ts, entry.ts, 2 tests)               |
| Callees depth 1        | ✅ searcher.ts → 2 callees (logger.ts, types.ts)                         |
| `--direction callers`  | ✅ Works                                                                 |
| `--depth 2` output     | ⚠️ No level differentiation shown                                        |

### Issue

At `--depth 2` for `indexer.ts`, 11 callers are shown but **there is no distinction between direct and transitive imports**. It's unclear who imports `indexer.ts` directly (depth 1) vs. through an intermediate module (depth 2). This reduces the value of depth > 1.

For `searcher.ts --depth 2`, the result (4 callers, 2 callees) is identical to what depth 1 would produce. Transitive connections did not appear.

### SKILL.md ↔ CLI consistency

Partially. `--depth` is documented, but the value of depth > 1 is questionable given current behavior.

---

## Summary

| Tool          | Quality      | Agent-ready?                          |
| ------------- | ------------ | ------------------------------------- |
| `search`      | 🟢 Good      | Ready, but noise from skills.ts       |
| `structure`   | 🟢 Excellent | Ready                                 |
| `architecture`| 🟢 Excellent | Ready                                 |
| `context`     | 🔴 Broken    | `--scope relevant-to` does not filter |
| `explain`     | 🟢 Excellent | Ready                                 |
| `deps`        | 🟡 Partial   | depth > 1 doesn't show transitives    |

## Priority Fixes

1. **context `--scope relevant-to`** — critical bug, filtering is completely non-functional
2. **deps `--depth > 1`** — doesn't surface transitive dependencies or visualize depth levels
3. **search scoring** — weak differentiation (0.52–0.53 range), skill text noise

## What Works Well

- SKILL.md instructions are high-quality and accurately describe CLI behavior (except context scope)
- Output format of all commands is token-optimized
- `structure`, `architecture`, `explain` — fully functional
- Two-phase search model (discover → read) works as designed
