# Fixture and E2E CLI Test Contract

This document defines the contract for creating fixture projects and CLI e2e tests with semantic traps. Follow these rules when adding fixtures for new language plugins.

## Directory Structure

```
fixtures/projects/
  e2e-app/              ← Full app fixture for CLI e2e tests (TypeScript)
  typescript-basic/     ← Minimal fixture for plugin unit tests
  python-basic/         ← Minimal fixture for plugin unit tests
  godot-basic/          ← Minimal fixture for plugin unit tests
  unity-csharp-basic/   ← Minimal fixture for plugin unit tests
  ruby-basic/           ← Minimal fixture for plugin unit tests
```

Each `*-basic/` fixture is a minimal project for testing one language plugin's parse/extractSymbols/extractImports/splitIntoChunks/getEntrypoints. The `e2e-app/` fixture is a realistic multi-module project for testing all CLI commands end-to-end.

## Two Fixture Systems

### Plugin Unit Test Fixtures (`*-basic/`)

- **Purpose**: Test language plugin methods in isolation
- **Helper**: `tests/helpers/fixture-loader.ts` — `readFixtureAsSource(relativePath)`
- **Tests**: `tests/plugins/<language>.test.ts`
- **Size**: 3-5 files, minimal code, no imports between modules
- **Requirements**: Each file must be syntactically valid in the target language

### CLI E2E Test Fixtures (`e2e-app/`)

- **Purpose**: Test all CLI commands against a realistic project
- **Helper**: `tests/helpers/cli-runner.ts` — `createTempProject(tempDir)` copies fixture to temp dir
- **Tests**: `tests/cli/commands.test.ts`
- **Size**: 25-50 files, realistic cross-module imports, semantic traps
- **Requirements**: Realistic code with intentional edge cases (see below)

## Fixture Categories

A CLI e2e fixture must contain files from all three categories:

### 1. Domain-Specific Files (Traps)

Files that test semantic disambiguation — same concept name in different domains. The indexer must correctly distinguish them via context, not just string matching.

| Trap Type | Example | What It Tests |
|-----------|---------|---------------|
| **Ambiguous type names** | `Session` in auth vs game vs inventory | `explain` returns correct file, `search` ranks by domain |
| **Duplicate function names** | `handleRequest` in api/v1 vs api/v2 | `explain` returns multiple results or uses `file::symbol` |
| **Cross-cutting names** | `validateInput` in user vs payment vs order | `search` distinguishes domain context |
| **Interface vs implementation** | `PaymentProcessor` interface + Stripe/PayPal impls | `structure --kind interface`, `explain` returns both |
| **Error hierarchies** | `AppError` → `NotFoundError`, `ValidationError`, `AuthError` | `search "error handling"` finds base class |
| **Naming traps** | `formatDate` (dates not strings), `Status` in 3 domains | `search` and `explain` disambiguate correctly |

### 2. Background Noise Files

Infrastructure files unrelated to trap domains. They dilute search density so that relevant results are a small fraction of the codebase (as in real projects).

**Requirements**:
- 10-15 files minimum
- Realistic code (not stubs), ~15-40 lines each
- May import from each other but NOT from trap files
- Cover typical project infrastructure: middleware, types, constants, helpers, db, queue

**Example categories**: `middleware/`, `types/`, `constants/`, `helpers/`, `db/`, `queue/`

### 3. Structural Trap Files

Files that exercise dependency resolution and project structure commands.

| Trap Type | Example | What It Tests |
|-----------|---------|---------------|
| **Circular dependencies** | `workers/email.ts` ↔ `workers/notification.ts` | `deps` doesn't infinite-loop on cycles |
| **Cross-domain links** | `inventory/manager.ts` → `services/order.ts` | `deps` traverses module boundaries |
| **Deep nesting** | `api/v1/handler.ts`, `api/v2/handler.ts` | `structure --max-depth`, `--path-prefix` on nested paths |
| **Same-named files** | `handler.ts` in two directories | `structure` distinguishes by full path |
| **Multiple entrypoints** | Entry file + `workers/email.ts` (has `main()`) | `architecture` detects all entrypoints |
| **Isolated modules** | `game/session.ts` (no imports from other traps) | `deps` correctly shows no callers |

## Fixture File Requirements

### Content Rules

1. **Syntactically valid** — every file must parse without errors in its language
2. **Realistic substance** — 15-80 lines per file, not 3-line stubs
3. **Real imports** — use actual relative imports between files (`../utils/errors`, `./processor`)
4. **Type annotations** where the language supports them (TypeScript, Python, C#)
5. **Exported symbols** — functions, classes, interfaces, types that the indexer can discover
6. **No external dependencies** — only standard library imports

### Import Graph Rules

```
Domain files ──import──→ Shared utils (errors, logger, format)
Domain files ──import──→ Other domain files (cross-domain traps)
Background files ──import──→ Other background files only
Background files ──✗──→ Domain files (never)
```

Background files must be isolated from trap files so they don't inflate semantic relevance scores.

## CLI E2E Test Structure

All e2e tests live in `tests/cli/commands.test.ts` inside a single `describe.sequential` block. Tests run in strict order sharing one temp project.

### Required Test Sequence

```
init → index --full → search → structure → architecture → context → explain → deps → uninstall
```

Each block tests the corresponding CLI command. Tests must assert on specific fixture data, not just "something was returned".

### Test Helpers

```typescript
import { createTempProject, runCLI, fileExists, readTextFile, gitInit, removeTempProject } from "../helpers/cli-runner";

const TEMP_DIR = path.join(os.tmpdir(), "indexer-cli-e2e-test");

beforeAll(() => {
    removeTempProject(TEMP_DIR);
    createTempProject(TEMP_DIR);
    gitInit(TEMP_DIR);
});

afterAll(() => {
    removeTempProject(TEMP_DIR);
});
```

### Search Test Pattern

Search tests must verify semantic disambiguation, not just "results exist":

```typescript
it("matches auth session queries more strongly than game session", () => {
    const results = runJsonCommand<SearchResult[]>([
        "search", "auth session login token user access", "--max-files", "6"
    ]);

    const authIndex = firstResultIndex(results, "src/auth/session.ts");
    const gameIndex = firstResultIndex(results, "src/game/session.ts");

    expect(authIndex).toBeGreaterThanOrEqual(0);
    if (gameIndex >= 0) {
        expect(authIndex).toBeLessThan(gameIndex);
    }
});
```

Key patterns:
- Use `firstResultIndex` to find specific files in results
- Always handle the case where the wrong-domain file might not appear (`if (gameIndex >= 0)`)
- Assert correct file ranks higher, not exact position
- Use specific multi-word queries that target a domain

### Explain Test Pattern

```typescript
it("returns multiple results for ambiguous symbols", () => {
    const result = runCLI(["explain", "handleRequest"], { cwd: TEMP_DIR });
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    const items = Array.isArray(output) ? output : [output];
    const files = items.map((item: { file: string }) => item.file);
    expect(files).toContain("src/api/v1/handler.ts");
    expect(files).toContain("src/api/v2/handler.ts");
});

it("disambiguates via file::symbol syntax", () => {
    const output = runJsonCommand<{ name: string; file: string }>([
        "explain", "src/inventory/tracker.ts::Status"
    ]);
    expect(output.file).toBe("src/inventory/tracker.ts");
});
```

### Deps Test Pattern

```typescript
it("handles circular dependencies", () => {
    const output = runJsonCommand<{ callers: string[]; callees: string[] }>(
        ["deps", "src/workers/email.ts"]
    );
    expect(output.callers).toContain("src/workers/notification.ts");
    expect(output.callees).toContain("src/workers/notification.ts");
});
```

### Required Test Coverage Per Command

| Command | Required Tests |
|---------|---------------|
| `init` | Creates DB, config, .gitignore, skills, hook. Idempotent. |
| `index` | `--full` indexes all files. `--status` shows correct counts. `--tree` lists files. `--dry-run` no-ops. |
| `search` | Semantic trap disambiguation (≥2 tests). `--max-files`, `--include-content`, `--min-score`, `--txt`, `--path-prefix`. Noise filtering. |
| `structure` | JSON tree with symbols. `--kind` filter (class, function, interface). `--txt`. `--path-prefix`. Deep nesting. Same-named files. |
| `architecture` | File stats, entrypoints, dependency_map. `--txt`. `--path-prefix`. Multiple entrypoints. |
| `context` | JSON with symbols/modules/deps. `--txt`. `--scope changed`. `--max-deps`. Cross-domain scope. |
| `explain` | Known symbol. `file::symbol`. Multiple results for ambiguous. Unknown symbol error. `--txt`. |
| `deps` | Callers + callees. `--direction callers/callees`. `--depth`. Circular deps. Cross-domain. `--txt`. |
| `uninstall` | Removes data, skills, gitignore, hook. Idempotent. |

## Adding a New Language E2E Fixture

When adding e2e tests for a new language plugin:

### 1. Create the fixture project

```
fixtures/projects/e2e-<language>/
```

Follow the same three-category structure: domain traps, background noise, structural traps. Adapt the patterns to the target language's idioms.

### 2. Create a new test helper

```
tests/helpers/cli-runner-<language>.ts
```

With a `FIXTURES_E2E` constant pointing to the new fixture dir and a `createTempProject(tempDir)` that copies it.

### 3. Create the test file

```
tests/cli/commands-<language>.test.ts
```

Using `describe.sequential` with the same command sequence. Adapt assertions to the language's symbol types (e.g., Python has no interfaces, GDScript uses `class_name`).

### 4. Add the test script

In `package.json`:
```json
"test:cli:<lang>": "vitest run tests/cli/commands-<language>/ --testTimeout=180000 --no-file-parallelism"
```

### 5. File counts

Every test that asserts file counts must be updated when the fixture changes. Use named constants:

```typescript
const FIXTURE_FILE_COUNT = 31;
```

## Semantic Search Trap Checklist

When designing trap files, verify each trap:

- [ ] **Ambiguous name** exists in ≥2 unrelated files (same symbol name, different domain)
- [ ] **Search query** for domain A returns file A ranked above file B
- [ ] **Search query** for domain B returns file B ranked above file A
- [ ] **Explain** for ambiguous name returns multiple results or can disambiguate via `file::symbol`
- [ ] **Circular dependency** exists between ≥2 files — `deps` handles without error
- [ ] **Cross-domain import** exists — `deps` shows it in callers/callees
- [ ] **Second entrypoint** exists — `architecture` detects it
- [ ] **Deep nesting** (≥3 levels) — `structure --max-depth` respects it
- [ ] **Background files** are isolated (no imports to/from trap files)
- [ ] **Background file count** is ≥40% of total files (ensures search density is realistic)
