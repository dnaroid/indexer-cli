# indexer-cli

Lightweight CLI project indexer with semantic code search via Ollama.

## Overview

indexer-cli indexes source code in a project, generates vector embeddings through a local Ollama instance, and stores
everything in a per-project `.indexer-cli/` directory. You can then run natural language queries against your codebase
and get relevant results in seconds. It ships as a single package with no daemon or background process to manage.

## Features

- **Multi-language support**: TypeScript/JavaScript, Python, C#, GDScript, Ruby
- **Semantic code search**: Natural language queries over your entire codebase
- **Incremental indexing**: Uses `git diff` to re-index only changed files, bulk-copies unchanged vectors
- **Local-first**: All data stored in `.indexer-cli/` inside the project (SQLite + LanceDB)
- **Ollama-powered embeddings**: Uses `jina-8k` model (768-dim vectors) via a local Ollama instance
- **Architecture snapshot**: Generates dependency graphs, entry points, and file stats
- **Symbol extraction**: Functions, classes, interfaces, and imports are all indexed
- **Adaptive chunking**: Smart code splitting at function, module, or single-file granularity

## Prerequisites

- Node.js 18+
- [Ollama](https://ollama.ai) running locally with the `jina-8k` model pulled:
  ```bash
  ollama pull jina-8k
  ```

## Supported Languages

TypeScript, JavaScript, Python, C#, GDScript, Ruby.

## Installation

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/dnaroid/indexer-cli/main/install.sh | bash
```

Installs into `~/.indexer-cli` by default. Override with `INDEXER_INSTALL_DIR`.

### From source

```bash
git clone <repo-url>
cd indexer-cli
npm install
npm run install:global
```

### Uninstall

```bash
npm run uninstall:global
# or, if installed via install.sh:
rm -rf ~/.indexer-cli
```

## Quick Start

```bash
# 1. Initialize indexing in your project
cd /path/to/your/project
indexer-cli init

# 2. Index the codebase
indexer-cli index

# 3. Search semantically
indexer-cli search "authentication middleware"
```

## CLI Commands

### `indexer-cli setup`

Check and install all dependencies (Node.js, Git, build tools, Ollama, embedding model). Works on macOS and Linux.

### `indexer-cli init`

Create the `.indexer-cli/` directory, initialize the SQLite database and LanceDB vector store, and add `.indexer-cli/`
to `.gitignore` in the current working directory.

### `indexer-cli index`

Index all supported source files in the current working directory.

| Option      | Description                                            |
|-------------|--------------------------------------------------------|
| `--full`    | Force a full reindex instead of incremental            |
| `--dry-run` | Preview what would be indexed without writing anything |
| `--status`  | Show indexing status for the current project           |
| `--tree`    | Show indexed file tree (use with `--status`)           |
| `--json`    | Output status as JSON (use with `--status`)            |

### `indexer-cli search <query>`

Run a semantic search against the indexed codebase. Automatically re-indexes changed files if needed.

| Option                   | Default | Description                                              |
|--------------------------|---------|----------------------------------------------------------|
| `--top-k <number>`       | 10      | Number of results to return                              |
| `--path-prefix <string>` | —       | Limit results to files under this path                   |
| `--chunk-types <string>` | —       | Comma-separated filter: `full_file`, `imports`, `preamble`, `declaration`, `module_section`, `impl`, `types` |
| `--json`                 | —       | Output results as JSON                                   |

### `indexer-cli structure`

Print a file tree annotated with extracted symbols for the current working directory. Automatically re-indexes changed files if needed.

| Option                   | Description                                              |
|--------------------------|----------------------------------------------------------|
| `--path-prefix <string>` | Limit output to files under this path                    |
| `--kind <string>`        | Filter by symbol kind: `function`, `class`, `method`, `interface`, `type`, `variable`, `module`, `signal` |
| `--json`                 | Output structure as JSON                                 |

### `indexer-cli architecture`

Print an architecture snapshot for the current working directory: file statistics, detected entry points, and a dependency graph.

### `indexer-cli uninstall`

Remove the `.indexer-cli/` directory from the current working directory. Prompts for confirmation before deleting.

## License

MIT
