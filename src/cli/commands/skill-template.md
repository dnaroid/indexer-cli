---
name: repo-discovery
description: Mandatory for repository discovery. Before grep/glob/find, first use indexer-cli whenever the task involves finding implementations, tracing behavior, locating symbols, identifying entry points, inspecting module structure, understanding how some part of this repo works, or exploring an unfamiliar area of this repo.
allowed-tools: Bash(npx indexer-cli:*)
---

# Repository discovery with indexer-cli

Use this skill for repository discovery tasks inside this repository.
Load this skill automatically when the user asks to find, trace, inspect, understand, or map code in this repo.

## Required behavior

Always start with indexer-cli for repository discovery.
Do not use grep, glob, or find unless indexer-cli was insufficient or you need an exact literal match after narrowing
the area.

## Auto-load triggers

Load this skill automatically for prompts like:

- Find where something is implemented in this repo
- Trace a symbol, handler, feature, or behavior through the codebase
- Understand how some part of this repository works
- Inspect an unfamiliar module, directory, or subsystem
- Map entry points, dependencies, callers, or imports
- Explore the codebase when the right file is not known yet

## Load this skill when

- You need to find where something is implemented
- You need to trace a symbol, handler, feature, or behavior
- You are entering an unfamiliar module or directory
- You need structure, entry points, or dependency context
- The task is exploratory and you do not yet know the right file

## Skip this skill when

- The exact file is already known and the task stays inside it
- You only need an exact literal text match
- The task is outside this repository

## First command

Run one of these first:

```bash
npx indexer-cli search "<query>"
npx indexer-cli search "<query>" --path-prefix src/<area>
npx indexer-cli search "<query>" --chunk-types impl,types
npx indexer-cli structure --path-prefix src/<area>
npx indexer-cli structure --kind class
npx indexer-cli architecture
```

## Reading search results

`npx indexer-cli search` returns ranked code chunks as JSON by default, not whole files.
Each default JSON result includes `filePath`, `startLine`, `endLine`, `score`, and `primarySymbol`.
Use `--include-content` when you need `content` in JSON output.

- Use `score` to prefer the most relevant chunks first and filter obvious low-relevance noise.
- Use `primarySymbol` to see which function/class/type the chunk belongs to before opening the file.
- Treat `content` as supporting context, but rank and filter with `score` + `primarySymbol` instead of raw text alone.

## Command map

Discovery: `npx indexer-cli search "<query>"`, `npx indexer-cli structure`, `npx indexer-cli architecture`,
`npx indexer-cli context`, `npx indexer-cli explain <symbol>`, `npx indexer-cli deps <path>`

Use `--txt` for human-readable output when you are browsing manually.

Narrow when needed with: `--path-prefix`, `--chunk-types`, `--fields`, `--min-score`, `--kind`, `--max-depth`,
`--max-files`, `--scope`, `--max-deps`, `--direction`, `--include-fixtures`, `--omit-content`, `--include-content`

## Type Reference

### Chunk types (--chunk-types)

`full_file`, `imports`, `preamble`, `declaration`, `module_section`, `impl`, `types`

### Symbol kinds (--kind)

`function`, `class`, `method`, `interface`, `type`, `variable`, `module`, `signal`
