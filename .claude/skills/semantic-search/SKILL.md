---
name: semantic-search
description: Load this for repo discovery. Use indexer-cli before grep/glob/find when you need to find code, trace implementations, inspect structure, or understand an unfamiliar area.
allowed-tools: Bash(indexer-cli:*)
---

# Semantic search with indexer-cli

Use this skill before grep/glob/find when the task is about discovery inside this repo.

## Load this skill when

- You need to find where something is implemented
- You are entering an unfamiliar module or directory
- You want the structure of an area, not just a filename
- You need entry points, symbols, or dependency context

## Skip this skill when

- The user already gave the exact file and the task stays inside it
- You only need a literal text match
- The task is outside this repository

## First commands to try

```bash
indexer-cli search "<query>" --json
indexer-cli search "<query>" --json --path-prefix src/<area>
indexer-cli structure --json --path-prefix src/<area>
indexer-cli architecture --json
indexer-cli index --status --json
```

If results look stale, run:

```bash
indexer-cli index
```

## Default workflow

1. Start with `search` for a symbol, behavior, or concept.
2. Use `structure` when you need the layout of a directory.
3. Use `architecture` for higher-level dependency or entry-point questions.
4. Only fall back to grep/glob/find after indexer-cli was not enough.

## Query tips

- Keep queries short: 2-8 keywords
- Prefer identifiers or nouns over full sentences
- Add `--path-prefix` as soon as you know the area

## Examples

```bash
indexer-cli search "search command handler" --json
indexer-cli search "SymbolExtractor" --json --path-prefix src
indexer-cli structure --json --path-prefix src/engine
```
