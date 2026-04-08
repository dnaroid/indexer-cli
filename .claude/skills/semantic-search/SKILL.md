---
name: semantic-search
description: Semantic code search and codebase discovery via indexer-cli. Prefer it for exploratory repo navigation, architecture discovery, and semantic lookup when the exact file or literal string is unknown. Skip it for exact-file or literal-text tasks.
allowed-tools: Bash(indexer-cli:*)
---

# Semantic search via indexer-cli

Use `indexer-cli` for exploratory lookup inside this repo. It is best when you need meaning-based discovery, not exact text matching.

## Use when
- Exploring unfamiliar code or modules
- Finding where a symbol/function/class is implemented
- Understanding codebase architecture and dependencies
- Searching for code by meaning, not just exact text
- Locating entry points and module boundaries

## Skip when
- User gave an exact file path and task is strictly inside it
- Searching for a literal string you know exists (use grep)
- Task is external to this repo
- The repo/task is small enough that grep/read is cheaper

## Prerequisite

The project must already be initialized (`.indexer-cli/` exists). If not, tell the user to run `indexer-cli init`.

## Default workflow

Run all commands from the project root. Prefer `--json`. Add `--path-prefix` whenever you already know the target area.

1. **Check index status if needed**

```bash
indexer-cli index --status --json
```

2. **Search semantically first**

```bash
indexer-cli search "<query>" --json
indexer-cli search "<query>" --json --path-prefix src/api
indexer-cli search "<query>" --json --top-k 5
indexer-cli search "<query>" --json --chunk-types impl,types
```

3. **Use structure when search is weak or you need layout**

```bash
indexer-cli structure --json
indexer-cli structure --json --path-prefix src/engine
indexer-cli structure --json --kind function
```

4. **Use architecture for project-wide overview**

```bash
indexer-cli architecture --json
```

5. **Re-index if results look stale**

```bash
indexer-cli index
```

Incremental is the default.

## Search Query Tips

- Use 2-8 keywords, not full sentences
- Prefer identifiers and concrete nouns
- Good: `authentication middleware`, `JWT token validation`, `database connection pool`
- Better than: `how do I handle errors`

## Fallback Order

If indexer results are insufficient:
1. Refine the query
2. Add `--path-prefix` or use `structure`
3. Fall back to grep/glob/read for literal lookup
