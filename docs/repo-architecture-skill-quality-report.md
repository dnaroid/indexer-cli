# Quality Report: repo-architecture Skill

**Date**: 2026-04-11
**Skill**: `repo-architecture` (`indexer-cli architecture`)
**Target repo**: `mcp-indexer` (ai-code-helper) — the skill's own project
**Command used**: `npx indexer-cli architecture --txt`

---

## Summary

The skill produced a **flat file listing** with dependency counts but failed to deliver its core promise — a meaningful module dependency graph. The output required significant manual supplementation (README, package.json, directory listing) to produce an actual architectural understanding.

**Overall grade: C-** (functional scaffolding, missing substance)

---

## Detailed Findings

### 1. Dependency Graph — FAIL

The entire `Module dependency graph` section output was:

```
Module dependency graph
  none
```

This is the skill's primary value proposition and it produced nothing. Possible causes:

- The indexer cannot index itself (circular bootstrapping issue)
- The project lacks a `.indexer` workspace or prior indexing run
- Bug in graph generation for monorepo structures with `pnpm-workspace.yaml`

**Impact**: Without the graph, the skill degrades to a formatted `ls` + dependency counter.

### 2. Entrypoints — PARTIAL

Produced 24 entry points covering all packages. However:

- No indication of which entrypoints are **primary** (CLI, daemon) vs **library exports** (`index.ts`)
- No grouping by layer or purpose
- `main.tsx` and `App.tsx` listed alongside `cli.ts` without distinction

**What was provided**: Raw list.
**What was needed**: Tiered classification (runtime entrypoints → library exports → test fixtures).

### 3. External Dependencies — ADEQUATE

Dependency counts per package were correct and useful for assessing coupling:

```
@mcp-indexer/core-interfaces: 13
@mcp-indexer/core: 11
@mcp-indexer/workspace-manager: 8
```

This correctly identified `core-interfaces` and `core` as central modules.

**Gap**: No directionality. We see `core-interfaces` is used 13 times, but not who depends on whom. No arrow-based graph or adjacency list.

### 4. Language Stats — MINIMAL

```
typescript: 221
```

Accurate but single-dimensional. Missing:

- Lines of code per language
- Test vs source file ratio
- Generated vs handwritten file distinction

### 5. Unresolved Dependencies — TRIVIAL

```
Unresolved dependencies
  services/admin-ui -> ./index.css, ./logo.png
```

Only CSS and image assets flagged. No real import resolution issues detected — either the project is clean or the resolver doesn't surface meaningful gaps.

---

## What the Skill Should Produce (Ideal Output)

For a monorepo with 22 packages, an architecture skill should return:

```
Module dependency graph (layered view)

Layer 0 - Interfaces
  core-interfaces

Layer 1 - Foundation
  config, db, storage-sqlite, vector-lancedb

Layer 2 - Domain
  core, embeddings-*, lang-*

Layer 3 - Engine
  indexer-engine, git-operations-local, workspace-manager

Layer 4 - Tools
  local-mcp-tools, mcp-tools, tool-*

Layer 5 - Runtime
  local-runtime → process-supervisor, ollama-runtime

Layer 6 - UI
  admin-local → services/admin-ui
```

Plus: actual edges between modules, coupling metrics, and cycle detection.

---

## Reproducibility Notes

- **Workspace state**: No prior `indexer init` or `indexer index` was run against the repo before invoking `architecture`
- **Indexer version**: Local development build from current working tree
- **Output format**: `--txt` (plain text). JSON output not tested.

---

## Recommendations

1. **Guard against empty graph**: If dependency graph is `none`, the skill should warn the user and suggest running `indexer index` first, rather than silently producing an empty section.

2. **Layer inference**: Even without a pre-built index, the skill could infer layers from `package.json` dependencies and `tsconfig.json` references.

3. **Entrypoint classification**: Group entrypoints by role (CLI, server, library export, UI) rather than presenting a flat list.

4. **Self-indexing**: Document whether the tool is expected to work on its own source without prior indexing, or if it requires a bootstrap step.

5. **Richness metrics**: Report what percentage of the dependency graph was resolved vs unresolved, so users can gauge output reliability.
