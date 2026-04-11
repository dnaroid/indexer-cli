# Plan: Remove JSON output — text-only for all discovery commands

**Date**: 2026-04-12
**Status**: Draft
**Scope**: `src/cli/commands/`, `src/cli/output-mode.ts`, skills, tests, README

## Context

All 6 discovery commands (`search`, `structure`, `architecture`, `context`, `explain`, `deps`) currently default to
JSON output with an optional `--txt` flag for human-readable text. Measurements on this project (255 files, 1122
chunks) show text output is 1.3–20x more compact than JSON, with `architecture` being the worst offender (8000 chars
JSON vs 420 chars text). Since the primary consumers are coding agents (not scripts), and agents parse plain text
more efficiently than JSON, we are removing JSON output entirely and making text the only format.

## Affected commands

| Command          | `--txt` flag | `isJsonOutput` usage | `JSON.stringify` calls              |
|------------------|--------------|----------------------|-------------------------------------|
| `search`         | yes          | yes                  | 2 (output + error)                  |
| `structure`      | yes          | yes                  | 2 (output + error)                  |
| `architecture`   | yes          | yes                  | 2 (output + error)                  |
| `context`        | yes          | yes                  | 2 (output + error)                  |
| `explain`        | yes          | yes                  | 3 (symbol output, not-found, error) |
| `deps`           | yes          | yes                  | 2 (output + error)                  |
| `index --status` | yes          | yes                  | 2 (status output, not-found)        |

## Files to modify

### Core

- `src/cli/output-mode.ts` — delete entirely

### Commands

- `src/cli/commands/deps.ts`
- `src/cli/commands/explain.ts`
- `src/cli/commands/architecture.ts`
- `src/cli/commands/structure.ts`
- `src/cli/commands/context.ts`
- `src/cli/commands/search.ts`
- `src/cli/commands/index.ts`

### Skills

- `src/cli/commands/skills.ts`

### Tests

- `tests/unit/cli/output-mode.test.ts` — delete
- `tests/unit/cli/output-contract.test.ts` — update
- `tests/unit/cli/quality-fixes.test.ts` — verify (uses `loadInternals` to extract internal functions, no direct JSON output assertions — likely no changes needed)
- `tests/cli/commands.test.ts` — major update (806 lines, TypeScript e2e)
- `tests/cli/commands-csharp.test.ts` — major update (930 lines)
- `tests/cli/commands-gdscript.test.ts` — major update (772 lines)
- `tests/cli/commands-python.test.ts` — major update (867 lines)
- `tests/cli/commands-ruby.test.ts` — major update (948 lines)

### Docs

- `README.md`

---

## Execution plan

### Phase 1: Delete output-mode.ts

Delete `src/cli/output-mode.ts` entirely. It exports only:
- `OutputModeOptions` type (`{ txt?: boolean }`)
- `isJsonOutput(options?) => !options?.txt`

All commands import `isJsonOutput` from this file — Phase 2 removes those imports.

### Phase 2: Command-by-command text-only conversion

Every command follows the same 6-step mechanical pattern:

1. Remove `import { isJsonOutput } from "../output-mode.js";`
2. Remove `.option("--txt", ...)` from the command definition
3. Remove `txt?: boolean` from the options type
4. Remove `const isJson = isJsonOutput(options);`
5. Change `ensureIndexed(metadata, resolvedProjectPath, { silent: isJson })` to `{ silent: false }` — always show
   indexing progress now
6. Remove all `if (isJson) { JSON.stringify } else { text }` branches, keeping only the text path
7. In catch blocks: remove `if (isJson)` error branches, keep only `console.error(...)`

Beyond this common pattern, each command has unique changes:

---

#### Step 1: `deps.ts` (low complexity)

**Common changes only** — no extra work beyond the 7-step pattern.

The file currently has:
- Line 8: `import { isJsonOutput }`
- Line 22: `.option("--txt", ...)`
- Line 29: `txt?: boolean` in type
- Line 35: `const isJson = isJsonOutput(options)`
- Line 45: `{ silent: isJson }`
- Lines 139-142: JSON output branch (`console.log(JSON.stringify(result, null, 2))`)
- Lines 170-174: JSON error branch in catch

After cleanup: `isJson` variable removed, only text output path remains.

---

#### Step 2: `explain.ts` (low complexity)

**Common changes** + 3 JSON branches:

1. **Not-found branch** (~lines 158-181): Remove `console.log(JSON.stringify({error: "Symbol not found", suggestions: fuzzy}))` path, keep only `console.error(...)` with "Did you mean" text
2. **Results output** (~lines 221-230): Remove `console.log(JSON.stringify(results.length === 1 ? results[0] : results))` path, keep only the text for-loop
3. **Error catch** (~lines 260-267): Remove JSON error branch

---

#### Step 3: `architecture.ts` (medium complexity)

**Common changes** + `formatPlain()` already exists as standalone function:

1. Output section (~line 247-251): Replace `if (isJson) { console.log(JSON.stringify(visibleArchitecture)) } else { formatPlain(visibleArchitecture) }` with just `formatPlain(visibleArchitecture);`
2. Error catch (~lines 252-259): Remove JSON error branch

---

#### Step 4: `structure.ts` (medium complexity)

**Common changes** + **delete 2 large JSON-only functions**:

1. **DELETE `treeToJson()` function** (~lines 241-332) — 91 lines, only used for JSON output
2. **DELETE `narrowJsonTreeToPathPrefix()` function** (~lines 334-391) — 57 lines, only used for JSON tree navigation
3. Empty files check (~lines 470-477): Remove `console.log("[]")` branch, keep only `console.log("No indexed files found for the requested filters.")`
4. Output section (~lines 484-517): Remove entire `if (isJson)` block including `let tree = treeToJson(...)`, `narrowJsonTreeToPathPrefix(tree, ...)`, `console.log(JSON.stringify(tree))`. Keep only the `printTree(...)` path

---

#### Step 5: `context.ts` (medium-high complexity)

**Common changes** + `estimateTokens` rewrite + remove `_meta` object:

1. **Rewrite `estimateTokens()`** — currently does `JSON.stringify(data).length / 4`. Replace with text-based estimate:
   ```typescript
   function estimateTokens(data: ContextData): number {
     let charCount = 0;
     charCount += Object.entries(data.architecture.fileStats).map(([k, v]) => `${k}: ${v}`).join(", ").length;
     charCount += data.architecture.entrypoints.join(", ").length;
     for (const mod of data.modules) charCount += mod.path.length + 1;
     for (const sym of data.symbols) {
       charCount += `${sym.file}::${sym.name} (${sym.kind})${sym.signature ? ` — ${sym.signature}` : ""}`.length + 1;
     }
     for (const [from, to] of Object.entries(data.dependencies)) {
       charCount += `${from} -> ${to.join(", ")}`.length + 1;
     }
     return Math.ceil(charCount / 4);
   }
   ```
2. **Remove `ContextOutputMeta` type** — no longer needed
3. **Remove truncation warning `isJson` guard** (~line 303-309): Change `if (!isJson) { console.error(...) }` to just `console.error(...)`
4. **Remove scopeWarning `isJson` guard** (~line 336-338): Change `if (!isJson && scopeWarning)` to `if (scopeWarning)`
5. **Remove `_meta` / `outputData` construction** (~lines 340-362): Delete the `meta` object, `outputData` object, and `estimateTokens(outputData)` calls. Replace with simple `const estimatedTokens = estimateTokens(contextData);`
6. **Remove JSON output branch** (~lines 364-374): Delete `console.log(JSON.stringify(outputData))`, keep only `formatPlain(contextData)` + estimated tokens line

---

#### Step 6: `search.ts` (high complexity)

**Common changes** + **delete 5 JSON-specific functions/types** + **remove 3 options**:

1. **Remove options**:
   - `--fields <list>` — only useful in JSON mode for field projection
   - `--omit-content` — token-saving shorthand, now default behavior
   - `--txt` — no longer needed
2. **Delete JSON-specific code**:
   - `SEARCH_FIELDS` constant and `SearchField` type
   - `SearchOutputOptions` type (had `isJson` field)
   - `parseSearchFields()` function
   - `isDefaultFieldSelection()` function
   - `projectSearchResult()` function
   - `resolveOutputFields()` function
   - `formatCustomPlainSummary()` function
3. **Simplify search call**: `includeContent: options?.includeContent ?? false`
4. **Simplify text output loop** — since no custom fields, always use the default compact format:
   ```typescript
   for (let i = 0; i < results.length; i++) {
     if (i > 0) console.log("---");
     const result = results[i];
     const symbolPart = result.primarySymbol ? `, function: ${result.primarySymbol}` : "";
     console.log(`${result.filePath}:${result.startLine}-${result.endLine} (score: ${result.score.toFixed(2)}${symbolPart})`);
     if (options?.includeContent) {
       console.log(result.content || "(content unavailable)");
     }
   }
   ```
5. Empty results: remove `console.log("[]")`, keep only `console.log("No results found.")`

---

#### Step 7: `index.ts` — `--status` path only (low complexity)

**Common changes** — only the `--status` code path uses JSON:

1. No-snapshot check (~lines 103-111): Remove `console.log(JSON.stringify({indexed: false}))`, keep only text message
2. Status output (~lines 149-172): Remove entire `if (isJson)` block with the JSON `output` object construction. Keep only the text status output (snapshot, created, files, languages, symbolKinds console.log lines)
3. `--tree` text path already works — no changes needed there

---

### Phase 3: Skills update

In `src/cli/commands/skills.ts`:

#### Template-based skills (5 skills)

Each has `cliReference` array entries to update:

**repo-structure** (~line 226-229):
- Remove: `"Output: JSON by default; use --txt for human-readable text."`
- Change: `"Options: --path-prefix <string>, --kind <string>, --max-depth <number>, --max-files <number>, --txt."` → `"Options: --path-prefix <string>, --kind <string>, --max-depth <number>, --max-files <number>."`
- Remove rule: `"Use JSON output for agents unless a human explicitly asks for text."`

**repo-architecture** (~line 257-259):
- Remove: `"Output: JSON by default; use --txt for human-readable text."`
- Change: `"Options: --path-prefix <string>, --include-fixtures, --txt."` → `"Options: --path-prefix <string>, --include-fixtures."`
- Remove rule: `"Use JSON output to preserve structured dependency data."`

**repo-context** (~line 287-289):
- Remove: `"Output: JSON by default; use --txt for human-readable text."`
- Change: `"Options: --scope <scope>, --max-deps <number>, --include-fixtures, --txt."` → `"Options: --scope <scope>, --max-deps <number>, --include-fixtures."`

**symbol-explain** (~line 317-320):
- Remove: `"Output: JSON by default; use --txt for human-readable text."`
- Change: `"Options: --txt."` → remove the entire options line (nothing left without `--txt`)

**dependency-trace** (~line 349-354):
- Remove: `"Output: JSON by default; use --txt for human-readable text."`
- Change: `"Options: --direction <dir>, --depth <n>, --txt."` → `"Options: --direction <dir>, --depth <n>."`

#### `semantic-search` rawContent (~lines 72-192)

This is a multi-line string literal. Changes:

1. **Remove `--fields` references**: The two-phase pattern currently says `--fields filePath,startLine,endLine,primarySymbol`. In text mode this is implicit — remove `--fields` from all command samples and references.
2. **Simplify content instructions**: Remove `--omit-content` references. Simplify to: "Default: no content. Use `--include-content` when you need code."
3. **Update CLI reference section** (~line 170-182):
   - Remove `--fields` from options list
   - Remove `--omit-content` from options list
   - Remove "Allowed `--fields`" section
   - Keep: `--max-files`, `--path-prefix`, `--chunk-types`, `--min-score`, `--include-content`, `--include-imports`
4. **Update command patterns** (~lines 157-166):
   - Remove `--fields filePath,startLine,endLine,primarySymbol` from all commands
   - Phase 1 discover command becomes: `npx indexer-cli search "prize"`
   - Keep `--include-content` for the rare exception case

---

### Phase 4: Test updates

#### 4.1 Delete `tests/unit/cli/output-mode.test.ts`

14-line file testing `isJsonOutput()`. Entire file deleted.

#### 4.2 Update `tests/unit/cli/output-contract.test.ts`

Currently has 3 tests:

1. **"uses --txt instead of --json"** — checks all 7 commands contain `.option("--txt"` and don't contain `--json`.
   **Rewrite** to verify:
   - No command contains `--txt` option
   - No command contains `isJsonOutput` import
   - No command contains `JSON.stringify` in output paths (grep for `console.log(JSON.stringify` in command files)
2. **"removes the legacy context --format option"** — currently checks for `isJsonOutput` usage.
   **Update**: Remove `expect(source).toContain("const isJson = isJsonOutput(options);")` check.
3. **"uses the renamed search --max-files option consistently"** — no changes needed.

#### 4.3 `tests/unit/cli/quality-fixes.test.ts`

This file uses `loadInternals` to extract and test internal functions (`formatPlain`, `printTree`, `isTestFile`).
**No changes needed** — it tests internal formatting functions, not JSON/text output branching.

#### 4.4 E2e test files (5 files — major rewrite)

All 5 test files follow the same pattern and need the same structural changes:

- `tests/cli/commands.test.ts` (806 lines) — TypeScript fixtures
- `tests/cli/commands-csharp.test.ts` (930 lines) — C# fixtures
- `tests/cli/commands-gdscript.test.ts` (772 lines) — GDScript fixtures
- `tests/cli/commands-python.test.ts` (867 lines) — Python fixtures
- `tests/cli/commands-ruby.test.ts` (948 lines) — Ruby fixtures

**Current pattern** — tests use `runJsonCommand<T>()` helper that:
1. Runs CLI command
2. Parses stdout as JSON
3. Returns typed object
4. Asserts on fields

**New pattern** — tests use `runCLI()` directly and assert on text output patterns.

**Shared type definitions to remove** (present in all 5 files):
- `SearchResult` type (`filePath, score, content?, primarySymbol?`)
- `StructureEntry` type (`type, name?, path?, children?, symbols?, hiddenFiles?`)
- `parseJson<T>()` helper
- `runJsonCommand<T>()` helper
- `flattenFiles()` helper (for structure tree traversal)

**Changes per test section**:

##### `index --status` tests
- Current: `runJsonCommand<{indexed, stats, languages}>(["index", "--status"])` then field assertions
- New: `runCLI(["index", "--status"])` then text pattern assertions:
  ```
  expect(result.stdout).toContain("Files: 31")
  expect(result.stdout).toContain("Symbols:")
  expect(result.stdout).toContain("Chunks:")
  ```
- Tree test: `runCLI(["index", "--status", "--tree"])` then `expect(result.stdout).toContain("src/index.ts")`

##### `search` tests
- Current: `runJsonCommand<SearchResult[]>(["search", "auth session", ...])` then `results[0].filePath` assertions
- New: `runCLI(["search", "auth session", ...])` then parse text output. Helper function needed:
  ```typescript
  function parseSearchResults(output: string): Array<{filePath: string; score: number; primarySymbol?: string}> {
    return output.split("---").map(block => {
      const lines = block.trim().split("\n");
      const match = lines[0]?.match(/^(.+?):(\d+)-(\d+) \(score: ([\d.]+)(?:, function: (.+?))?\)$/);
      if (!match) return null;
      return { filePath: match[1], score: parseFloat(match[4]), primarySymbol: match[5] };
    }).filter(Boolean) as Array<{filePath: string; score: number; primarySymbol?: string}>;
  }
  ```
- `--include-content` test: check that content appears in output when flag is present, absent when not
- `--path-prefix` test: check all result lines start with the prefix

##### `structure` tests
- Current: `runJsonCommand<StructureEntry[]>(["structure"])` then tree traversal with `flattenFiles()`
- New: `runCLI(["structure"])` then text pattern assertions
- `--kind` filter: run with `--kind class`, check output contains class names but not function names
- `--path-prefix`: check only matching paths appear in output
- **Note**: Structure text output uses indentation (`src/`, `  file.ts`, `    symbolName (kind)`). Parse by checking
  presence/absence of strings.

##### `architecture` tests
- Current: `runJsonCommand<{file_stats, entrypoints, dependency_map}>(["architecture"])` then field assertions
- New: `runCLI(["architecture"])` then text pattern assertions:
  ```
  expect(result.stdout).toContain("File stats by language")
  expect(result.stdout).toContain("typescript: 31")
  expect(result.stdout).toContain("src/index.ts")  // in Entrypoints section
  ```
- `--path-prefix`: check scoped output

##### `context` tests
- Current: `runJsonCommand<{architecture, modules, symbols, dependencies, _meta}>(["context"])` then field assertions
- New: `runCLI(["context"])` then text pattern assertions:
  ```
  expect(result.stdout).toContain("## Architecture")
  expect(result.stdout).toContain("## Key Symbols")
  ```
- `--scope changed`: check output contains the changed file
- `--max-deps`: check truncation warning in stderr

##### `explain` tests
- Current: `runJsonCommand<{name, kind, file, lines, callers, callees}>(["explain", "createSession"])` then field assertions
- New: `runCLI(["explain", "createSession"])` then text pattern assertions:
  ```
  expect(result.stdout).toContain("Symbol: createSession")
  expect(result.stdout).toContain("Kind:   function")
  expect(result.stdout).toContain("src/auth/session.ts")
  ```
- Multiple results test: check output contains both files
- File::symbol disambiguation: check correct file shown
- Error test: check stderr for "not found"

##### `deps` tests
- Current: `runJsonCommand<{path, callers, callees}>(["deps", "src/services/user.ts"])` then field assertions
- New: `runCLI(["deps", "src/services/user.ts"])` then text pattern assertions:
  ```
  expect(result.stdout).toContain("Module: src/services/user.ts")
  expect(result.stdout).toContain("src/index.ts")  // in Callers section
  ```
- `--direction callers/callees`: check appropriate section appears
- `--depth 2`: check deeper paths appear

---

### Phase 5: README & docs

In `README.md`:

1. **Remove `--txt` rows** from all command option tables (index, search, structure, architecture, context, explain, deps)
2. **Remove `--fields` row** from search options table
3. **Remove `--omit-content` row** from search options table
4. **Update Quick Start example**: Change `npx indexer-cli search "authentication middleware" --txt` to `npx indexer-cli search "authentication middleware"`
5. **Update Agent Integration section**: Remove "By default, discovery commands now return JSON. Use `--txt` whenever you want human-readable output instead." and the surrounding text about JSON/text choice
6. **Update search description**: Remove "search returns JSON by default. In JSON mode, content is omitted unless you pass --include-content; use --txt for the older human-readable layout."
7. **Update `--include-content` description** in search table: Change from "Include `content` in JSON output" to "Include matched code content in output (omitted by default to save tokens)"

---

## Risk assessment

| Risk                                             | Mitigation                                                                                                                                     |
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| External tools parsing JSON output               | Search codebase for consumers: grep for `indexer-cli` in scripts, CI configs, other repos. The `--json` flag can be added back later if needed |
| CLI integration tests break                      | Phase 4 handles this explicitly                                                                                                                |
| `search --fields` removal breaks workflows       | `--fields` is only useful in JSON mode. In text mode, all fields are always shown compactly. No real consumer impact                           |
| `context` token estimation uses `JSON.stringify` | The `estimateTokens` helper rewritten to use text-based character count instead                                                                |
| E2e test rewrites are error-prone                | All 5 E2e test files follow identical patterns — standardize the text-parsing helpers and apply consistently                                  |

## Out of scope

- `--quiet` flag (separate change — suppress indexing progress noise)
- Token estimates in other commands (separate change)
- `context` default scope change (separate change)
- Any changes to indexing logic or chunking
- `quality-fixes.test.ts` (no JSON-specific assertions, uses internal function extraction only)
