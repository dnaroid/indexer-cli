<div align="center">

# indexer-cli

**Local-first semantic code search, repository discovery, and project knowledge for coding agents.**

Index once. Give Claude, OpenCode, and other coding agents the right context without burning tokens on blind searches.

[![npm version](https://img.shields.io/npm/v/indexer-cli?logo=npm&color=cb3837)](https://www.npmjs.com/package/indexer-cli)
[![npm downloads](https://img.shields.io/npm/dm/indexer-cli?logo=npm)](https://www.npmjs.com/package/indexer-cli)
[![Node.js](https://img.shields.io/node/v/indexer-cli?logo=node.js)](https://www.npmjs.com/package/indexer-cli)
[![License: MIT](https://img.shields.io/npm/l/indexer-cli)](https://github.com/dnaroid/indexer-cli/blob/master/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/dnaroid/indexer-cli?style=flat&logo=github)](https://github.com/dnaroid/indexer-cli)

[npm](https://www.npmjs.com/package/indexer-cli) · [GitHub](https://github.com/dnaroid/indexer-cli) · [Issues](https://github.com/dnaroid/indexer-cli/issues)

</div>

```bash
npm install -g indexer-cli@latest
idx setup
```

Then, inside any Git repository:

```bash
idx init
idx index
idx search "authentication middleware"
idx context "how authentication refresh works"
```

> **Local by default:** source code and embeddings stay in your project. Embeddings are generated through your local
> [Ollama](https://ollama.com/) instance and stored under `.indexer-cli/`.

## Overview

The main feature of `indexer-cli` is not just search on its own: it turns your repository into something coding agents
can navigate efficiently. `idx init` initializes the local index without changing any agent configuration by default.
When you want a project-local discovery skill, opt in explicitly with `--claude`, `--codex`, or both so the selected
agent can pick the right indexed workflow instead of wasting tokens on blind `rg`/`grep`, `find`, and repeated file reads.

Under the hood, `indexer-cli` indexes source code plus document-domain knowledge, generates vector embeddings through a
local Ollama instance, and stores everything in a per-project `.indexer-cli/` directory. Code and documents remain
separate search domains by default. That gives both humans and agents fast natural-language code search, project
contract/spec retrieval, repo structure snapshots, and low-friction incremental reindexing without any daemon or
background service. A Git post-commit hook keeps deterministic index state up to date automatically; semantic
classification and verification remain explicit agent actions.

## Features

- **Optional code-agent repo skill**: `idx init --claude` and/or `idx init --codex` install one focused autonomous
  discovery skill only for the selected agent targets
- **`idx` command alias**: `setup` installs or repairs a clean `idx` wrapper — no npm warnings in agent output
- **Token savings for agents**: Pushes agents toward indexed discovery instead of expensive blind search and repeated
  context loading
- **Multi-language support**: TypeScript/JavaScript, Python, C#, GDScript, Ruby, Rust, C/C++, Svelte
- **Semantic code search**: Natural language queries over your entire codebase
- **Project knowledge/wiki**: Discover, classify, search, relate, and verify behavioral specs/contracts without a second
  state directory
- **Knowledge-aware context packs**: `idx context` combines primary contracts, freshness, implementation ranges, and
  relevant tests under a token budget
- **Spec/code impact checks**: `idx wiki impact` combines durable relations, changed paths, dependency context, and
  semantic candidates while leaving final semantic decisions to the agent
- **Incremental indexing**: Uses `git diff` to re-index only changed files, bulk-copies unchanged vectors
- **Local-first**: All data stored in `.indexer-cli/` inside the project (SQLite + sqlite-vec)
- **Ollama-powered embeddings**: Uses `jina-8k` for code and multilingual `nomic-embed-text-v2-moe` for project
  knowledge; both use 768-dim vectors in the local sqlite-vec store
- **Architecture snapshot**: Generates dependency graphs, entry points, and file stats
- **Symbol extraction**: Functions, classes, interfaces, and imports are all indexed
- **Adaptive chunking**: Smart code splitting at function, module, or single-file granularity

## Prerequisites

- [Ollama](https://ollama.ai) installed manually. `idx setup` will verify it, start the daemon if needed,
  and prepare both the code (`jina-8k`) and multilingual knowledge (`nomic-embed-text-v2-moe`) embedding models.
- Node.js >=22.19.0 and <27, plus build tools (python3, make, C++ compiler) for native dependencies.

The source checkout uses the active `node` and `npm` from your `PATH`; no Node
major is pinned by this repository. Because native addons are installed locally,
if you intentionally switch Node majors, rebuild the checkout once with
`rm -rf node_modules && npm ci`.

The `setup` command handles global installation automatically: it installs indexer-cli via npm and ensures the
`idx` wrapper is on your PATH.

## Quick Start

### Installation

```bash
# Recommended: global install
npm install -g indexer-cli@latest
idx --version

# First-time dependency/bootstrap setup
idx setup

# Alternative: run via npx (no install needed)
npx indexer-cli@latest setup
```

When installing the current source checkout globally on macOS, use `npm run install:global`.
That developer command prefers a conventional system Node installation (for
example Homebrew's `/opt/homebrew/bin/node`) when available and compatible,
otherwise it falls back to the active `node`/`npm` from `PATH`. It does not
require a particular Node major beyond the public engine range. The resulting
global launcher stays bound to the selected system Node path so switching nvm,
mise, or another version manager later cannot create a native-addon ABI mismatch.

On Linux, `npm install -g indexer-cli@latest` now installs both `idx` and `indexer-cli`
into your npm global `bin` directory immediately. If `idx` is still not found, verify your
npm global bin path is on `PATH`:

```bash
npm config get prefix
echo "$PATH"
which idx || true
which indexer-cli || true
```

For user-local npm prefixes such as `~/.npm-global`, ensure `<prefix>/bin` is exported in your shell profile.
`idx setup`/`idx doctor` may also repair the compatibility wrapper in `~/.local/bin/idx`, but the primary
global npm install should no longer depend on that wrapper.

### Usage

```bash
# 1. Install globally and confirm the main CLI is available
npm install -g indexer-cli@latest
idx --version

# 2. Run dependency setup (may start Ollama and prepare the embedding model)
idx setup

# 3. Initialize indexing (no agent skill is installed by default)
cd /path/to/your/project
idx init

# Optional: enable one or both project-local agent integrations
idx init --claude
idx init --codex
# or: idx init --claude --codex

# 4. Index code and document-domain knowledge
idx index

# 5. Search semantically yourself
idx search "authentication middleware"

# 6. Ask for a behavior-aware context pack
idx context "how authentication refresh works"
```

After `idx init`, you can run project commands from subdirectories too: `indexer-cli` will detect the initialized
project root automatically. If a project has not been initialized yet, commands such as `idx search` and `idx index`
stop with a clear message telling you to run `idx init` first instead of creating data in the wrong directory.

When enabled, the generated skill is written to the selected agent's canonical project-local location:

- Claude Code: `.claude/skills/repo-discovery/SKILL.md`
- OpenAI Codex: `.agents/skills/repo-discovery/SKILL.md`

Both variants use the same generated guidance and route agents toward `idx context`, `idx wiki`, `idx search`,
`idx structure`, `idx ast`, `idx architecture`, `idx explain`, and `idx deps` before they start burning tokens on broad
filesystem scans.

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

Agent integration is explicit. Plain `idx init` creates no agent skill directories. Use:

```bash
idx init --claude          # .claude/skills/repo-discovery/SKILL.md
idx init --codex           # .agents/skills/repo-discovery/SKILL.md
idx init --claude --codex  # install both
```

For an already initialized project, install the same integrations later without
re-running initialization:

```bash
idx skills install --claude
idx skills install --codex
idx skills install --claude --codex
idx skills status
idx skills refresh
```

The selected target is persisted in `.indexer-cli/config.json` as `skillTargets`. Future skill-version refreshes update
only those enabled targets. Re-running plain `idx init` neither installs a new integration nor disables an existing one.
`idx init --refresh-skills` refreshes only already enabled targets; combining it with `--claude` and/or `--codex` enables
those targets explicitly and refreshes the resulting set.

That skill routes repository discovery flows such as:

```bash
idx context "how session refresh works"
idx wiki search "session refresh contract"
idx wiki impact src/auth/session.ts src/auth/refresh-worker.ts
idx search "<query>"
idx structure --path-prefix src/<area>
idx ast src/<large-file.ts>
idx architecture
```

For material behavior-changing work, the generated skill also treats project
knowledge maintenance as part of task completion rather than a separate manual
cleanup step. The agent should find the governing primary contract before or
during implementation, update it in the same task (or create a focused primary
spec when no suitable authority exists), then run task-scoped
`idx wiki impact <changed-paths...>`, review uncovered/new/moved knowledge, repair
only evidence-backed relations, and run `idx wiki verify` only after checking the
final primary source against the relevant implementation/tests. Mechanical edits
that do not change project behavior skip this lifecycle, and a reviewed no-impact
result is valid.

`idx wiki record` never means "verified": newly classified or newly created
primary knowledge stays unverified until semantic evidence review establishes a
baseline. Likewise, changed code never rewrites spec semantics automatically;
non-fresh states such as `inputs-changed`, `spec-changed`, and `missing-source`
remain explicit review obligations.

All discovery commands return human-readable text output, optimized for coding agents.

This is especially useful in Claude Code and OpenAI Codex setups, where project-local skills can guide the agent away
from blind `rg`/`grep`/`find` usage and toward indexed discovery, which usually means less wasted context and lower token
usage during repo discovery.

## CLI Commands

### `idx setup`

Install indexer-cli globally via npm, check system prerequisites, prepare the Ollama embedding model, and install
or repair the `idx` command alias in `~/.local/bin/`. `setup` can install some system tools where appropriate, but
Ollama itself must be installed manually first. Works on macOS and Linux.

After running `setup`, restart your shell to ensure `idx` is on `PATH`.

### `idx init`

Create the `.indexer-cli/` directory, initialize the SQLite database and sqlite-vec vector store, add `.indexer-cli/`
to `.gitignore`, and install a Git post-commit hook that automatically re-indexes changed files. Agent skills are
opt-in: `--claude` writes under `.claude/skills/`, `--codex` writes under `.agents/skills/`, and only idx-generated
`repo-discovery` skill directories are added to `.gitignore`. Plain `idx init` never adds agent/context paths such as
`.claude/`, `.agents/`, `CLAUDE.md`, or `AGENTS.md`. The first run may also start Ollama and download/create the `jina-8k` embedding model, so
initial setup can take time.

When run from a subdirectory of a Git project, `idx init` automatically initializes the Git project root.

| Option              | Description                                                                                 |
|---------------------|---------------------------------------------------------------------------------------------|
| `--claude`          | Install/enable `repo-discovery` under `.claude/skills/`                                     |
| `--codex`           | Install/enable `repo-discovery` under `.agents/skills/`                                     |
| `--refresh-skills`  | Refresh only enabled skill targets (plus targets explicitly supplied in this invocation)   |

### `idx skills`

Manage project-local coding-agent integrations for the current initialized
project. This command does not initialize or re-index the project.

```bash
idx skills install --claude
idx skills install --codex
idx skills install --claude --codex
idx skills status
idx skills refresh
```

`install` is additive and persists the selected targets in
`.indexer-cli/config.json`. `refresh` rewrites only enabled targets. `status` is
read-only and reports both configured targets and generated skills currently
present on disk.

### `idx index`

Index all supported source files and document-domain knowledge files in the current working directory. Normal code
commands still read only the code domain unless a knowledge/context command explicitly combines domains.

Indexing respects the project root `.gitignore` plus built-in excludes such as `node_modules`, `.git`, `dist`, and
`coverage`. If the root `.gitignore` changes, the next incremental run rescans the indexable file set, removes newly
ignored files from the snapshot, and indexes only files that became visible or otherwise changed.

You can persist index path masks in `.indexer-cli/config.json` with `idx index --include <path>` and
remove them again with `idx index --exclude <path>`. `indexIncludePaths` are additive: matching files are indexed even
when `.gitignore` would hide them. Masks accept project-root-relative paths or globs such as `generated/keep.ts`,
`generated/**`, or `vendor/**`; changing masks forces a full reindex on that run.
Symlinked directories are skipped by default and followed only when the symlink path matches an include mask.
New configs also include an empty `indexExcludePaths` list so the available index path-mask fields are visible.

`.indexer-cli/config.json` also contains `visibilityExcludePaths` (fixtures/vendor by default). These masks hide
matching files from discovery output such as `idx architecture` and `idx structure`; they do not change what is indexed.

Document-domain indexing is configured separately with:

- `documentExtensions` — default `.md`, `.mdx`, `.rst`, `.adoc`, `.txt`;
- `documentIncludePaths` — force document paths/globs into knowledge indexing;
- `documentExcludePaths` — exclude fixture/eval/example/skill-resource noise by default;
- `documentMaxBytes` — maximum document size to embed.
- `knowledgeEmbeddingModel` — multilingual document/wiki embedding model;
- `knowledgeEmbeddingQueryPrefix` / `knowledgeEmbeddingDocumentPrefix` — retrieval prefixes used by the knowledge
  embedding model.

Document indexing is deterministic. It updates file hashes/chunks/vectors only; it never classifies a document as an
authoritative contract and never creates a semantic verification baseline by itself.

If you run `idx index` from a subdirectory of an initialized project, the CLI automatically reuses the initialized
project root. If no `.indexer-cli/` data exists yet, it stops and tells you to run `idx init` first.

Only one indexing process writes at a time. Discovery commands that auto-index, such as `idx context`, `idx wiki`,
`idx search`, `idx structure`, `idx architecture`, `idx explain`, and `idx deps`, wait up to 10 seconds when another
process holds the index lock. If
the lock is still held and a completed snapshot already exists, they continue with that existing index and print an
`IDX stale reason=lock-held action=using-existing-index` diagnostic. If the lock file itself is older than the stale
threshold, the diagnostic uses `reason=stale-lock`; read commands still do not remove or recover the lock. Run
`idx index` to recover or rebuild when there is no completed snapshot to fall back to.

| Option      | Description                                                |
|-------------|------------------------------------------------------------|
| `--full`    | Force a full reindex instead of incremental                |
| `--dry-run` | Preview what would be indexed without writing index data   |
| `--status`  | Show indexing status for the current project               |
| `--tree`    | Show indexed file tree (use with `--status`)               |
| `--include <path>` | Add a path/glob mask to index even when matched by `.gitignore` |
| `--exclude <path>` | Remove a path/glob mask from the persisted include list |

### `idx context <query>`

Build a compact project context pack that prioritizes primary knowledge/contracts and then adds implementation ranges,
first-hop dependency context, relevant tests, freshness warnings, and `Read next:` hints.

```bash
idx context "how session refresh retries work" --budget 1800
idx context "payment cancellation" --path-prefix src/payments/
```

| Option                    | Default | Description                                      |
|---------------------------|---------|--------------------------------------------------|
| `--budget <tokens>`       | 1400    | Approximate output token budget                  |
| `--max-specs <number>`    | 4       | Maximum primary knowledge results                |
| `--max-code <number>`     | 6       | Maximum implementation paths/ranges              |
| `--max-tests <number>`    | 4       | Maximum relevant test hints                      |
| `--path-prefix <path>`    | —       | Limit implementation discovery to a code area    |
| `--include-secondary`     | —       | Allow `design-only` secondary knowledge retrieval |

The command reports non-fresh knowledge explicitly. Registered knowledge and
indexed unclassified documents are trusted by default for retrieval, but
`unverified`, `spec-changed`, `inputs-changed`, and `unreviewed` remain warnings
that verification/classification may be absent or stale. A fresh repository can
therefore answer from indexed Markdown before any `wiki record` step. Default
trust never changes freshness or creates registered primary knowledge.

### `idx wiki`

Maintain the project behavioral knowledge layer. Primary source documents remain authoritative; SQLite metadata,
summaries, vectors, catalogs, and search rankings are derived navigation state.

Core commands:

```bash
idx wiki discover
idx wiki record --path docs/auth.md --classification spec --type as-is --lifecycle active \
  --summary "Authentication session and refresh contract." --topic auth --topic sessions
idx wiki prepare --path docs/auth.md --output auth-review.json
# Review the source and evidence; fill the receipt's reviewer, rationale and bindings.
idx wiki verify --path docs/auth.md --receipt auth-review.json
idx wiki trust --all --rationale "Imported project documentation is trusted"
idx wiki trust --path docs/auth.md
idx wiki trust --all --clear # return to default trust policy
idx wiki relate --path docs/auth.md --add-code src/auth/refresh.ts
idx wiki status
idx wiki audit
idx wiki catalog
idx wiki search "почему refresh token повторяется"
idx wiki impact src/auth/refresh.ts src/auth/session.ts
idx wiki review collect src/auth/refresh.ts src/auth/session.ts --scope auth-change
idx wiki review list --scope auth-change
idx wiki check src/auth/refresh.ts src/auth/session.ts --scope auth-change
idx wiki search "refresh" --mode lexical # offline, existing completed index
idx wiki manifest validate --file knowledge.json
idx wiki manifest apply --file knowledge.json
```

Important semantics:

- `record` means semantic classification/index metadata only; it does **not** establish `fresh`;
- registered knowledge is trusted by default for retrieval. `wiki trust`
  records explicit user trust without claiming verification. Explicit trust is
  bound to the current source hash; later source changes fall back to default
  trust and continue to warn. `--clear` removes explicit trust. A current
  attested verification reports `trust=verified`;
- indexed documents that have not been recorded are also trusted by default for
  retrieval and remain clearly `unreviewed`. If a project has no registered
  entries yet, `wiki search`/`context` still use these documents up to their
  normal result limits. `wiki trust --all` reports that state instead of silently
  succeeding on an empty registered catalog;
- `prepare` produces current hashes, not an accepted verification. `verify --receipt` requires an explicitly
  reviewed, versioned receipt bound to current source, relations and evidence. A source changed since `record`
  must be recorded again first. Baseline and receipt are committed atomically;
- freshness describes declared evidence only, not semantic correctness or complete coverage. Caller-attested
  test outcomes are distinct from checks actually executed by the local runner; hashes never prove correctness;
- source, non-gitignored tracked input, or durable relation-map changes invalidate freshness; gitignored code
  relations remain documented but are excluded from verification baselines and emit a warning when added;
- `wiki relate --remove-*` removes matching inferred or source-explicit relations by semantic identity and reports
  unmatched removals as unchanged rather than silently claiming an update; re-recording restores explicit relations
  that remain declared in the source document;
- context packs omit related implementation/test paths that are absent from the current code index;
- `impact` prefers task-scoped paths; uncovered paths require semantic review, but graph/vector similarity never creates
  a durable relation automatically;
- historical/superseded knowledge remains searchable but active knowledge wins ranking ties;
- active as-is specs without effective non-gitignored code/test inputs are reported as relation gaps;
- `review collect` persists hash-bound obligations, including reviewed `no-impact` decisions without invented
  relations. `review resolve` requires a reviewer, rationale and evidence. Changed inputs reopen review;
  `needs-human` remains blocking. `wiki check` recollects and exits nonzero for unresolved obligations;
- optional version-1 JSON manifests provide Git-portable IDs, ownership, assertion declarations and typed
  relations. `manifest export` never exports trusted verification baselines; applying declarations is not verification;
- evidence selectors localize review hints, but an unchanged symbol/section/config selector never hides a changed
  whole-file hash. Untracked one-hop helper changes remain uncovered while surfacing affected contracts;
- when `status`, `audit`, `search`, or `context` finds document candidates, the response distinguishes unclassified
  documents from already-classified documents whose source changed. Unclassified candidates must be read and recorded;
  changed classified candidates remain registered knowledge and require review of their existing classification/metadata.
  `status`/`audit`/`search` JSON exposes separate candidate-category counts, and `--all-unclassified` continues to exclude
  existing entries;
- legacy `.spec-wiki` state is not read, imported, or trusted.

`idx wiki search` fuses independent document-vector and section-level lexical candidates. `--mode lexical` avoids
Ollama and auto-indexing; hybrid retrieval degrades with explicit diagnostics when embeddings are unavailable.
Offline retrieval requires an existing completed index and may use stale indexed text. Live evidence freshness
is checked separately. `--mode semantic` fails rather than silently changing modes. Empty retrieval is not proof
that no relevant contract exists. Multilingual semantic quality still depends on the configured embedding model.

Detailed contracts: [verification](docs/specs/knowledge-verification.md),
[declarations](docs/specs/knowledge-manifest.md), [review](docs/specs/knowledge-review-workflow.md),
[retrieval](docs/specs/knowledge-retrieval.md), [discovery caching](docs/specs/knowledge-discovery.md), and [quality evaluation](docs/specs/knowledge-quality-evaluation.md).

### `idx search <query>`

Run local code retrieval against the indexed codebase. The default `hybrid` mode
unions independent semantic-vector, FTS lexical, symbol-index, and path candidates
before code-aware fusion/ranking; a lexical/symbol/path hit can therefore be found
even when vector retrieval misses it. Automatically re-indexes changed files if needed.

If you run `idx search` from a subdirectory of an initialized project, the CLI automatically reuses the initialized
project root. If no `.indexer-cli/` data exists yet, it stops and tells you to run `idx init` first.

| Option                   | Default | Description                                                                                                  |
|--------------------------|---------|--------------------------------------------------------------------------------------------------------------|
| `--max-files <number>`   | 3       | Number of results to return                                                                                  |
| `--path-prefix <string>` | —       | Limit results to files under this path                                                                       |
| `--chunk-types <string>` | —       | Comma-separated filter. Types: `full_file`, `imports`, `preamble`, `declaration`, `module_section`, `impl`, `types`; aliases: `api`, `impl`, `tests`, `imports` |
| `--mode <mode>`          | hybrid  | Retriever/ranking mode: `hybrid`, `semantic`, `lexical`, or `symbol`                                         |
| `--include-imports`      | —       | Include `imports`/`preamble` chunks (excluded by default)                                                    |
| `--min-score <number>`   | 0.55    | Filter out results below the calibrated final relevance score (`0..1`)                                      |
| `--include-content`      | —       | Include matched code content in output (omitted by default to save tokens)                                   |
| `--dedupe-file`          | —       | Return at most one result per file                                                                           |
| `--dedupe-symbol`        | —       | Return at most one result per file/symbol pair                                                               |
| `--cluster`              | —       | Group nearby similar chunks and show one representative                                                      |
| `--exclude-tests`        | —       | Exclude test files from search results                                                                       |
| `--include-tests`        | —       | Include test files without the default test penalty                                                          |

`hybrid` is true multi-channel retrieval rather than vector-only reranking. `lexical`
uses the local SQLite FTS index, `symbol` uses durable parsed symbols (including
types/classes, not only functions), and lexical/symbol modes do not require a query
embedding when the code index is already current. Query tokenization is Unicode-aware.
Tests are down-ranked after fusion by default so an exact test double does not beat
the production definition merely through lexical/symbol boosts; explicit test intent
or `--include-tests` removes that preference.

`idx search` prints compact diagnostics when a query is likely too broad, a path prefix is missing, or a high
`--min-score` filters every result. Each result includes a line range, `rank=<mode>`, and compact `why=` reason codes.
The final line suggests the cheapest file ranges to read next. Example:

```text
src/cli/commands/search.ts:93-169 (score: 0.91, rank=hybrid, function: registerSearchCommand, why=symbol+path+text+semantic)
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

Remove the `.indexer-cli/` directory from the initialized project root. Also removes this CLI's generated
`repo-discovery` directories from `.claude/skills/` and `.agents/skills/` when present, cleans this CLI's Git hook block,
and removes its `.gitignore` entries when present. User-owned agent context/config entries are preserved for projects
that did not enable idx skills. Prompts for confirmation unless `-f` is given.

Deprecated generated skill directories such as `context-pack` are cleaned up when present.

### `idx doctor [dir]`

Health-check and repair registered indexer projects. Runs system prerequisite checks (same as `idx setup`), then
operates on registered projects. Without arguments, operates on all projects in the global registry
(`~/.indexer-cli/registry.json`) and cleans stale entries. With a directory argument, scans its
subdirectories for `.indexer-cli/`, auto-registers found projects, and operates on them.

| Option              | Description                                      |
|---------------------|--------------------------------------------------|
| `--skills-only`     | Refresh only the skill targets already enabled for each project |
| `-f, --force`       | Skip confirmation prompt                         |

The global registry is maintained automatically: `idx init` registers a project, `idx uninstall` unregisters it.
`idx doctor <dir>` also registers discovered projects.

## Troubleshooting Linux installs

If a fresh global install does not behave as expected:

```bash
npm install -g indexer-cli@latest
which idx || true
which indexer-cli || true
idx --version
idx --no-auto-update doctor /path/to/project
```

- If `which idx` is empty, add your npm global `<prefix>/bin` to `PATH`.
- If first-run setup is slow, Ollama may be starting or the `jina-8k` model may be downloading/being created.
- Use `idx --no-auto-update doctor <projectPath>` to troubleshoot dependencies without also attempting auto-update.

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
