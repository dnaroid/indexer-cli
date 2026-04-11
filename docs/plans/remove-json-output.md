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

- `src/cli/output-mode.ts` — delete entirely (or reduce to a no-op if other non-discovery commands still reference it)

### Commands (remove `isJsonOutput` branch, remove `--txt` option, keep only text path)

- `src/cli/commands/search.ts`
- `src/cli/commands/structure.ts`
- `src/cli/commands/architecture.ts`
- `src/cli/commands/context.ts`
- `src/cli/commands/explain.ts`
- `src/cli/commands/deps.ts`
- `src/cli/commands/index.ts` (only `--status` path uses JSON)

### Skills (remove "JSON by default; use --txt" references)

- `src/cli/commands/skills.ts` — update `cliReference` fields in all skill definitions; `semantic-search` rawContent

### Tests

- `tests/unit/cli/output-mode.test.ts` — delete (tests `isJsonOutput` which will be removed)
- `tests/unit/cli/output-contract.test.ts` — update: remove `--txt` presence check, remove `isJsonOutput` check, add
  test that no `JSON.stringify` remains in command output paths
- `tests/cli/commands*.test.ts` (5 files) — any assertions on JSON output format need updating to text format
- `tests/unit/cli/quality-fixes.test.ts` — may reference JSON output assertions

### Docs

- `README.md` — remove all `--txt` option rows from command tables, update examples

## Execution plan

### Phase 1: Output mode infrastructure (low risk)

1. **Delete `src/cli/output-mode.ts`**
2. **Remove all `import { isJsonOutput }` from commands**
3. **Remove `--txt` option definitions from all commands**
4. Run `npm run test` — expect compile errors in commands (unused variables, missing branch). This is expected; Phase 2
   fixes them.

### Phase 2: Command-by-command text-only conversion

Process each command independently. For each:

1. Remove the `if (isJson) { ... } else { ... }` branching
2. Keep only the text-formatting path (the current `--txt` code path)
3. Remove `JSON.stringify` from the output path (keep error handling but simplify)
4. Verify with `npx indexer-cli <command>` that output is correct
5. Run related tests

**Order** (simplest to most complex):

| Step | Command          | Complexity  | Notes                                                                                                                                                                                            |
|------|------------------|-------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1    | `deps`           | Low         | Simple callers/callees output, no complex formatting                                                                                                                                             |
| 2    | `explain`        | Low         | Single symbol output, already compact in text                                                                                                                                                    |
| 3    | `architecture`   | Medium      | Text path is straightforward, but JSON dumps huge `dependency_map` — just delete that path                                                                                                       |
| 4    | `structure`      | Medium      | Text tree is already good; JSON tree is redundant                                                                                                                                                |
| 5    | `context`        | Medium-High | Has `estimateTokens`, scoped output, dependency limiting — ensure text path handles all scopes                                                                                                   |
| 6    | `search`         | High        | Most options (`--fields`, `--chunk-types`, `--include-content`). Text path needs to respect `--fields` filtering. `--omit-content`/`--include-content` semantics need to carry over to text mode |
| 7    | `index --status` | Low         | Only the `--status` sub-path uses JSON; text path already exists                                                                                                                                 |

### Phase 3: Search-specific considerations

`search` is the most complex command. Current JSON mode supports:

- `--fields` selection (filePath, startLine, endLine, score, primarySymbol, content)
- `--omit-content` / `--include-content`
- `--min-score` filtering

In text-only mode:

- **Default**: compact output — file path, line range, score, primary symbol, no content
- **`--include-content`**: append content block after metadata
- **`--fields`**: no longer needed in text mode — text output always shows the same fields (path, lines, score, symbol,
  optional content). Remove `--fields` option.
- **`--min-score`**: keep as-is, applies before output

### Phase 4: Skills update

In `src/cli/commands/skills.ts`:

1. **Template-based skills** (repo-structure, repo-architecture, repo-context, symbol-explain, dependency-trace):
    - Remove `"Output: JSON by default; use --txt for human-readable text."` from all `cliReference` arrays
    - Remove `"--txt"` from options lists

2. **`semantic-search` rawContent**:
    - Remove `--fields` references (fields are implicit in text mode)
    - Remove `--omit-content` / `--include-content` complexity — simplify to: "default: no content. Add
      `--include-content` when you need code."
    - Keep two-phase retrieval pattern

### Phase 5: Test updates

1. **Delete** `tests/unit/cli/output-mode.test.ts`
2. **Update** `tests/unit/cli/output-contract.test.ts`:
    - Remove `--txt` presence check
    - Remove `isJsonOutput` check
    - Add: verify no `JSON.stringify` in command output paths (grep for `console.log(JSON.stringify`)
3. **Update** CLI integration tests (`tests/cli/commands*.test.ts`):
    - Change JSON output assertions to text output assertions
    - These tests run actual CLI subprocesses — verify text output format matches expected patterns
4. **Update** `tests/unit/cli/quality-fixes.test.ts` if it references JSON output

### Phase 6: README & docs

1. Remove all `--txt` rows from command option tables
2. Update examples: remove `--txt` from example commands
3. Remove "JSON by default" mentions
4. Update the Agent Integration section — text is now the only format

## Risk assessment

| Risk                                             | Mitigation                                                                                                                                     |
|--------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| External tools parsing JSON output               | Search codebase for consumers: grep for `indexer-cli` in scripts, CI configs, other repos. The `--json` flag can be added back later if needed |
| CLI integration tests break                      | Phase 5 handles this explicitly                                                                                                                |
| `search --fields` removal breaks workflows       | `--fields` is only useful in JSON mode. In text mode, all fields are always shown compactly. No real consumer impact                           |
| `context` token estimation uses `JSON.stringify` | The `estimateTokens` helper in `context.ts` uses `JSON.stringify(data).length / 4`. Replace with character count of the text output            |

## Out of scope

- `--quiet` flag (separate change — suppress indexing progress noise)
- Token estimates in other commands (separate change)
- `context` default scope change (separate change)
- Any changes to indexing logic or chunking
