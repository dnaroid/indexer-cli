# indexer-cli

Project indexer that installs a repo-discovery skill for coding agents and helps them spend fewer tokens finding the right code.

## Overview

The main feature of `indexer-cli` is not just search on its own: it turns your repository into something coding agents
can navigate efficiently. Running `indexer-cli init` installs a project-local `repo-discovery` skill that nudges Claude,
OpenCode, and similar tools to use indexed repository discovery first instead of wasting tokens on blind `grep`,
`find`, and repeated file reads.

Under the hood, `indexer-cli` indexes source code, generates vector embeddings through a local Ollama instance, and
stores everything in a per-project `.indexer-cli/` directory. That gives both humans and agents fast natural-language
search, repo structure snapshots, and low-friction incremental reindexing without any daemon or background service.

## Features

- **Code-agent repo skill**: `init` installs a project-local `repo-discovery` skill for Claude and OpenCode workflows
- **Token savings for agents**: Pushes agents toward indexed discovery instead of expensive blind search and repeated context loading
- **Multi-language support**: TypeScript/JavaScript, Python, C#, GDScript, Ruby
- **Semantic code search**: Natural language queries over your entire codebase
- **Incremental indexing**: Uses `git diff` to re-index only changed files, bulk-copies unchanged vectors
- **Local-first**: All data stored in `.indexer-cli/` inside the project (SQLite + LanceDB)
- **Ollama-powered embeddings**: Uses `jina-8k` model (768-dim vectors) via a local Ollama instance
- **Architecture snapshot**: Generates dependency graphs, entry points, and file stats
- **Symbol extraction**: Functions, classes, interfaces, and imports are all indexed
- **Adaptive chunking**: Smart code splitting at function, module, or single-file granularity

## Prerequisites

- [Ollama](https://ollama.ai) installed manually. `npx indexer-cli setup` will verify it, start the daemon if needed, and prepare the `jina-8k` model.
- Node.js 18+ and build tools (python3, make, C++ compiler) for native dependencies.

## Quick Start

```bash
# 1. Initialize indexing and install the repo-discovery skill
cd /path/to/your/project
npx indexer-cli init

# 2. Index the codebase
npx indexer-cli index

# 3. Search semantically yourself
npx indexer-cli search "authentication middleware"
```

After `init`, the repo also contains `.claude/skills/repo-discovery/SKILL.md`, so coding agents can be steered toward
`npx indexer-cli search`, `npx indexer-cli structure`, `npx indexer-cli architecture`, `npx indexer-cli context`,
`npx indexer-cli explain`, and `npx indexer-cli deps` before they start burning tokens on broad filesystem scans.

## Why agents save tokens with this

Without a repo-local skill, agents often spend tokens on repetitive repository discovery: broad `grep`, repeated file
reads, and trial-and-error navigation. With `indexer-cli`, the skill tells them to start from indexed search and
structured repo views instead.

In practice, that means:

- less irrelevant context pulled into the prompt
- fewer repeated search passes over the same files
- faster navigation to the right symbol, module, or entry point
- better reuse of a local repo index instead of raw token-heavy exploration

## Agent Integration

When you run `npx indexer-cli init`, the CLI creates a project-local repo-discovery skill at
`.claude/skills/repo-discovery/SKILL.md` and adds `.claude/` to `.gitignore`.

That skill tells coding agents to start repository discovery with commands like:

```bash
npx indexer-cli search "<query>" --json
npx indexer-cli structure --json --path-prefix src/<area>
npx indexer-cli architecture --json
npx indexer-cli index --status --json
```

This is especially useful in Claude and OpenCode setups, where project-local skills can guide the agent away from
blind `grep`/`find` usage and toward indexed search first, which usually means less wasted context and lower token
usage during repo discovery.

## CLI Commands

### `npx indexer-cli setup`

Check system prerequisites and prepare the Ollama embedding model. `setup` can install some system tools where appropriate, but Ollama itself must be installed manually first. Works on macOS and Linux.

### `npx indexer-cli init`

Create the `.indexer-cli/` directory, initialize the SQLite database and LanceDB vector store, and add `.indexer-cli/`
to `.gitignore` in the current working directory. Also writes the project-local repo-discovery skill to
`.claude/skills/repo-discovery/SKILL.md` and adds `.claude/` to `.gitignore`.

### `npx indexer-cli index`

Index all supported source files in the current working directory.

| Option      | Description                                            |
|-------------|--------------------------------------------------------|
| `--full`    | Force a full reindex instead of incremental            |
| `--dry-run` | Preview what would be indexed without writing anything |
| `--status`  | Show indexing status for the current project           |
| `--tree`    | Show indexed file tree (use with `--status`)           |
| `--json`    | Output status as JSON (use with `--status`)            |

### `npx indexer-cli search <query>`

Run a semantic search against the indexed codebase. Automatically re-indexes changed files if needed.

| Option                   | Default | Description                                                                                                  |
|--------------------------|---------|--------------------------------------------------------------------------------------------------------------|
| `--top-k <number>`       | 3       | Number of results to return                                                                                  |
| `--path-prefix <string>` | —       | Limit results to files under this path                                                                       |
| `--chunk-types <string>` | —       | Comma-separated filter: `full_file`, `imports`, `preamble`, `declaration`, `module_section`, `impl`, `types` |
| `--fields <list>`        | —       | Comma-separated output fields: `filePath`, `startLine`, `endLine`, `score`, `primarySymbol`, `content`       |
| `--min-score <number>`   | —       | Filter out results below this score (0..1)                                                                   |
| `--omit-content`         | —       | Exclude content from results (token-saving)                                                                  |
| `--include-content`      | —       | Include content in JSON output                                                                               |
| `--json`                 | —       | Output results as JSON                                                                                       |

### `npx indexer-cli structure`

Print a file tree annotated with extracted symbols for the current working directory. Automatically re-indexes changed
files if needed.

| Option                   | Description                                                                                               |
|--------------------------|-----------------------------------------------------------------------------------------------------------|
| `--path-prefix <string>` | Limit output to files under this path                                                                     |
| `--kind <string>`        | Filter by symbol kind: `function`, `class`, `method`, `interface`, `type`, `variable`, `module`, `signal` |
| `--max-depth <number>`   | Limit directory traversal depth in the rendered tree                                                      |
| `--max-files <number>`   | Limit number of files shown in output                                                                     |
| `--json`                 | Output structure as JSON                                                                                  |

### `npx indexer-cli architecture`

Print an architecture snapshot for the current working directory: file statistics, detected entry points, and a
dependency graph.

| Option                   | Description                                  |
|--------------------------|----------------------------------------------|
| `--path-prefix <string>` | Limit output to files under this path        |
| `--include-fixtures`     | Include fixture/vendor paths in output       |
| `--json`                 | Output as JSON                               |

### `npx indexer-cli context`

Output dense project context aggregated from the index. Useful for getting a concise overview of a codebase area
without pulling in entire files.

| Option                | Default | Description                                                              |
|-----------------------|---------|--------------------------------------------------------------------------|
| `--format <format>`   | plain   | Output format: `plain` or `json`                                         |
| `--scope <scope>`     | all     | `all`, `changed` (uncommitted changes), or `relevant-to:<path>`          |
| `--max-deps <number>` | 30      | Maximum number of dependency edges to output                             |
| `--include-fixtures`  | —       | Include fixture/vendor paths in output                                   |
| `--json`              | —       | Shorthand for `--format=json`                                            |

### `npx indexer-cli explain <symbol>`

Show context for a symbol: its signature, callers, and containing module. Use this to quickly understand what a
specific function, class, or type does and how it is used.

| Option   | Description          |
|----------|----------------------|
| `--json` | Output as JSON       |

### `npx indexer-cli deps <path>`

Show callers (who imports this) and callees (what this imports) for a module or symbol. Useful for tracing impact
of changes and understanding dependency chains.

| Option              | Default | Description                                       |
|---------------------|---------|---------------------------------------------------|
| `--direction <dir>` | both    | `callers`, `callees`, or `both`                   |
| `--depth <n>`       | 1       | Traversal depth                                   |
| `--json`            | —       | Output as JSON                                    |

### `npx indexer-cli uninstall`

Remove the `.indexer-cli/` directory from the current working directory. Also removes the generated
`.claude/skills/repo-discovery/` skill directory when present. Prompts for confirmation unless `-f` is given.

## License

MIT
