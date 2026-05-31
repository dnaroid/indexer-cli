# indexer-cli

Project indexer that installs a focused discovery skill for coding agents and helps them spend fewer tokens finding the
right code.

## Overview

The main feature of `indexer-cli` is not just search on its own: it turns your repository into something coding agents
can navigate efficiently. Running `idx init` installs a project-local discovery skill so Claude, OpenCode, and similar
tools can pick the right indexed workflow instead of wasting tokens on blind `rg`/`grep`, `find`, and repeated file reads.

Under the hood, `indexer-cli` indexes source code, generates vector embeddings through a local Ollama instance, and
stores everything in a per-project `.indexer-cli/` directory. That gives both humans and agents fast natural-language
search, repo structure snapshots, and low-friction incremental reindexing without any daemon or background service. A Git
post-commit hook keeps the index up to date automatically.

## Features

- **Code-agent repo skill**: `init` installs one focused autonomous discovery skill for Claude and OpenCode workflows
- **`idx` command alias**: `setup` installs or repairs a clean `idx` wrapper — no npm warnings in agent output
- **Token savings for agents**: Pushes agents toward indexed discovery instead of expensive blind search and repeated
  context loading
- **Multi-language support**: TypeScript/JavaScript, Python, C#, GDScript, Ruby, Rust
- **Semantic code search**: Natural language queries over your entire codebase
- **Incremental indexing**: Uses `git diff` to re-index only changed files, bulk-copies unchanged vectors
- **Local-first**: All data stored in `.indexer-cli/` inside the project (SQLite + sqlite-vec)
- **Ollama-powered embeddings**: Uses `jina-8k` model (768-dim vectors) via a local Ollama instance
- **Architecture snapshot**: Generates dependency graphs, entry points, and file stats
- **Symbol extraction**: Functions, classes, interfaces, and imports are all indexed
- **Adaptive chunking**: Smart code splitting at function, module, or single-file granularity

## Prerequisites

- [Ollama](https://ollama.ai) installed manually. `idx setup` will verify it, start the daemon if needed,
  and prepare the `jina-8k` model.
- Node.js 18+ and build tools (python3, make, C++ compiler) for native dependencies.

The `setup` command handles global installation automatically: it installs indexer-cli via npm and ensures the
`idx` wrapper is on your PATH.

## Quick Start

### Installation

```bash
# Recommended: global install
npm install -g indexer-cli@latest
idx setup

# Alternative: run via npx (no install needed)
npx indexer-cli@latest setup
```

### Usage

```bash
# 1. Install globally and set up
npm install -g indexer-cli@latest
idx setup

# 2. Initialize indexing and install the discovery skill
cd /path/to/your/project
idx init

# 3. Index the codebase
idx index

# 4. Search semantically yourself
idx search "authentication middleware"
```

After `idx init`, you can run project commands from subdirectories too: `indexer-cli` will detect the initialized
project root automatically. If a project has not been initialized yet, commands such as `idx search` and `idx index`
stop with a clear message telling you to run `idx init` first instead of creating data in the wrong directory.

After `init`, the repo contains `.claude/skills/repo-discovery/SKILL.md`, so coding agents get one indexed discovery
entry point that routes them toward `idx search`, `idx structure`, `idx ast`, `idx architecture`, `idx explain`, and `idx deps`
before they start burning tokens on broad filesystem scans.

## Why agents save tokens with this

Without repo-local skills, agents often spend tokens on repetitive repository discovery: broad `rg`/`grep`, repeated file
reads, and trial-and-error navigation. With `indexer-cli`, agents can load one focused discovery skill and start from
the right indexed path immediately.

In practice, that means:

- less irrelevant context pulled into the prompt
- fewer repeated search passes over the same files
- faster navigation to the right symbol, module, or entry point
- better reuse of a local repo index instead of raw token-heavy exploration

## Agent Integration

When you run `idx init`, the CLI creates a single `repo-discovery` skill under `.claude/skills/` and adds `.claude/`
to `.gitignore`.

That skill routes repository discovery flows such as:

```bash
idx search "<query>"
idx structure --path-prefix src/<area>
idx ast src/<large-file.ts>
idx architecture
```

All discovery commands return human-readable text output, optimized for coding agents.

This is especially useful in Claude and OpenCode setups, where project-local skills can guide the agent away from
blind `rg`/`grep`/`find` usage and toward indexed discovery, which usually means less wasted context and lower token usage
during repo discovery.

## CLI Commands

### `idx setup`

Install indexer-cli globally via npm, check system prerequisites, prepare the Ollama embedding model, and install
or repair the `idx` command alias in `~/.local/bin/`. `setup` can install some system tools where appropriate, but
Ollama itself must be installed manually first. Works on macOS and Linux.

After running `setup`, restart your shell to ensure `idx` is on `PATH`.

### `idx init`

Create the `.indexer-cli/` directory, initialize the SQLite database and sqlite-vec vector store, and add `.indexer-cli/`
to `.gitignore` in the current working directory. Also writes the `repo-discovery` skill under `.claude/skills/`,
adds `.claude/` to `.gitignore`, and installs a Git post-commit hook that automatically re-indexes changed files.

When run from a subdirectory of a Git project, `idx init` automatically initializes the Git project root.

| Option              | Description                                                                     |
|---------------------|---------------------------------------------------------------------------------|
| `--refresh-skills`  | Remove this CLI's generated discovery skill under `.claude/skills/` and recreate it |

### `idx index`

Index all supported source files in the current working directory.

Indexing respects the project root `.gitignore` plus built-in excludes such as `node_modules`, `.git`, `dist`, and
`coverage`. If the root `.gitignore` changes, the next incremental run falls back to a full reindex so newly ignored
files are removed from the index.

You can persist index path masks in `.indexer-cli/config.json` with `idx index --include <path>` and
remove them again with `idx index --exclude <path>`. `indexIncludePaths` are additive: matching files are indexed even
when `.gitignore` would hide them. Masks accept project-root-relative paths or globs such as `generated/keep.ts`,
`generated/**`, or `vendor/**`; changing masks forces a full reindex on that run.

If you run `idx index` from a subdirectory of an initialized project, the CLI automatically reuses the initialized
project root. If no `.indexer-cli/` data exists yet, it stops and tells you to run `idx init` first.

| Option      | Description                                                |
|-------------|------------------------------------------------------------|
| `--full`    | Force a full reindex instead of incremental                |
| `--dry-run` | Preview what would be indexed without writing index data   |
| `--status`  | Show indexing status for the current project               |
| `--tree`    | Show indexed file tree (use with `--status`)               |
| `--include <path>` | Add a path/glob mask to index even when matched by `.gitignore` |
| `--exclude <path>` | Remove a path/glob mask from the persisted include list |

### `idx search <query>`

Run a semantic search against the indexed codebase. Automatically re-indexes changed files if needed.

If you run `idx search` from a subdirectory of an initialized project, the CLI automatically reuses the initialized
project root. If no `.indexer-cli/` data exists yet, it stops and tells you to run `idx init` first.

| Option                   | Default | Description                                                                                                  |
|--------------------------|---------|--------------------------------------------------------------------------------------------------------------|
| `--max-files <number>`   | 3       | Number of results to return                                                                                  |
| `--path-prefix <string>` | —       | Limit results to files under this path                                                                       |
| `--chunk-types <string>` | —       | Comma-separated filter. Types: `full_file`, `imports`, `preamble`, `declaration`, `module_section`, `impl`, `types`; aliases: `api`, `impl`, `tests`, `imports` |
| `--mode <mode>`          | hybrid  | Ranking mode: `hybrid`, `semantic`, `lexical`, or `symbol`                                                   |
| `--include-imports`      | —       | Include `imports`/`preamble` chunks (excluded by default)                                                    |
| `--min-score <number>`   | 0.55    | Filter out results below the final ranking score. Semantic scores are usually 0..1; hybrid scores may exceed 1 |
| `--include-content`      | —       | Include matched code content in output (omitted by default to save tokens)                                   |
| `--dedupe-file`          | —       | Return at most one result per file                                                                           |
| `--dedupe-symbol`        | —       | Return at most one result per file/symbol pair                                                               |
| `--cluster`              | —       | Group nearby similar chunks and show one representative                                                      |
| `--exclude-tests`        | —       | Exclude test files from search results                                                                       |
| `--include-tests`        | —       | Include test files without the default test penalty                                                          |

`idx search` prints compact diagnostics when a query is likely too broad, a path prefix is missing, or a high
`--min-score` filters every result. Each result includes a line range, `rank=<mode>`, and compact `why=` reason codes.
The final line suggests the cheapest file ranges to read next. Example:

```text
src/cli/commands/search.ts:93-169 (score: 2.24, rank=hybrid, function: registerSearchCommand, why=symbol+path+text+semantic)
Read next: src/cli/commands/search.ts:93-169
```

No-result diagnostics stay compact, for example: `WARN no-results min-score=0.99 suggestion='try --min-score 0.55'`.

### `idx structure`

Print a file tree annotated with extracted symbols for the current working directory. Automatically re-indexes changed
files if needed.

| Option                   | Description                                                                                               |
|--------------------------|-----------------------------------------------------------------------------------------------------------|
| `--path-prefix <string>` | Limit output to files under this path                                                                     |
| `--kind <string>`        | Filter by symbol kind: `function`, `class`, `method`, `interface`, `type`, `variable`, `module`, `signal` |
| `--max-depth <number>`   | Limit directory traversal depth in the rendered tree                                                      |
| `--max-files <number>`   | Limit number of files shown in output                                                                     |
| `--cursor <number>`      | Continue from a previous `TRUNC` cursor                                                                   |
| `--include-internal`     | Include non-exported/internal symbols                                                                     |
| `--include-fixtures`     | Include fixture/vendor paths in output                                                                    |
| `--no-tests`             | Exclude test files from output                                                                            |
| `--include-tests-summary` | Show nearest tests for listed source files                                                                |

`idx structure` annotates symbols with line ranges, so agents can jump directly to the smallest useful `Read` range:

```text
search.ts — function: registerSearchCommand:93-294
```

When output is capped with `--max-files`, truncation is explicit and includes a continuation command:

```text
TRUNC hidden=49 cursor=5
NEXT idx structure --path-prefix src --max-depth 2 --max-files 5 --cursor 5
```

### `idx ast <file>`

Print a compact AST outline for one supported source file. Use this after `search` or `structure` has identified a large
file, but before reading it in chunks: the output gives syntax node names, line ranges, and short first-line snippets so
an agent can choose the smallest useful `Read` ranges.

| Option                   | Default | Description                                  |
|--------------------------|---------|----------------------------------------------|
| `--max-depth <number>`   | 5       | Limit AST traversal depth                    |
| `--max-nodes <number>`   | 120     | Limit number of AST nodes shown              |
| `--cursor <number>`      | 0       | Continue from a previous `TRUNC` cursor      |
| `--no-include-text`      | —       | Hide compact first-line snippets             |

Example:

```text
AST src/cli/commands/search.ts language=typescript nodes=75 maxDepth=2
SourceFile:1-295 — import path from "node:path";
  ImportDeclaration:1 — import path from "node:path";
    ImportClause:1 — path
    StringLiteral:1 — "node:path"

TRUNC hidden=67 cursor=8
NEXT idx ast src/cli/commands/search.ts --max-depth 2 --max-nodes 8 --cursor 8
```

### `idx architecture`

Print an architecture snapshot for the current working directory: file statistics, detected entry points, a dependency
graph, actionable cycle causes, classified unresolved dependencies, and up to three suggested actions.

| Option                   | Description                            |
|--------------------------|----------------------------------------|
| `--path-prefix <string>` | Limit output to files under this path  |
| `--include-fixtures`     | Include fixture/vendor paths in output |

When `--path-prefix` is used with `search`, `structure`, or `architecture` and the path does not match any indexed
files, the CLI prints a warning and automatically runs the command for the entire project instead of returning empty
results. For `structure`, the fallback also limits depth to 1 (root-level directories only) unless `--max-depth` was
explicitly specified.

### `idx explain <symbol>`

Show context for a symbol: its signature, callers, and containing module. Use this to quickly understand what a
specific function, class, or type does and how it is used.

When auto-root detection is used, symbol paths such as `src/payments/processor.ts::PaymentProcessor` are still resolved
relative to the project root, not the subdirectory where you ran the command.

| Option                   | Default | Description                                  |
|--------------------------|---------|----------------------------------------------|
| `--path-prefix <string>` | —       | Limit symbol lookup to files under this path |
| `--include-fixtures`     | —       | Include fixture/vendor paths in lookup       |
| `--include-body`         | —       | Include a compact body preview               |
| `--body-lines <number>`  | 40      | Number of body preview lines, from 1 to 200  |
| `--signature-only`       | —       | Omit dependency context, tests, and body hints |

### `idx deps <path>`

Show module import dependencies for a path, or symbol-level call dependencies with `--mode calls`. The default text output
labels imported-by/imports first and keeps `Callers`/`Callees` aliases for compatibility. Useful for tracing impact of
changes and understanding dependency chains.

Path arguments stay project-root-relative even when you invoke the command from a nested subdirectory.
Use `path::symbol` with `--mode calls` to focus on one callable symbol, for example
`idx deps src/services/user.ts::createUser --mode calls --direction both`.

| Option           | Default | Description                                                |
|------------------|---------|------------------------------------------------------------|
| `--mode <mode>`  | modules | `modules`/`module-imports` or `calls`/`call-graph`         |
| `--direction <dir>` | both | `callers`/imported-by, `callees`/imports, or `both`        |
| `--depth <n>`    | 1       | Traversal depth, with transitive edges marked as `d=<n>`   |
| `--show-edges`   | —       | Show the import specifier or call name/kind that created each edge |
| `--tests`        | —       | Show nearest/impacted tests and a suggested verification command |

### `idx uninstall`

Remove the `.indexer-cli/` directory from the initialized project root. Also removes the generated
`.claude/skills/` directories created by `indexer-cli`, cleans this CLI's Git hook block, and removes its
`.gitignore` entries when present. Prompts for confirmation unless `-f` is given.

Deprecated generated skill directories such as `context-pack` are cleaned up when present.

### `idx doctor [dir]`

Health-check and repair registered indexer projects. Runs system prerequisite checks (same as `idx setup`), then
operates on registered projects. Without arguments, operates on all projects in the global registry
(`~/.indexer-cli/registry.json`) and cleans stale entries. With a directory argument, scans its
subdirectories for `.indexer-cli/`, auto-registers found projects, and operates on them.

| Option              | Description                                      |
|---------------------|--------------------------------------------------|
| `--skills-only`     | Only refresh skills without full reinstall       |
| `-f, --force`       | Skip confirmation prompt                         |

The global registry is maintained automatically: `idx init` registers a project, `idx uninstall` unregisters it.
`idx doctor <dir>` also registers discovered projects.

## Auto-update behavior

`indexer-cli` auto-update runs **after** a successful command execution, not before command execution.

- The current run always completes on the currently installed CLI version.
- If a newer version is available and auto-update is allowed, it is installed at process exit.
- The newly installed version is used on the **next** command run.
- Help/version and invalid-command paths do not trigger post-command auto-update.

Pass `--no-auto-update` with any command to skip the auto-update attempt for that run.

## Release process

Publishing is handled by `scripts/publish.sh`: it bumps the version, runs a smoke-test on the packed tarball,
then pushes a tag to master. CI builds, tests, and runs the same tarball smoke-test before publishing to npm.

The smoke-test (`npm run smoke-test`) verifies the packed artifact by installing it in an isolated temp directory
and running: `--help`, bare invocation, `setup --help`, `search --help`, `init --help`, and `--version`.
Publish is blocked if any check fails.

## License

MIT
