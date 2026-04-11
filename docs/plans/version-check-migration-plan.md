# Plan: Version Check with Auto-Migration on CLI Start

## Goal

On every CLI command execution, compare the installed CLI version (`package.json`) with the version stored in `.indexer-cli/config.json`. If the **minor** version component differs (`x.Y.x`), perform a full reinstall: `uninstall -f` + `init`. This ensures embeddings and skills stay in sync with the CLI.

## Current State

| Piece | Location | Notes |
|-------|----------|-------|
| CLI version | `src/cli/version.ts` → reads from `package.json` | exports `VERSION` |
| Package version | `src/core/version.ts` → reads from `package.json` | exports `PACKAGE_VERSION` |
| Config version | `.indexer-cli/config.json` → field `version` | written during `init`, defaults `"0.0.0"` |
| CLI entry point | `src/cli/entry.ts` | registers all commands, calls `program.parse()`, then `checkForUpdates()` |
| `init` command | `src/cli/commands/init.ts` | creates `.indexer-cli/`, writes config with `PACKAGE_VERSION`, installs skills, runs `ensureIndexed()` |
| `uninstall` command | `src/cli/commands/uninstall.ts` | removes `.indexer-cli/`, skills, gitignore entries, post-commit hook (supports `-f` for no-prompt) |
| Existing update check | `src/core/update-check.ts` | checks npm registry for newer version, runs after `program.parse()` |

## Design Decisions

1. **Where to hook**: In `entry.ts`, **before** `program.parse()` — the check runs before any command handler.
2. **Which commands to skip**: `setup` and `uninstall` should NOT trigger migration (setup has no project context; uninstall is destructive).
3. **Comparison rule**: Compare minor segment only (`semver[1]`). Example: `0.3.1` vs `0.4.0` → minor differs → migrate. `0.4.0` vs `0.4.2` → same minor → skip.
4. **Migration flow**: `uninstall -f` → `init`. This is equivalent to a full clean reinstall with fresh embeddings and skills.
5. **Non-interactive**: The migration runs automatically with no prompts (uses `-f` for uninstall).

## Implementation Steps

### Step 1: Create `src/core/version-check.ts`

A new module with a single exported function:

```typescript
/**
 * Compare CLI version with config version.
 * If minor segment differs, run uninstall + init to re-sync.
 *
 * @returns true if migration was performed, false otherwise
 */
export async function checkAndMigrateIfNeeded(): Promise<boolean>
```

**Logic:**

1. Read `VERSION` from `src/cli/version.ts`.
2. Check if `.indexer-cli/config.json` exists in CWD. If not → nothing to migrate (project not initialized).
3. Parse config JSON, extract `version` field. If missing or unparseable → skip.
4. Split both versions by `.` → compare index `[1]` (minor segment).
5. If minor differs:
   - Print: `"indexer-cli: minor version changed (config: X.Y.Z → cli: A.B.C). Re-initializing..."`
   - Execute `uninstall` logic programmatically (not via shell) — reuse the functions already exported from `uninstall.ts`.
   - Execute `init` logic programmatically — reuse the `init` command's core logic.
   - Print: `"indexer-cli: migration complete."`
   - Return `true`.
6. If same minor → return `false`.

**Important**: Do NOT shell out to `indexer-cli uninstall` / `indexer-cli init`. Instead, extract the core logic from both commands into reusable functions and call them directly.

### Step 2: Extract `uninstall` core logic into reusable function

In `src/cli/commands/uninstall.ts`, the action handler contains all the real work. Extract it:

```typescript
/**
 * Perform full uninstall without prompting.
 * Removes .indexer-cli/, skills, gitignore entries, post-commit hook.
 */
export async function performUninstall(projectRoot: string): Promise<void>
```

Keep the existing `registerUninstallCommand` as a thin wrapper that calls `performUninstall` (with the interactive prompt for non-`-f` mode).

### Step 3: Extract `init` core logic into reusable function

In `src/cli/commands/init.ts`, extract:

```typescript
/**
 * Perform full init (create storage, write config, install skills, index).
 */
export async function performInit(projectRoot: string): Promise<void>
```

Keep the existing `registerInitCommand` as a thin wrapper that calls `performInit`.

### Step 4: Wire into `entry.ts`

In `src/cli/entry.ts`, add the version check **before** `program.parse()`:

```typescript
import { checkAndMigrateIfNeeded } from "../core/version-check.js";

// Determine if the current command needs version checking
// (skip for setup, uninstall, and when no subcommand is given)
const skipCommands = new Set(["setup", "uninstall"]);
const userCommand = process.argv[2];

if (!skipCommands.has(userCommand)) {
  await checkAndMigrateIfNeeded();
}

program.parse();
```

**Why before `program.parse()`**: Commander.js resolves the command during `parse()`. We need the check to run before the command handler executes, so the migration completes first. The check is lightweight (read one JSON file, compare two strings), so the overhead is negligible for commands that don't need migration.

### Step 5: Update `init.ts` to always write current version

This already happens — `init.ts` writes `PACKAGE_VERSION` into `config.json`:

```typescript
await writeFile(
  configPath,
  `${JSON.stringify({ ...config.getAll(), version: PACKAGE_VERSION }, null, 2)}\n`,
  "utf8",
);
```

No changes needed here. Just verify that `performInit` also does this.

### Step 6: Add logging

During migration, print clear status messages:

```
indexer-cli: version changed (0.3.0 → 0.4.0). Re-initializing project data...
  Removing .indexer-cli/...
  Removing skills...
  Re-initializing...
  Initialized indexer-cli in /path/to/project
  Indexing (full)...
indexer-cli: migration complete.
```

### Step 7: Error handling

- If migration fails midway, log the error but do NOT crash the CLI. Print a warning suggesting manual `uninstall + init`.
- If `.indexer-cli/` doesn't exist, skip silently (project not initialized).

## Files to Modify

| File | Change |
|------|--------|
| `src/core/version-check.ts` | **New file** — version comparison + migration orchestrator |
| `src/cli/entry.ts` | Add `checkAndMigrateIfNeeded()` call before `program.parse()` |
| `src/cli/commands/uninstall.ts` | Extract `performUninstall()` function |
| `src/cli/commands/init.ts` | Extract `performInit()` function |

## Files NOT to Modify

- `src/core/version.ts` — no changes needed
- `src/cli/version.ts` — no changes needed
- `src/core/update-check.ts` — separate concern (npm registry check)
- `src/core/config.ts` — no changes needed
- Any other command files

## Edge Cases

| Case | Behavior |
|------|----------|
| No `.indexer-cli/` directory | Skip — project not initialized |
| Config exists but no `version` field | Skip — treat as same version |
| Config version is `"0.0.0"` (default) | Minor differs from any real version → migrate |
| Same minor, different patch (e.g. `0.4.0` vs `0.4.2`) | Skip — only minor triggers migration |
| Major version change (e.g. `0.4.0` vs `1.0.0`) | Minor also differs → migrate |
| Migration fails | Log error, suggest manual `uninstall + init`, continue |
| `setup` command | Skip version check (no project context) |
| `uninstall` command | Skip version check (would be circular) |
| No subcommand (`indexer-cli` with no args) | Skip — Commander shows help |

## Testing

1. **Unit test** in `tests/unit/core/version-check.test.ts`:
   - Minor differs → migration triggered
   - Minor same → no migration
   - No config → no migration
   - Config without version → no migration
   - Default `"0.0.0"` → migration triggered

2. **Manual smoke test**:
   - `echo '{"version":"0.3.0"}' > .indexer-cli/config.json`
   - Run `npx indexer-cli search "test"`
   - Verify migration output appears, `.indexer-cli/` is recreated, new config has current version
