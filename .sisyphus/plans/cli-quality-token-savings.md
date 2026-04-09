# CLI Quality & Token Savings Improvement Plan

Date: 2026-04-09

## Context

Analysis of all indexer-cli commands revealed 3 critical and 4 important issues that reduce token savings effectiveness — the core value proposition of the tool.

## Priority 1 — Critical (breaks core value proposition)

### 1.1 `context` useless without `enrich`

**Problem:** `context` silently returns `summary: null` / `description: null` for all modules and symbols unless `enrich` was run. Agent gets empty context and wastes tokens on fallback exploration.

**Solution — two-level fallback:**
- If enrich data exists → output enriched content (current behavior)
- If no enrich data → output **raw structural context** instead of null: file list + symbols + signatures + dependency graph
- stderr warning: `"No enrichment data found. Run 'indexer-cli enrich' for descriptions and module summaries."`

**Files:** `src/cli/commands/context.ts` — `formatPlain` function + `contextData` JSON construction
**Complexity:** Medium

---

### 1.2 `search` — no compact mode

**Problem:** Agent always gets `content` for every chunk. With `--top-k 10` on a real project, that's 2000+ tokens when often only "where is this implemented?" is needed.

**Solution — `--fields` flag:**
```bash
indexer-cli search "auth" --fields filePath,primarySymbol,score
indexer-cli search "auth" --fields filePath,startLine,endLine,primarySymbol,score,content  # default
```

- `--fields` accepts comma-separated list: `filePath`, `startLine`, `endLine`, `score`, `primarySymbol`, `content`
- Default — all fields (backward compatible)
- Without `content`, output shrinks 5-10x

**Files:** `src/cli/commands/search.ts` — option parsing + field filtering in JSON/plain output
**Complexity:** Low

---

### 1.3 Entrypoints/architecture include fixtures

**Problem:** `architecture` and `context` include `fixtures/projects/godot-basic/scripts/main.gd` as an entrypoint and `CharacterBody2D`, `UnityEngine` as external dependencies. Agent wastes tokens analyzing irrelevant files.

**Solution — default exclude patterns:**
- In `indexer-cli init`, add to config:
  ```json
  { "excludePaths": ["fixtures/**", "vendor/**"] }
  ```
- `architecture` engine filters `file_stats`, `entrypoints`, `dependency_map` by exclude patterns
- External dependencies filtered by same patterns (fixture imports don't count)
- Add `--include-fixtures` flag for explicit inclusion

**Files:** `src/core/config.ts` (defaults), `src/engine/architecture.ts` (filtering), `src/cli/commands/architecture.ts`, `src/cli/commands/context.ts`
**Complexity:** Medium

---

## Priority 2 — Important (degrades UX but doesn't break value)

### 2.1 `search` — low score for relevant results

**Problem:** Score 0.52 for `SearchEngine` on query "semantic search embedding" — looks like noise despite being the correct result. Agent may filter at 0.7+ threshold and lose hits.

**Solution:**
- Investigate score normalization (min-max scaling over result batch)
- Or switch to `1 - distance` instead of raw cosine similarity
- Add `--min-score` flag for manual threshold

**Files:** `src/engine/searcher.ts`, `src/storage/vectors.ts`
**Complexity:** Medium (requires embedding model research)

---

### 2.2 `context` — dependencies sliced to 30 without warning

**Problem:** `depEntries.slice(0, 30)` silently truncates dependency graph. On large projects agent gets incomplete picture.

**Solution:**
- Remove hardcoded `slice(0, 30)`, or make configurable via `--max-deps`
- If truncated → stderr: `"Showing 30 of 47 dependencies. Use --max-deps to see more."`

**Files:** `src/cli/commands/context.ts` line 82
**Complexity:** Low

---

### 2.3 `structure` — no depth limit

**Problem:** On large projects tree goes 10+ levels deep, JSON grows to thousands of lines.

**Solution — `--max-depth` flag:**
```bash
indexer-cli structure --max-depth 3 --json
```
- Default — no limit (backward compatible)
- Directories deeper than limit shown as `... (N children)`

**Files:** `src/cli/commands/structure.ts` — `printTree` / `treeToJson` + option parsing
**Complexity:** Low

---

### 2.4 `explain` — callers/callees at file level, not symbol level

**Problem:** `explain SearchEngine` shows that `search.ts` imports `logger.ts`, not which specific functions are called. Insufficient for understanding code flow.

**Solution — symbol-level tracking:**
- During indexing, parse call expressions → store `symbolA calls symbolB` in DB
- Architectural change in `indexer` + `storage/sqlite` (new table `symbol_calls`)
- For v1, limit to TS/Python (tree-sitter supports call expressions)

**Files:** `src/engine/indexer.ts`, `src/storage/sqlite.ts` (new table), `src/languages/typescript.ts`, `src/cli/commands/explain.ts`
**Complexity:** High

---

## Priority 3 — Nice-to-have

### 3.1 `enrich` — auto-run on first `context` call
- If no enrich data and Ollama is available → prompt for auto-enrich
- Or `--auto-enrich` flag

### 3.2 `architecture` — filter unresolved dependencies
- Remove normal ESM relative imports (`../../core/types.js`) from unresolved
- Show only genuinely unresolved (no file on disk)

### 3.3 `search` — content snippets instead of full chunk
- Add `--snippet` mode: only lines around primarySymbol, not entire chunk
- Useful for large chunks (module_section, full_file)

---

## Implementation Order

| Step | Task                      | Complexity | Token Savings Impact                |
| ---- | ------------------------- | ---------- | ----------------------------------- |
| 1    | 1.2 search --fields       | Low        | 🔥 5-10x fewer tokens per search    |
| 2    | 1.1 context fallback      | Medium     | 🔥 makes context actually useful    |
| 3    | 1.3 exclude fixtures      | Medium     | ⚡ removes noise from all commands   |
| 4    | 2.2 context --max-deps    | Low        | ⚡ output size control               |
| 5    | 2.3 structure --max-depth | Low        | ⚡ output size control               |
| 6    | 2.1 search score          | Medium     | 📊 result quality                    |
| 7    | 2.4 symbol-level deps     | High       | 🚀 killer feature for v2             |
| 8    | 3.x nice-to-have          | Varies     | 📈 polish                            |

Steps 1-3 close 80% of token savings issues. Steps 4-5 are quick wins. Steps 6-7 are qualitative leaps.

## Current Command Quality Summary

| Command       | Tokens/call | Tokens saved   | ROI       | JSON Quality | Issue Severity                  |
| ------------- | ----------- | -------------- | --------- | ------------ | ------------------------------- |
| `search`      | ~300-2000   | ~2000-10000    | ⭐⭐⭐⭐  | Good         | Medium (no compact mode)        |
| `explain`     | ~50-200     | ~500-3000      | ⭐⭐⭐⭐⭐| Excellent    | Low                             |
| `deps`        | ~50-300     | ~1000-5000     | ⭐⭐⭐⭐⭐| Excellent    | Low                             |
| `context`     | ~100-500    | ~3000-20000    | ⭐⭐⭐    | Good         | **High** (useless without enrich) |
| `structure`   | ~200-2000   | ~2000-15000    | ⭐⭐⭐⭐⭐| Good         | Low                             |
| `architecture`| ~100-500    | ~1000-5000     | ⭐⭐⭐⭐  | Good         | Medium (fixture noise)          |
