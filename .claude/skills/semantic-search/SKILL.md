---
name: semantic-search
description: Semantic code search and codebase discovery via indexer-cli. Use BEFORE grep/glob/find when exploring unfamiliar code, understanding architecture, finding implementations, or locating symbols. Triggers: "find where X is implemented", "how does Y work", "search for Z", "where is the function that", "show me code related to", "what files handle", codebase navigation, dependency analysis.
allowed-tools: Bash(indexer-cli:*)
---

# Semantic Code Search with indexer-cli

## When to Use

Run indexer-cli commands BEFORE falling back to grep/glob/find. Indexer understands code semantics, not just text patterns.

**Use indexer-cli when:**
- Exploring unfamiliar code or modules
- Finding where a symbol/function/class is implemented
- Understanding codebase architecture and dependencies
- Searching for code by meaning, not just exact text
- Locating entry points and module boundaries

**Skip indexer-cli when:**
- User gave an exact file path and task is strictly inside it
- Searching for a literal string you know exists (use grep)
- Task is external to this repo

## Prerequisites

Indexer must be initialized in the project (`.indexer-cli/` directory exists).
If not initialized, tell the user to run: `indexer-cli init`

## Commands

All commands MUST be run in the project root directory.

### Search (primary tool)

```bash
# Semantic search — returns ranked results with file paths, line ranges, and code snippets
indexer-cli search "<query>" --json

# Narrow to a specific directory
indexer-cli search "<query>" --json --path-prefix src/api

# Limit results
indexer-cli search "<query>" --json --top-k 5

# Filter by chunk type
indexer-cli search "<query>" --json --chunk-types impl,types
```

**Output (JSON):** Array of `{ filePath, startLine, endLine, score, primarySymbol, content }`

### Status check

```bash
indexer-cli index --status --json
```

**Output:** `{ indexed, snapshot: { id, status, createdAt, gitRef }, stats: { files, symbols, chunks, dependencies }, languages, symbolKinds }`

### Structure (file tree with symbols)

```bash
indexer-cli structure --json

# Filter by path prefix
indexer-cli structure --json --path-prefix src/engine

# Filter by symbol kind
indexer-cli structure --json --kind function
```

**Output:** Array of `{ type: "directory"|"file", name, path, symbols: [{ name, kind, exported }] }`

### Architecture snapshot

```bash
indexer-cli architecture --json
```

**Output:** `{ file_stats, entrypoints, dependency_map: { internal, external, builtin, unresolved } }`

### Re-index after code changes

```bash
indexer-cli index
```

Incremental by default — only re-indexes changed files. Run this if search results seem stale.

## Mandatory First Move

Before grep/glob/find/explore, run at least ONE indexer-cli command:
1. `indexer-cli search "<query>" --json` — for specific searches
2. `indexer-cli structure --json --path-prefix <dir>` — for understanding module layout

## Token-safe Defaults

Always use `--json` flag for machine-readable output. Always use `--path-prefix` when you know the target directory.

## Search Query Tips

- **Short and specific**: "authentication middleware", "JWT token validation", "database connection pool"
- **Use identifiers**: function names, class names, variable names work best
- **Avoid sentences**: "how do I handle errors" → "error handler", "error handling middleware"
- **2-8 keywords** is the sweet spot

## Fallback Order

If indexer results are insufficient:
1. Refine query (shorter, different keywords, add `--path-prefix`)
2. Try `indexer-cli structure --json --path-prefix <area>` to browse
3. Then fall back to grep/glob for literal text searches
