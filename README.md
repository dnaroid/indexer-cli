# indexer-cli

Project indexer that installs focused discovery skills for coding agents and helps them spend fewer tokens finding the
right code.

## Overview

The main feature of `indexer-cli` is not just search on its own: it turns your repository into something coding agents
can navigate efficiently. Running `indexer-cli init` installs project-local discovery skills with semantic names so
Claude, OpenCode, and similar tools can pick the right indexed workflow instead of wasting tokens on blind `grep`,
`find`, and repeated file reads.

Under the hood, `indexer-cli` indexes source code, generates vector embeddings through a local Ollama instance, and
stores everything in a per-project `.indexer-cli/` directory. That gives both humans and agents fast natural-language
search, repo structure snapshots, and low-friction incremental reindexing without any daemon or background service.

## Features

- **Code-agent repo skills**: `init` installs focused autonomous discovery skills for Claude and OpenCode workflows
- **Token savings for agents**: Pushes agents toward indexed discovery instead of expensive blind search and repeated
  context loading
- **Multi-language support**: TypeScript/JavaScript, Python, C#, GDScript, Ruby
- **Semantic code search**: Natural language queries over your entire codebase
- **Incremental indexing**: Uses `git diff` to re-index only changed files, bulk-copies unchanged vectors
- **Local-first**: All data stored in `.indexer-cli/` inside the project (SQLite + LanceDB)
- **Ollama-powered embeddings**: Uses `jina-8k` model (768-dim vectors) via a local Ollama instance
- **Architecture snapshot**: Generates dependency graphs, entry points, and file stats
- **Symbol extraction**: Functions, classes, interfaces, and imports are all indexed
- **Adaptive chunking**: Smart code splitting at function, module, or single-file granularity

## Prerequisites

- [Ollama](https://ollama.ai) installed manually. `npx indexer-cli setup` will verify it, start the daemon if needed,
  and prepare the `jina-8k` model.
- Node.js 18+ and build tools (python3, make, C++ compiler) for native dependencies.

## Quick Start

```bash
# 1. Check prerequisites and prepare the embedding model
npx indexer-cli setup

# 2. Initialize indexing and install the discovery skills
cd /path/to/your/project
npx indexer-cli init

# 3. Index the codebase
npx indexer-cli index

# 4. Search semantically yourself
npx indexer-cli search "authentication middleware" --txt
```

After `init`, the repo contains focused skills like `.claude/skills/semantic-search/SKILL.md`,
`.claude/skills/repo-structure/SKILL.md`, `.claude/skills/repo-context/SKILL.md`, and
`.claude/skills/dependency-trace/SKILL.md`, plus `.claude/skills/context-pack/SKILL.md`, so coding agents can load
the right indexed discovery workflow for `npx indexer-cli search`, `npx indexer-cli structure`,
`npx indexer-cli architecture`, `npx indexer-cli context`, `npx indexer-cli context-pack`,
`npx indexer-cli explain`, and `npx indexer-cli deps` before they start burning tokens on broad filesystem scans.

## Why agents save tokens with this

Without repo-local skills, agents often spend tokens on repetitive repository discovery: broad `grep`, repeated file
reads, and trial-and-error navigation. With `indexer-cli`, agents can load a focused skill that matches the current
discovery intent and start from indexed search or structure-aware commands immediately.

In practice, that means:

- less irrelevant context pulled into the prompt
- fewer repeated search passes over the same files
- faster navigation to the right symbol, module, or entry point
- better reuse of a local repo index instead of raw token-heavy exploration

## Agent Integration

When you run `npx indexer-cli init`, the CLI creates focused discovery skills for each major read-only discovery
command under `.claude/skills/` and adds `.claude/` to `.gitignore`.

Those skills cover repository discovery flows such as:

```bash
npx indexer-cli search "<query>"
npx indexer-cli structure --path-prefix src/<area>
npx indexer-cli architecture
npx indexer-cli context --scope relevant-to:src/<area>
npx indexer-cli context-pack "fix changed scope output"
```

By default, discovery commands now return JSON. Use `--txt` whenever you want human-readable output instead.

This is especially useful in Claude and OpenCode setups, where project-local skills can guide the agent away from
blind `grep`/`find` usage and toward indexed discovery, which usually means less wasted context and lower token usage
during repo discovery.

## CLI Commands

### `npx indexer-cli setup`

Check system prerequisites and prepare the Ollama embedding model. `setup` can install some system tools where
appropriate, but Ollama itself must be installed manually first. Works on macOS and Linux.

### `npx indexer-cli init`

Create the `.indexer-cli/` directory, initialize the SQLite database and LanceDB vector store, and add `.indexer-cli/`
to `.gitignore` in the current working directory. Also writes focused discovery skills under `.claude/skills/` and
adds `.claude/` to `.gitignore`.

| Option              | Description                                                                     |
|---------------------|---------------------------------------------------------------------------------|
| `--refresh-skills`  | Remove this CLI's generated skills under `.claude/skills/` and recreate them    |

### `npx indexer-cli index`

Index all supported source files in the current working directory.

| Option      | Description                                                |
|-------------|------------------------------------------------------------|
| `--full`    | Force a full reindex instead of incremental                |
| `--dry-run` | Preview what would be indexed without writing anything     |
| `--status`  | Show indexing status for the current project               |
| `--tree`    | Show indexed file tree (use with `--status`)               |
| `--txt`     | Output status as human-readable text (use with `--status`) |

### `npx indexer-cli search <query>`

Run a semantic search against the indexed codebase. Automatically re-indexes changed files if needed.

| Option                   | Default | Description                                                                                                  |
|--------------------------|---------|--------------------------------------------------------------------------------------------------------------|
| `--max-files <number>`   | 3       | Number of results to return                                                                                  |
| `--path-prefix <string>` | —       | Limit results to files under this path                                                                       |
| `--chunk-types <string>` | —       | Comma-separated filter: `full_file`, `imports`, `preamble`, `declaration`, `module_section`, `impl`, `types` |
| `--fields <list>`        | —       | Comma-separated output fields: `filePath`, `startLine`, `endLine`, `score`, `primarySymbol`, `content`       |
| `--min-score <number>`   | —       | Filter out results below this score (0..1)                                                                   |
| `--omit-content`         | +       | Explicitly exclude content from results (default behavior in JSON mode)                                      |
| `--include-content`      | —       | Include `content` in JSON output                                                                             |
| `--txt`                  | —       | Output results as human-readable text                                                                        |

`search` returns JSON by default. In JSON mode, `content` is omitted unless you pass `--include-content`; use `--txt`
for the older human-readable layout.

### `npx indexer-cli structure`

Print a file tree annotated with extracted symbols for the current working directory. Automatically re-indexes changed
files if needed.

| Option                   | Description                                                                                               |
|--------------------------|-----------------------------------------------------------------------------------------------------------|
| `--path-prefix <string>` | Limit output to files under this path                                                                     |
| `--kind <string>`        | Filter by symbol kind: `function`, `class`, `method`, `interface`, `type`, `variable`, `module`, `signal` |
| `--max-depth <number>`   | Limit directory traversal depth in the rendered tree                                                      |
| `--max-files <number>`   | Limit number of files shown in output                                                                     |
| `--txt`                  | Output structure as human-readable text                                                                   |

### `npx indexer-cli architecture`

Print an architecture snapshot for the current working directory: file statistics, detected entry points, and a
dependency graph.

| Option                   | Description                            |
|--------------------------|----------------------------------------|
| `--path-prefix <string>` | Limit output to files under this path  |
| `--include-fixtures`     | Include fixture/vendor paths in output |
| `--txt`                  | Output as human-readable text          |

### `npx indexer-cli context`

Output dense project context aggregated from the index. Useful for getting a concise overview of a codebase area
without pulling in entire files.

| Option                | Default | Description                                                     |
|-----------------------|---------|-----------------------------------------------------------------|
| `--txt`               | —       | Output results as human-readable text                           |
| `--scope <scope>`     | all     | `all`, `changed` (uncommitted changes), or `relevant-to:<path>` |
| `--max-deps <number>` | 30      | Maximum number of dependency edges to output                    |
| `--include-fixtures`  | —       | Include fixture/vendor paths in output                          |

### `npx indexer-cli context-pack <task>`

Build a token-aware routing pack for a coding task. The command selects likely modules, explains why they were chosen,
returns a compact architecture and structure slice, and suggests the next files to read before deeper exploration.

| Option                 | Default   | Description                                                      |
|------------------------|-----------|------------------------------------------------------------------|
| `--budget <number>`    | profile   | Token budget: `800`, `1500`, or `2500`                           |
| `--profile <profile>`  | balanced  | `routing`, `balanced`, or `deep`                                 |
| `--scope <scope>`      | all       | `all`, `changed`, `relevant-to:<path>`, or `path-prefix:<path>`  |
| `--max-modules <n>`    | profile   | Maximum number of routed modules                                 |
| `--max-files <n>`      | profile   | Maximum number of files in the structure slice                   |
| `--max-snippets <n>`   | profile   | Maximum number of semantic evidence snippets                     |
| `--min-score <number>` | —         | Filter out semantic hits below this score (0..1)                 |
| `--explain-symbols`    | —         | Include symbol signatures in the pack output                     |
| `--txt`                | —         | Output as human-readable text                                    |

Budget profiles are tuned for agent workflows:

- `routing` (~800 tokens): selected scope, module goals, next reads
- `balanced` (~1500 tokens): routing plus compact structure and architecture slices
- `deep` (~2500 tokens): balanced output plus evidence snippets when confidence is low or investigation is deeper

### `npx indexer-cli explain <symbol>`

Show context for a symbol: its signature, callers, and containing module. Use this to quickly understand what a
specific function, class, or type does and how it is used.

| Option  | Description                   |
|---------|-------------------------------|
| `--txt` | Output as human-readable text |

### `npx indexer-cli deps <path>`

Show callers (who imports this) and callees (what this imports) for a module or symbol. Useful for tracing impact
of changes and understanding dependency chains.

| Option              | Default | Description                     |
|---------------------|---------|---------------------------------|
| `--direction <dir>` | both    | `callers`, `callees`, or `both` |
| `--depth <n>`       | 1       | Traversal depth                 |
| `--txt`             | —       | Output as human-readable text   |

### `npx indexer-cli uninstall`

Remove the `.indexer-cli/` directory from the current working directory. Also removes the generated
`.claude/skills/` directories created by `indexer-cli` when present. Prompts for confirmation unless `-f` is given.

## License

MIT
