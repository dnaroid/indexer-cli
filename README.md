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
idx ask "how authentication refresh works" --budget 2000
```

> **Local by default:** source code and embeddings stay in your project. Embeddings are generated through your local
> [Ollama](https://ollama.com/) instance and stored under `.indexer-cli/`.
> **Exception:** `idx ask` sends your question and bounded retrieved excerpts to the configured model provider. For discovery without an LLM, use `idx search '<query>' --mode lexical` or the other low-level commands directly.

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
document-purpose inference is optional and advisory.

## Features

- **Optional code-agent repo skill**: `idx init --claude` and/or `idx init --codex` install one focused autonomous
  discovery skill only for the selected agent targets
- **`idx` command alias**: `setup` installs or repairs a clean `idx` wrapper — no npm warnings in agent output
- **Token savings for agents**: Pushes agents toward indexed discovery instead of expensive blind search and repeated
  context loading
- **Multi-language support**: TypeScript/JavaScript, Python, C#, GDScript, Ruby, Rust, C/C++, Svelte
- **Semantic code search**: Natural language queries over your entire codebase
- **Project documents**: Search and retrieve all indexed Markdown alongside code
- **Unified context**: `idx context` combines relevant documents, implementation ranges, and tests under a token budget
- **Task-scoped documentation audit**: `idx audit <changed-paths...>` separates explicit spec declarations from possible document candidates
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

# 5. Start coding-agent discovery with one natural-language request
idx ask "how authentication refresh works" --budget 2000
```

`idx ask '<task>' --budget 2000` is the primary discovery entry point for coding
agents: the model calls read-only idx tools, follows up on gaps, and writes a
coherent answer with references to retrieved evidence. For example,
`idx ask 'What is this project about?'` investigates the repository and explains
its purpose from README first rather than just printing search excerpts. Focused
questions use narrow retrieval and stop once evidence suffices; architecture
is not an automatic prerequisite. Existing commands such
as `idx context`, `idx search`, and `idx structure` remain available directly.
Set `OPENAI_API_KEY` to enable the default `gpt-6-luna` model. Optional
`IDX_ASK_MODEL` and `OPENAI_BASE_URL` override the model and Responses API base.
The loop is bounded to eight model turns, twelve retrieval calls, and two minutes.
`--budget` limits model output tokens (200–20000, default 2000), not evidence pages.
If the model is unavailable or its response is invalid, ask explains the failure
and suggests targeted low-level discovery; insufficient evidence is not
treated as a credentials problem. It does not silently substitute
lexical search. There is no `--no-llm` mode or ask-level `--cursor`.
Setup, initialization, and indexing remain explicit commands;
underlying discovery commands can still refresh their local index as usual.

### Global model and classifier configuration

Installing the npm package creates a commented template at `~/.config/idx/.env`
when absent; `idx doctor` also ensures it exists and prints its path. The same
applies to `$XDG_CONFIG_HOME/idx/.env` when `XDG_CONFIG_HOME` is absolute.
Creation is optional and never overwrites an existing file. All `idx ask` instances for your user read `~/.config/idx/.env`, regardless of
the current repository. If `XDG_CONFIG_HOME` is an absolute path, the file is
`$XDG_CONFIG_HOME/idx/.env` instead. Exported environment variables override the
file, including explicitly empty values. Project-local `.env` files are **not**
loaded, and these settings do not change the embedding provider. The same global
file also configures optional Jev document classification during indexing; that
classifier is independent of the `idx ask` model/provider.

The source installer prints the resolved path. npm may hide postinstall output;
use `npm install -g indexer-cli --foreground-scripts` to see it. If npm lifecycle
scripts are disabled (`--ignore-scripts`), run `idx doctor` to create the template.

All template assignments are commented. Uncomment only settings you use; never
put real credentials in shared/source-controlled files. The file is created
with private permissions (0600):

```dotenv
# Optional advisory document classification via OpenRouter Jev
OPENROUTER_API_KEY=your-openrouter-key
# IDX_JEV_MODEL=~typesafe/jev-latest
# IDX_JEV_URL=https://openrouter.ai/api/alpha/decisions
# IDX_JEV_TIMEOUT_MS=5000
# IDX_JEV_KIND_MIN_CONFIDENCE=0.90
# IDX_JEV_STATUS_MIN_CONFIDENCE=0.65

# ~/.config/idx/.env — direct OpenAI-compatible Responses API (default)
IDX_ASK_BACKEND=openai
OPENAI_API_KEY=your-api-key
IDX_ASK_MODEL=gpt-6-luna
# OPENAI_BASE_URL=https://api.openai.com/v1
```

To use your installed Pi and its saved authentication instead:

```dotenv
IDX_ASK_BACKEND=pi
IDX_PI_PROVIDER=openai-codex
IDX_PI_MODEL=your-model-id
# PI_CODING_AGENT_DIR=/absolute/path/to/custom/pi-agent-directory
```

Install a Pi version exposing `ModelRuntime` (tested against 0.87.1), make `pi`
available on `PATH`, and authenticate in Pi with `/login` if necessary. Set the
provider and exact model ID to an available model shown by Pi's `/model` picker.
Both `IDX_PI_PROVIDER` and `IDX_PI_MODEL` are required; Pi mode does not use
`IDX_ASK_MODEL`. Pi resolves
its own saved OAuth/API credentials; do not copy subscription tokens into this
file. Model access depends on your provider/account.

Pi mode makes ordinary model requests through its SDK, not Pi agent sessions.
Only idx's allowlisted retrieval tools and the current ask conversation are
provided; Pi's own tools, extensions, skills, project instructions, and saved
history are not loaded. Calls run in bounded child processes. idx validates and
executes tool calls itself; no model-authored shell commands are accepted.
Backend configuration or inference failures show the low-level tool guide.
The file uses Node dotenv syntax (quotes/comments supported); values are literal,
without shell execution or variable interpolation. Model inference never writes
this file; installation/doctor only create a missing template.

### Retries and an optional fallback

```dotenv
# Extra attempts for transient inference failures (0–5; default 2)
# IDX_ASK_RETRIES=2

# Fallback is disabled until a fallback model is configured.
# Backend defaults to IDX_ASK_BACKEND; set it explicitly to change backends.
# IDX_ASK_FALLBACK_BACKEND=pi
# IDX_ASK_FALLBACK_PROVIDER=openai-codex
# IDX_ASK_FALLBACK_MODEL=your-fallback-model-id

# Optional overrides for an OpenAI-compatible fallback endpoint
# IDX_ASK_FALLBACK_API_KEY=your-fallback-api-key
# IDX_ASK_FALLBACK_BASE_URL=https://api.openai.com/v1
```

Retries repeat only the failed model request, not completed retrieval tools.
Configuration/invalid-response errors are not transient retries. When the primary
model fails, an explicitly configured fallback is tried and remains selected for
that invocation. Retries and switching are disclosed; the total ask deadline
still applies. Switching models restarts the model conversation from the question
and collected observations, without carrying native provider signatures across
models. If both models fail, ask prints the low-level tool guide.

### Individual model token limits

Pi supplies context/output limits from its model catalog. For OpenAI-compatible
APIs without that metadata, set the limits for your actual models; defaults are
16000 context tokens and 2000 output tokens. Primary and fallback limits are separate:

```dotenv
# IDX_ASK_CONTEXT_TOKENS=16000
# IDX_ASK_MAX_OUTPUT_TOKENS=2000
# IDX_ASK_FALLBACK_CONTEXT_TOKENS=16000
# IDX_ASK_FALLBACK_MAX_OUTPUT_TOKENS=2000
```

Overrides cap known Pi limits. `--budget` requests output tokens per turn, capped
by the selected model; it is not a total spending limit. Context accounting
includes instructions, tool schemas, history, evidence, and output reserve.
Overlarge histories are compacted with a visible notice; fallback recomputes the
limits. Without a tokenizer, input accounting uses a conservative byte estimate,
not exact token usage or billing.

### Answers and evidence

```bash
idx ask "trace authentication, its contract and tests" --budget 2000
```

Each question starts a fresh, in-memory investigation. Answers cite the evidence
collected in that run; citations aid inspection but are not proof that every
generated claim is correct. Retrieval diagnostics, audit notices, and truncation
warnings remain visible independently of the generated answer. Failed or bounded
retrieval is reported as incomplete, not silently presented as exhaustive.
There is no answer pagination or conversation cache. Use individual tools' own
limits and cursors when you need to inspect more results manually.
Ask uses the existing index without automatic reindexing; refresh explicitly with
`idx index` when needed.

After `idx init`, you can run project commands from subdirectories too: `indexer-cli` will detect the initialized
project root automatically. If a project has not been initialized yet, commands such as `idx search` and `idx index`
stop with a clear message telling you to run `idx init` first instead of creating data in the wrong directory.

When enabled, the generated skill is written to the selected agent's canonical project-local location:

- Claude Code: `.claude/skills/repo-discovery/SKILL.md`
- OpenAI Codex: `.agents/skills/repo-discovery/SKILL.md`

Both variants use the same generated guidance and route agents toward `idx context`, `idx search`, `idx search`,
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
idx search "session refresh contract" --domain document
idx audit src/auth/session.ts src/auth/refresh-worker.ts
idx search "<query>"
idx structure --path-prefix src/<area>
idx ast src/<large-file.ts>
idx architecture
```

For material behavior changes, run `idx audit <changed-paths...>`, review explicit
spec matches separately from possible document candidates, and correct genuine
semantic drift. No documentation edits or review ceremony are required when
source documents remain accurate or the change is non-behavioral.

All discovery commands return human-readable text output, optimized for coding agents.

For a coding task, start with `idx ask '<task>' --budget 2000`. It is the primary
natural-language discovery entry point; commands documented below remain
available when you need a specific low-level operation. `ask` investigates through
discovery tools and generates a cited answer—it does not set up, initialize,
acknowledge review, or verify knowledge. Those actions remain explicit. Retrieval
may refresh the local index and reconcile the derived spec registry; ask does not
persist its conversation or an answer cache.

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

File counts and progress include code and documents. `Files indexed` reports
files processed in the current run; unchanged files copied into an incremental
snapshot and deletions are excluded. Full `--dry-run` includes documents too.
Automatic refresh combines document configuration changes with committed and
workspace code changes in the same plan. See the
[code and document indexing contract](docs/specs/code-document-indexing.md).

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
- `documentExcludePaths` — optional document exclusions; empty by default;
- `documentMaxBytes` — maximum document size to embed.
- `knowledgeEmbeddingModel` — multilingual document embedding model;
- `knowledgeEmbeddingQueryPrefix` / `knowledgeEmbeddingDocumentPrefix` — retrieval prefixes used by the knowledge
  embedding model.

Document indexing stores file hashes, chunks, and vectors. When `OPENROUTER_API_KEY`
is configured, it may also use Jev through OpenRouter's Decisions API to infer
advisory document purpose. `IDX_JEV_MODEL`, `IDX_JEV_URL`, and
`IDX_JEV_TIMEOUT_MS` customize that classifier. Explicit frontmatter takes
precedence; inference never makes a document authoritative or excludes it from
retrieval. Jev receives at most 20,000 characters: short documents are sent as-is;
longer documents are represented by bounded frontmatter, heading outline,
beginning, lifecycle/purpose/implementation/test sections, and ending rather than
by a simple leading substring.

Classifier outages do not fail indexing. Missing/failed classifications remain
`unknown`, documents stay searchable, and `idx index` reports a sanitized
degradation summary. Credential/authentication/credit failures require human
action; repeated complete transient degradation is escalated as well. The last
run's advisory classifier health is stored under `.indexer-cli/` and surfaced by
`idx doctor`. Restoring OpenRouter and rerunning `idx index` is sufficient; no
knowledge-base repair is needed.

If you run `idx index` from a subdirectory of an initialized project, the CLI automatically reuses the initialized
project root. If no `.indexer-cli/` data exists yet, it stops and tells you to run `idx init` first.

Only one indexing process writes at a time. Discovery commands that auto-index, such as `idx context`, `idx search`,
`idx structure`, `idx architecture`, `idx explain`, and `idx deps`, wait up to 10 seconds when another
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

Build a compact project context pack with explicit active specs and other relevant documents,
implementation ranges, first-hop dependencies, relevant tests, and `Read next:` hints.

```bash
idx context "how session refresh retries work" --budget 1800
idx context "payment cancellation" --path-prefix src/payments/
```

| Option                    | Default | Description                                      |
|---------------------------|---------|--------------------------------------------------|
| `--budget <tokens>`       | 1400    | Approximate output token budget                  |
| `--max-specs <number>`    | 4       | Maximum entries per document group               |
| `--max-code <number>`     | 6       | Maximum implementation paths/ranges              |
| `--max-tests <number>`    | 4       | Maximum relevant test hints                      |
| `--path-prefix <path>`    | —       | Limit document and code discovery to an area     |
| `--mode <mode>`           | hybrid  | `hybrid`, `semantic`, or offline `lexical`        |

### `idx audit <changed-paths...>`

Reports specs whose explicitly declared `Implementation` or `Tests` paths
intersect this task's changed files, separately from possible candidates found
through ordinary references or retrieval. This is advisory: inspect the source
and fix actual semantic drift; a match does not mean the document is wrong.
No edit or review ceremony is required if the document remains accurate.

Use `--no-semantic` for an offline audit and `--json` for structured output.

All Markdown is eligible for indexing subject to project ignore rules and
configured exclusions. Explicit frontmatter `kind` and `status` take precedence;
optional inferred purpose is advisory, and unknown documents remain searchable
and eligible audit candidates. Recommended specs declare project-root-relative
backticked paths in `Implementation` and `Tests`, optionally with `::Symbol`.

### `idx search <query>`

Retrieve code and documents together (`--domain code` or `--domain document` narrows the search). The default `hybrid` mode
unions independent semantic-vector, FTS lexical, symbol-index, and path candidates
before code-aware fusion/ranking; a lexical/symbol/path hit can therefore be found
even when vector retrieval misses it. Automatically re-indexes changed files if needed.
Explicit `lexical`/`symbol` modes use the existing snapshot offline; run `idx index`
first when it needs refreshing.

If you run `idx search` from a subdirectory of an initialized project, the CLI automatically reuses the initialized
project root. If no `.indexer-cli/` data exists yet, it stops and tells you to run `idx init` first.

| Option                   | Default | Description                                                                                                  |
|--------------------------|---------|--------------------------------------------------------------------------------------------------------------|
| `--max-files <number>`   | 3       | Number of results to return                                                                                  |
| `--domain <domain>`      | all     | Search `all`, `code`, or `document`                                                                          |
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
