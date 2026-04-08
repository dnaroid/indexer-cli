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

## Installation

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/buzz/indexer-cli/main/install.sh | bash
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
indexer init

# 2. Index the codebase
indexer index

# 3. Search semantically
indexer search "authentication middleware"
```

## CLI Commands

### `indexer init [projectPath]`

Create the `.indexer-cli/` directory, initialize the SQLite database and LanceDB vector store, and add `.indexer-cli/`
to `.gitignore`.

### `indexer index [projectPath]`

Index all supported source files in the project.

| Option      | Description                                            |
|-------------|--------------------------------------------------------|
| `--full`    | Force a full reindex instead of incremental            |
| `--dry-run` | Preview what would be indexed without writing anything |

### `indexer search <query>`

Run a semantic search against the indexed codebase.

| Option                   | Default | Description                                              |
|--------------------------|---------|----------------------------------------------------------|
| `--top-k <number>`       | 10      | Number of results to return                              |
| `--path-prefix <string>` | —       | Limit results to files under this path                   |
| `--chunk-types <string>` | —       | Comma-separated filter: `impl`, `types`, `imports`, etc. |

### `indexer structure [projectPath]`

Print a file tree annotated with extracted symbols.

| Option                   | Description                                              |
|--------------------------|----------------------------------------------------------|
| `--path-prefix <string>` | Limit output to files under this path                    |
| `--kind <string>`        | Filter by symbol kind (function, class, interface, etc.) |

### `indexer architecture [projectPath]`

Print an architecture snapshot: file statistics, detected entry points, and a dependency graph.

### `indexer uninstall [projectPath]`

Remove the `.indexer-cli/` directory. Prompts for confirmation before deleting.

## Configuration

All configuration is done through environment variables. Defaults are shown below.

| Variable                         | Default                  | Description                                                  |
|----------------------------------|--------------------------|--------------------------------------------------------------|
| `INDEXER_EMBEDDING_MODEL`        | `jina-8k`                | Ollama model used for embeddings                             |
| `INDEXER_OLLAMA_BASE_URL`        | `http://127.0.0.1:11434` | Ollama API endpoint                                          |
| `INDEXER_OLLAMA_NUM_CTX`         | `512`                    | Context window for embedding requests                        |
| `INDEXER_EMBEDDING_CONTEXT_SIZE` | `8192`                   | Maximum embedding context size in tokens                     |
| `INDEXER_VECTOR_SIZE`            | `768`                    | Vector dimension size                                        |
| `INDEXER_INDEX_CONCURRENCY`      | `1`                      | Number of parallel embedding requests                        |
| `INDEX_BATCH_SIZE`               | `1`                      | Files processed per indexing batch                           |
| `LOG_LEVEL`                      | `info`                   | Logging verbosity: `trace`, `debug`, `info`, `warn`, `error` |

## How It Works

1. **Scan**: Walks the project directory, respecting `.gitignore` rules and filtering by supported file extensions.
2. **Parse**: Language-specific plugins parse the AST and extract symbols, imports, and structure. TypeScript/JS uses
   ts-morph; Python, C#, GDScript, and Ruby use tree-sitter.
3. **Chunk**: An adaptive chunker splits each file into semantic chunks tagged by type: imports, type declarations,
   implementation bodies, or the full file for small sources.
4. **Embed**: Each chunk is sent to Ollama, which produces a 768-dimensional vector. A context overflow guard prevents
   chunks from exceeding the model's token limit.
5. **Store**: Metadata (projects, snapshots, files, chunks, symbols, dependencies) goes into SQLite. Vectors go into
   LanceDB. Both live inside `.indexer-cli/`.
6. **Incremental**: On re-index, `git diff` identifies which files changed. Unchanged file data and vectors are
   bulk-copied to a new snapshot, and only modified files are re-processed.

## Data Storage

```
<project-root>/
└── .indexer-cli/
    ├── db.sqlite          # Metadata (projects, snapshots, files, chunks, symbols, deps)
    ├── vectors/           # LanceDB vector indices
    └── config.json        # Local project config
```

## Supported Languages

| Language                | Extensions                                                   | Parser      |
|-------------------------|--------------------------------------------------------------|-------------|
| TypeScript / JavaScript | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` | ts-morph    |
| Python                  | `.py`, `.pyi`                                                | tree-sitter |
| C#                      | `.cs`                                                        | tree-sitter |
| GDScript                | `.gd`                                                        | tree-sitter |
| Ruby                    | `.rb`                                                        | tree-sitter |

## Adding Another Language

To add a built-in language plugin:

1. Add the parser package and module declaration in `src/languages/tree-sitter-languages.d.ts` if it does not ship types.
2. Create `src/languages/<language>.ts` implementing `parse`, `extractSymbols`, `extractImports`, `splitIntoChunks`, and `getEntrypoints` following the existing plugin contract.
3. Register the plugin in `src/engine/indexer.ts` by updating `BuiltinLanguagePluginId`, `DEFAULT_LANGUAGE_PLUGIN_IDS`, and the built-in factory map.
4. Add realistic fixtures under `fixtures/projects/<project-name>/` and plugin coverage under `tests/plugins/`.
5. Update engine tests and this README so the new built-in language is documented and treated as supported.

## Project Structure

```
src/
├── cli/commands/     # CLI command handlers (init, index, search, structure, architecture, uninstall)
├── core/             # Types, config, logger
├── chunking/         # Adaptive, function-level, module-level, and single-file chunkers
├── embedding/        # Ollama embedding provider
├── engine/           # Indexer, scanner, searcher, architecture generator, git operations
├── languages/        # Language plugins (TS, Python, C#, GDScript, Ruby)
├── storage/          # SQLite metadata store, LanceDB vector store
└── utils/            # Gitignore parser, hashing, token estimation
```

## License

MIT
