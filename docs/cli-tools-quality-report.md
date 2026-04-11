# Quality Report: indexer-cli Discovery Tools

**Project:** indexer-cli v0.3.9  
**Date:** 2026-04-11  
**Methodology:** 20+ runs of each CLI tool against the indexer-cli codebase itself, testing default output, JSON mode,
filters, edge cases, and error handling.

---

## Summary

| Tool           | Score      | Main Issue                                                    |
|----------------|------------|---------------------------------------------------------------|
| `structure`    | **9/10**   | Files without symbols not annotated                           |
| `context`      | **8.5/10** | Minimal issues                                                |
| `architecture` | **8/10**   | External dependency metric is uninformative                   |
| `deps`         | **7.5/10** | No error on non-existent file paths                           |
| `explain`      | **7/10**   | Symbol signature not shown despite README promise             |
| `search`       | **5/10**   | Low precision, import-section noise, path-prefix filter fails |

---

## 1. `search` — Score: 5/10

### What works

| Feature             | Status                             |
|---------------------|------------------------------------|
| JSON / txt formats  | Correct output in both modes       |
| `--fields`          | Filters fields accurately          |
| `--max-files`       | Limits result count correctly      |
| `--min-score`       | Filters by threshold correctly     |
| `--include-content` | Includes chunk content as expected |

### Critical issues

#### 1.1 Low precision — import sections ranked alongside implementations

Query: `"embedding vector generation"`

| Result                                                                | Relevant? | Reason                                                       |
|-----------------------------------------------------------------------|-----------|--------------------------------------------------------------|
| `src/core/types.ts:120-147` (VectorSearchFilters / EmbeddingProvider) | **Yes**   | Contains actual embedding interfaces                         |
| `src/cli/commands/init.ts:1-50` (HOOK_MARKER_START)                   | **No**    | Only imports embedding-related modules; no implementation    |
| `src/cli/commands/search.ts:1-54` (SEARCH_FIELDS)                     | **No**    | Import block only; contains `OllamaEmbeddingProvider` import |

The import/preamble chunks get the same score range (0.45–0.47) as relevant implementation chunks. There is no weighting
penalty for non-implementation chunk types.

#### 1.2 Cannot find file by its own class name

Query: `"AdaptiveChunker"`

Returns `src/core/types.ts` (VectorSearchFilters) instead of `src/chunking/adaptive.ts` where the class is actually
defined. The semantic embedding does not surface the file that contains the exact symbol.

#### 1.3 `--path-prefix` filter returns empty for relevant queries

Query: `"chunking strategy" --path-prefix src/chunking` → `No results found`

The chunking logic lives in `src/chunking/`, yet semantic search returns nothing when the filter is applied. This
suggests either:

- The embedding model does not associate "chunking strategy" with the adaptive/function/module chunker code, or
- The path-prefix filter narrows the candidate set too aggressively before ranking.

#### 1.4 Systematically returns import blocks instead of implementations

Queries like "how does adaptive chunking work" or "incremental indexing snapshot" consistently return lines 1–50 of
files (import sections) rather than the actual function bodies. The `imports` and `preamble` chunk types should be
deprioritized for semantic queries that ask "how does X work."

#### 1.5 Score compression

All results cluster in a narrow range of 0.45–0.52. There is no meaningful separation between good and bad results,
making it impossible to use score as a quality signal.

### Recommendations

1. **Penalize import/preamble chunks** — Lower the ranking weight for `chunkType = "imports"` and `"preamble"` when the
   query is semantic (not structural). Alternatively, exclude them by default and add `--include-imports` to opt in.
2. **Boost symbol-name matches** — If the query text matches an indexed `primarySymbol`, boost that chunk's score.
3. **Investigate path-prefix filter interaction** — Test with more projects to determine whether the filter is applied
   pre- or post-ranking.
4. **Score normalization** — Investigate whether cosine distance can be rescaled to produce a wider spread in the 0–1
   range.

---

## 2. `structure` — Score: 9/10

### What works

| Feature           | Status                                                |
|-------------------|-------------------------------------------------------|
| File tree         | Complete, correct, alphabetically sorted              |
| Symbol extraction | All functions, classes, methods, signals found        |
| Kind annotation   | `class`, `function`, `method`, `signal` — all correct |
| Export tracking   | `(exported)` tag present and accurate                 |
| `--path-prefix`   | Narrows tree correctly                                |
| `--kind class`    | Filters to only class symbols                         |
| `--txt` format    | Human-readable, compact                               |
| JSON format       | Structured with `children`, `type`, `size` fields     |

### Minor issues

- Files with no extracted symbols show an empty line beneath the filename. Adding `(no symbols)` would make the output
  clearer.
- No `--kind function` and `--kind method` distinction for some languages (e.g., Python where all are `function`).

---

## 3. `architecture` — Score: 8/10

### What works

| Feature                 | Status                                    |
|-------------------------|-------------------------------------------|
| File stats by language  | Correct counts                            |
| Entry point detection   | Accurate (found `src/index.ts`, etc.)     |
| Module dependency graph | Correct and complete                      |
| External dependencies   | Lists all npm packages with module counts |
| Unresolved dependencies | Found 3 genuine unresolved paths          |
| JSON output             | Valid, well-structured                    |
| `--txt` format          | Clean text summary                        |

### Issues

#### 3.1 External dependency count is per-file, not per-package

```
External dependencies summary
  better-sqlite3: 1
  commander: 1
  sqlite-vec: 1
  ...
  typescript: 2
  vitest: 2
```

The numbers represent how many files import each package, not how many import sites exist. This is misleading —
`typescript: 2` means 2 files import it, not 2 import statements. The metric is hard to act on.

#### 3.2 Cyclic dependency shown without warning

```
src/cli -> src/core
src/core -> src/cli
```

This is a real cycle, but there is no warning or highlighting. A cyclic dependency is an architectural issue that should
be flagged.

### Recommendations

- Change the external dependency metric to show total import count or just list packages without counts.
- Add a `⚠ Cyclic dependency detected: src/cli <-> src/core` warning when cycles are found.

---

## 4. `context` — Score: 8.5/10

### What works

| Feature                      | Status                                          |
|------------------------------|-------------------------------------------------|
| `--scope all`                | Full project overview                           |
| `--scope relevant-to:<path>` | Filters to relevant modules                     |
| `--scope changed`            | Reserved for uncommitted changes                |
| Token estimation             | Useful for agents (~1400 tokens)                |
| Section ordering             | Architecture → Modules → Symbols → Dependencies |
| `--txt` format               | Markdown-like, readable                         |

### Minor issues

- The `--max-deps` default of 30 is reasonable but not exposed clearly in `--txt` output (no indication that
  dependencies were truncated).
- No explicit mention of which dependency edges were omitted when the limit is hit.

---

## 5. `explain` — Score: 7/10

### What works

| Feature             | Status                                    |
|---------------------|-------------------------------------------|
| Symbol location     | File path + line range + kind             |
| Callers             | Accurate (verified against codebase)      |
| Callees             | Accurate                                  |
| Non-existent symbol | Returns `"Symbol not found"` correctly    |
| `--txt` format      | Clean, one-line summary per caller/callee |

### Critical issue: No symbol signature

The README states the tool shows "signature, callers, and containing module," but **no signature is displayed**.

Example for `indexProject`:

```
Symbol: indexProject
File:   src/engine/indexer.ts (lines 743-850)
Kind:   method

Callers (3):
  src/cli/commands/ensure-indexed.ts
  src/cli/commands/index.ts
  tests/unit/engine/indexer.test.ts
```

Missing: the actual method signature, e.g.:

```
Signature: async indexProject(projectRoot: string, options?: IndexOptions): Promise<IndexResult>
```

For `AdaptiveChunker`, the class is shown without its constructor or any method signatures.

This forces the user to open the file manually, defeating the purpose of the tool.

### Recommendations

- Extract and display the symbol signature from the indexed code. For classes, show the constructor. For
  functions/methods, show the full parameter list and return type.

---

## 6. `deps` — Score: 7.5/10

### What works

| Feature        | Status                                         |
|----------------|------------------------------------------------|
| Callers        | Accurate, complete list                        |
| Callees        | Accurate, complete list                        |
| `--direction`  | Filters correctly (`callers`/`callees`/`both`) |
| `--depth 2`    | Expands dependency graph correctly             |
| `--txt` format | Clean output                                   |

### Critical issue: Silent on non-existent paths

```
$ indexer-cli deps nonexistent-file.ts --txt
Module: nonexistent-file.ts
Callers: none
Callees: none
```

No error, no warning. This is misleading — the user has no indication that the file does not exist in the index. Compare
with `explain` which correctly returns `"Symbol not found"`.

### Recommendations

- Validate the input path against the index. If no file or module matches, print an error:
  `Error: Module "nonexistent-file.ts" not found in index. Run "indexer-cli index" to update.`

---

## Top 3 Priority Fixes

| Priority | Tool      | Fix                                                                                    |
|----------|-----------|----------------------------------------------------------------------------------------|
| **P0**   | `search`  | Penalize `imports`/`preamble` chunk types in ranking — they dominate results currently |
| **P1**   | `deps`    | Validate input path against index; error on non-existent files                         |
| **P1**   | `explain` | Display the symbol signature (function params, return type, class constructor)         |

---

## Additional Observations

### Error handling across tools

| Scenario                 | `search`     | `structure`  | `architecture` | `context`    | `explain` | `deps`     |
|--------------------------|--------------|--------------|----------------|--------------|-----------|------------|
| Non-existent input       | N/A          | N/A          | N/A            | N/A          | **Error** | **Silent** |
| Invalid `--fields` value | **Error**    | N/A          | N/A            | N/A          | N/A       | N/A        |
| Invalid `--kind` value   | N/A          | Empty result | N/A            | N/A          | N/A       | N/A        |
| Invalid `--path-prefix`  | Empty result | Empty result | Empty result   | Empty result | N/A       | N/A        |

Error handling is inconsistent across tools. A unified error reporting standard would improve usability.

### Output format consistency

All tools support `--txt` and JSON output. JSON output is valid and well-structured across the board. The `--txt` format
is clean and human-readable in all cases. This is well done.

### Performance

All commands completed within 1–3 seconds on a project with 82 TypeScript files. Auto-reindexing (when the index is
stale) adds ~5 seconds. This is acceptable for interactive use.
