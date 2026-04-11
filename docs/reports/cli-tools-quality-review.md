# CLI Tools Quality Review — Token Efficiency for Model Onboarding

**Date:** 2026-04-11  
**Project:** indexer-cli (255 files, 1122 chunks)  
**Goal:** Minimize token spend during model onboarding — fast, useful context for task resolution

---

## Token Efficiency Ranking (best → worst for onboarding)

| # | Command | ~chars | ~tokens | Rating |
|---|---------|--------|---------|--------|
| 1 | `explain <symbol>` | ~300 | ~80 | ⭐⭐⭐⭐⭐ Ultra-focused, answers "what is X" |
| 2 | `architecture` | ~500 | ~140 | ⭐⭐⭐⭐⭐ Big picture: entry points, cycles, graph |
| 3 | `deps <path>` | ~500 | ~140 | ⭐⭐⭐⭐ Focus on impact radius of one module |
| 4 | `search` (JSON, no content) | ~300 | ~80 | ⭐⭐⭐⭐ Locations + score, no code dump |
| 5 | `structure --kind --path-prefix` | ~500 | ~140 | ⭐⭐⭐⭐ Good with filters, useless without them |
| 6 | `context --scope relevant-to:<path>` | ~15k | ~3800 | ⭐⭐ Useful but too much for onboarding |
| 7 | `search --txt` | ~5k+ | ~1300+ | ⭐⭐ Dumps full chunk code |
| 8 | `context --scope all` | ~22k | ~5500 | ⭐ Leviathan — almost the entire symbol tree |
| 9 | `structure` (no filters) | ~10k+ | ~2500+ | ⭐ Too much for initial onboarding |

---

## Detailed Breakdown by Command

### 1. `search` — Good (in JSON mode)

| Aspect | Verdict |
|--------|---------|
| Search quality | **Good** — query "embedding provider for vector search" found `VectorSearchResult`, `SearchEngine`, `SqliteVecVectorStore` — all relevant |
| JSON mode (default) | **Excellent** — only `filePath`, `startLine`, `endLine`, `score`, `primarySymbol`. ~80 tokens for 3 results |
| `--txt` mode | **Problem** — dumps full chunk code (100+ lines). For an agent this is ~1300+ tokens per query |
| `--fields` | **Excellent** — `--fields filePath,score,primarySymbol` gives ultra-compact answer (~60 tokens) |
| `--path-prefix` | Works correctly, narrows search |

**Example outputs:**

JSON (default):
```json
[
  { "filePath": "src/engine/indexer.ts", "startLine": 761, "endLine": 844, "score": 0.51, "primarySymbol": "snapshot" },
  { "filePath": "src/cli/commands/ensure-indexed.ts", "startLine": 137, "endLine": 239, "score": 0.51, "primarySymbol": "ensureIndexed" },
  { "filePath": "src/cli/commands/index.ts", "startLine": 316, "endLine": 382, "score": 0.50, "primarySymbol": "mode" }
]
```

With custom fields (`--fields filePath,score,primarySymbol`):
```json
[
  { "filePath": "src/engine/dependency-resolver.ts", "score": 0.55, "primarySymbol": "resolvePythonDependency" },
  { "filePath": "src/engine/dependency-resolver.ts", "score": 0.54, "primarySymbol": "resolveDependency" }
]
```

**Recommendation:** JSON mode by default is the right choice. `--txt` should only be used when a human needs to read the code.

---

### 2. `structure` — Good only with filters

| Aspect | Verdict |
|--------|---------|
| Without filters | **Problem** — 300+ lines, all symbols from all files. For onboarding 2500+ tokens is too expensive |
| `--kind class --path-prefix src/engine/` | **Excellent** — 4 classes, ~140 tokens. Ideal for "what are the main classes in this module" |
| Hierarchy | Accurate and well-organized |

**Example (with filters):**
```
src/
  engine/
    architecture.ts
      ArchitectureGenerator (class, exported)
    git.ts
      SimpleGitOperations (class, exported)
    indexer.ts
      IndexerEngine (class, exported)
    searcher.ts
      SearchEngine (class, exported)
```

**Recommendation:** In skill files for agents, explicitly state: "always use `--kind` and `--path-prefix`, without them the result is too large".

---

### 3. `architecture` — Best "first command"

| Aspect | Verdict |
|--------|---------|
| Compactness | **Excellent** — ~500 chars, ~140 tokens. Full project architecture |
| Completeness | Entry points, module dependency graph, external dependencies, cycles |
| Cycles | Detected `src/cli <-> src/core` and `src/core <-> src/storage` — valuable information |

**Example output:**
```
File stats by language
  typescript: 97
Entrypoints
  src/index.ts
  src/chunking/index.ts
  src/cli/commands/index.ts
Module dependency graph
  src/cli -> src/core, src/embedding, src/engine, src/storage, src/utils
  src/core -> src/cli, src/storage
  src/embedding -> src/core
  src/engine -> src/chunking, src/core, src/languages, src/utils
  src/storage -> src/core
  src/utils -> src/core
  tests/cli -> src/core, src/storage, tests/helpers
  tests/plugins -> src/languages, tests/helpers
  tests/unit -> src/chunking, src/cli, src/core, src/embedding, src/engine, src/languages, src/storage, src/utils

⚠ Cyclic dependencies detected:
  src/cli <-> src/core
  src/core <-> src/storage
External dependencies summary
  better-sqlite3: 2 files
  commander: 1 file
  ...
```

**Recommendation:** This should be the **first command** in any onboarding flow. For 140 tokens the agent understands the project structure.

---

### 4. `context` — Powerful but needs granularity levels

| Aspect | Verdict |
|--------|---------|
| `--scope all` | **Problem** — 22k chars, ~5500 tokens. Dumps almost all project symbols. For onboarding — overload |
| `--scope relevant-to:src/engine/indexer.ts` | **Better** — ~15k chars, ~3800 tokens. But still too much — full signatures of all symbols in relevant modules |
| `--scope changed` | **Excellent** — ~56 tokens when there are no changes |
| Token estimation | Nice feature — shows `Estimated tokens: 3823` at the end |

**Recommendation:** Need a `--density summary` (or `--compact`) mode that outputs only:
- List of modules/files without symbols
- Dependency graph (already present)
- Symbol count per module

Currently `context` is "all or nothing". There's no intermediate level between `architecture` (~140 tokens) and `context --scope all` (~5500 tokens).

---

### 5. `explain` — Best tool for pinpoint understanding

| Aspect | Verdict |
|--------|---------|
| Compactness | **Superb** — ~300 chars, ~80 tokens |
| Completeness | File, lines, kind, signature, callers (4), callees (2) |
| Accuracy | Found `OllamaEmbeddingProvider` instantly, all connections correct |

**Example output:**
```
Symbol: OllamaEmbeddingProvider
File:   src/embedding/ollama.ts (lines 7-320)
Kind:   class (exported)
Signature: export class OllamaEmbeddingProvider implements EmbeddingProvider {

Callers (4):
  src/cli/commands/ensure-indexed.ts
  src/cli/commands/index.ts
  src/cli/commands/search.ts
  tests/unit/embedding/ollama.test.ts

Callees (2):
  src/core/logger.ts
  src/core/types.ts
```

**Recommendation:** This is the **ideal** tool for onboarding. Agent sees an unfamiliar symbol → `explain <symbol>` → in 80 tokens understands what it is, who uses it, what it depends on.

---

### 6. `deps` — Good, focused

| Aspect | Verdict |
|--------|---------|
| Basic call | **Good** — callers (3) + callees (15), ~500 chars |
| `--direction callers --depth 2` | Works correctly, 17 callers for `sqlite.ts` |
| Focus | Clearly shows change impact radius |

**Example output:**
```
Module: src/storage/sqlite.ts

Callers (17):
  src/cli/commands/architecture.ts
  src/cli/commands/context.ts
  src/cli/commands/deps.ts
  src/cli/commands/ensure-indexed.ts
  src/cli/commands/explain.ts
  src/cli/commands/index.ts
  src/cli/commands/init.ts
  src/cli/commands/search.ts
  src/cli/commands/structure.ts
  src/cli/entry.ts
  src/core/lock.ts
  src/core/version-check.ts
  tests/cli/commands-gdscript.test.ts
  tests/cli/commands-python.test.ts
  tests/cli/commands-ruby.test.ts
  tests/unit/core/lock.test.ts
  tests/unit/storage/sqlite.test.ts
```

---

## General Issues

### 1. Auto-index noise on every call
Every command triggers incremental indexing and outputs:
```
Indexing (incremental)...
Index updated.
  Snapshot: ...
  Files indexed: 255
  Chunks created: 1122
  Time elapsed: 0.85s
```
This is ~100 tokens of noise per call. For an agent — garbage.

**→ Need a `--quiet` flag** that suppresses indexing progress and shows only the command result.

### 2. Lock contention with parallel calls
When launching multiple commands simultaneously, one gets:
```
Skipping auto-index: another process holds the lock.
```
This is normal behavior, but an agent might interpret it as an error.

### 3. `context` vs `architecture` — duplication
`context --scope all` includes all information from `architecture` + all symbols. No reason to run both.

---

## Optimal Onboarding Flow (for a model)

```
Step 1: architecture              → 140 tokens → big picture
Step 2: deps <key-file>           → 140 tokens → impact radius
Step 3: explain <target-symbol>   →  80 tokens → precise understanding
Step 4: search "query" (JSON)     →  80 tokens → locate relevant code
```

**Total: ~440 tokens** for full onboarding vs 5000+ with blind file reading.

---

## Improvement Recommendations

| Priority | Recommendation | Impact |
|----------|---------------|--------|
| 🔴 High | `--quiet` flag for all commands — removes indexing progress noise. Critical for agents. | -100 tokens per call |
| 🔴 High | `context --density compact` — mode without symbols, only modules + graph + statistics. ~500 tokens instead of 5500. | -5000 tokens |
| 🟡 Medium | `structure` in skill files — explicitly state: "use `--kind` + `--path-prefix`, without them result is too large". | Better agent behavior |
| 🟡 Medium | `search --txt` — consider `--max-content-lines 20` or similar limit to avoid dumping 100+ lines of code. | -1000+ tokens |
| 🟢 Low | `explain` — add `--include-content` option. Currently only signature. Sometimes function code is needed, but not always. | Flexibility |
