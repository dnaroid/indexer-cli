# indexer-cli

Project indexer that installs a focused discovery skill for coding agents and helps them spend fewer tokens finding the
right code.

## Overview

The main feature of `indexer-cli` is not just search on its own: it turns your repository into something coding agents
can navigate efficiently. Running `idx init` installs a project-local discovery skill so Claude, OpenCode, and similar
tools can pick the right indexed workflow instead of wasting tokens on blind `grep`, `find`, and repeated file reads.

Under the hood, `indexer-cli` indexes source code, generates vector embeddings through a local Ollama instance, and
stores everything in a per-project `.indexer-cli/` directory. That gives both humans and agents fast natural-language
search, repo structure snapshots, and low-friction incremental reindexing without any daemon or background service. A Git
post-commit hook keeps the index up to date automatically.

## Features

- **Code-agent repo skill**: `init` installs one focused autonomous discovery skill for Claude and OpenCode workflows
- **`idx` command alias**: `setup` installs or repairs a clean `idx` wrapper — no npm warnings in agent output
- **Token savings for agents**: Pushes agents toward indexed discovery instead of expensive blind search and repeated
  context loading
- **Multi-language support**: TypeScript/JavaScript, Python, C#, GDScript, Ruby
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
entry point that routes them toward `idx search`, `idx structure`, `idx architecture`, `idx explain`, and `idx deps`
before they start burning tokens on broad filesystem scans.

## Why agents save tokens with this

Without repo-local skills, agents often spend tokens on repetitive repository discovery: broad `grep`, repeated file
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
idx architecture
```

All discovery commands return human-readable text output, optimized for coding agents.

This is especially useful in Claude and OpenCode setups, where project-local skills can guide the agent away from
blind `grep`/`find` usage and toward indexed discovery, which usually means less wasted context and lower token usage
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

If you run `idx index` from a subdirectory of an initialized project, the CLI automatically reuses the initialized
project root. If no `.indexer-cli/` data exists yet, it stops and tells you to run `idx init` first.

| Option      | Description                                                |
|-------------|------------------------------------------------------------|
| `--full`    | Force a full reindex instead of incremental                |
| `--dry-run` | Preview what would be indexed without writing anything     |
| `--status`  | Show indexing status for the current project               |
| `--tree`    | Show indexed file tree (use with `--status`)               |

### `idx search <query>`

Run a semantic search against the indexed codebase. Automatically re-indexes changed files if needed.

If you run `idx search` from a subdirectory of an initialized project, the CLI automatically reuses the initialized
project root. If no `.indexer-cli/` data exists yet, it stops and tells you to run `idx init` first.

| Option                   | Default | Description                                                                                                  |
|--------------------------|---------|--------------------------------------------------------------------------------------------------------------|
| `--max-files <number>`   | 3       | Number of results to return                                                                                  |
| `--path-prefix <string>` | —       | Limit results to files under this path                                                                       |
| `--chunk-types <string>` | —       | Comma-separated filter: `full_file`, `imports`, `preamble`, `declaration`, `module_section`, `impl`, `types` |
| `--include-imports`      | —       | Include `imports`/`preamble` chunks (excluded by default)                                                    |
| `--min-score <number>`   | 0.45    | Filter out results below this score (0..1)                                                                   |
| `--include-content`      | —       | Include matched code content in output (omitted by default to save tokens)                                   |

### `idx structure`

Print a file tree annotated with extracted symbols for the current working directory. Automatically re-indexes changed
files if needed.

| Option                   | Description                                                                                               |
|--------------------------|-----------------------------------------------------------------------------------------------------------|
| `--path-prefix <string>` | Limit output to files under this path                                                                     |
| `--kind <string>`        | Filter by symbol kind: `function`, `class`, `method`, `interface`, `type`, `variable`, `module`, `signal` |
| `--max-depth <number>`   | Limit directory traversal depth in the rendered tree                                                      |
| `--max-files <number>`   | Limit number of files shown in output                                                                     |
| `--no-tests`             | Exclude test files from output                                                                            |

### `idx architecture`

Print an architecture snapshot for the current working directory: file statistics, detected entry points, and a
dependency graph.

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

### `idx deps <path>`

Show callers (who imports this) and callees (what this imports) for a module or symbol. Useful for tracing impact
of changes and understanding dependency chains.

Path arguments stay project-root-relative even when you invoke the command from a nested subdirectory.

| Option              | Default | Description                     |
|---------------------|---------|---------------------------------|
| `--direction <dir>` | both    | `callers`, `callees`, or `both` |
| `--depth <n>`       | 1       | Traversal depth                 |

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

## License

MIT
