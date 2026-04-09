---
name: repo-discovery
description: Mandatory for repository discovery. Use indexer-cli before grep/glob/find when locating implementations, tracing behavior, finding symbols or entry points, inspecting module structure, or exploring an unfamiliar area of this repo.
allowed-tools: Bash(npx indexer-cli:*)
---

# Repository discovery with indexer-cli

## Required behavior

Always start with indexer-cli for repository discovery.
Do not use grep, glob, or find unless indexer-cli was insufficient or you need an exact literal match after narrowing the area.

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
npx indexer-cli search "<query>" --json
npx indexer-cli search "<query>" --json --path-prefix src/<area>
npx indexer-cli search "<query>" --json --chunk-types impl,types
npx indexer-cli structure --json --path-prefix src/<area>
npx indexer-cli structure --json --kind class
npx indexer-cli architecture --json
npx indexer-cli index --status --json
```

## Reading search results

`npx indexer-cli search --json` returns ranked code chunks, not whole files.
Each result includes `filePath`, `startLine`, `endLine`, `score`, `primarySymbol`, and `content`.

- Use `score` to prefer the most relevant chunks first and filter obvious low-relevance noise.
- Use `primarySymbol` to see which function/class/type the chunk belongs to before opening the file.
- Treat `content` as supporting context, but rank and filter with `score` + `primarySymbol` instead of raw text alone.
- Content is omitted by default in JSON output; use `--include-content` to include it, or `--omit-content` to make that explicit and save tokens.

## Commands Reference

### `search <query>` — Semantic code search

Semantic search over indexed code. Re-indexes changed files if needed.

| Option | Default | Description |
|--------|---------|-------------|
| `--top-k <number>` | 3 | Max results |
| `--path-prefix <string>` | — | Restrict to this path prefix |
| `--chunk-types <string>` | — | Comma-separated chunk type filter |
| `--fields <list>` | — | Return only these comma-separated fields: `filePath`, `startLine`, `endLine`, `score`, `primarySymbol`, `content` |
| `--min-score <number>` | — | Drop results below this score (0..1) |
| `--omit-content` | — | Exclude content to save tokens |
| `--include-content` | — | Include content in JSON |
| `--json` | — | JSON output |

### `structure` — File tree with symbols

Annotated file tree with extracted symbols. Re-indexes changed files if needed.

| Option | Description |
|--------|-------------|
| `--path-prefix <string>` | Restrict to this path prefix |
| `--kind <string>` | Filter symbol kinds |
| `--max-depth <number>` | Limit traversal depth |
| `--max-files <number>` | Limit files shown |
| `--json` | JSON output |

### `architecture` — Architecture snapshot

Repo snapshot: file stats, entry points, and dependency graph.

| Option | Description |
|--------|-------------|
| `--path-prefix <string>` | Restrict to this path prefix |
| `--include-fixtures` | Include fixture/vendor paths |
| `--json` | JSON output |

### `context` — Dense project context

Dense project context from the index. Useful for a concise area overview.

| Option | Default | Description |
|--------|---------|-------------|
| `--format <format>` | plain | `plain` or `json` |
| `--scope <scope>` | all | `all`, `changed`, or `relevant-to:<path>` |
| `--max-deps <number>` | 30 | Max dependency edges |
| `--include-fixtures` | — | Include fixture/vendor paths |
| `--json` | — | Shorthand for `--format=json` |

### `explain <symbol>` — Symbol context

Show a symbol's signature, callers, and containing module.

| Option | Description |
|--------|-------------|
| `--json` | JSON output |

### `deps <path>` — Dependency graph for a path

Show importers and imports for a module or symbol.

| Option | Default | Description |
|--------|---------|-------------|
| `--direction <dir>` | both | `callers`, `callees`, or `both` |
| `--depth <n>` | 1 | Traversal depth |
| `--json` | — | JSON output |

### `index` — Index project files

| Option | Description |
|--------|-------------|
| `--full` | Force full reindex instead of incremental |
| `--dry-run` | Preview what would be indexed |
| `--status` | Show indexing status |
| `--tree` | Show indexed file tree (use with `--status`) |
| `--json` | Output status as JSON (use with `--status`) |

### `setup` / `init` / `uninstall`

- `setup` — Check prerequisites and prepare the Ollama embedding model.
- `init` — Create `.indexer-cli/`, initialize databases, and install this skill.
- `uninstall` — Remove indexer data (`-f` skips confirmation).

## Type Reference

### Chunk types (--chunk-types)

`full_file`, `imports`, `preamble`, `declaration`, `module_section`, `impl`, `types`

### Symbol kinds (--kind)

`function`, `class`, `method`, `interface`, `type`, `variable`, `module`, `signal`
