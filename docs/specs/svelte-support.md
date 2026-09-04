# Spec: Svelte language support

## Type

Change

## Goal

Treat `.svelte` components as first-class source files across indexing and discovery commands.

## Scope

- Parse Svelte 5 components with the official compiler parser.
- Extract component, script, and snippet symbols plus static and dynamic imports.
- Create bounded chunks for module scripts, instance scripts, markup, and styles.
- Detect common Svelte and SvelteKit entrypoints.
- Support `.svelte` files in indexing, architecture, AST, and dependency discovery.

## Non-goals

- Compile components or run preprocessors.
- Resolve aliases from `svelte.config.js`, Vite, or TypeScript path mappings.
- Infer runtime component relationships that are not represented by imports.

## Behavior

- Default indexing scans `.svelte` files and records their language as `svelte`.
- Invalid Svelte syntax follows the existing parser-fallback behavior: indexing keeps the file and uses heuristic chunks.
- Symbols include the component itself, declarations in instance/module scripts, component props, and Svelte snippets.
- Imports from both script contexts participate in the existing internal/external dependency graph.
- `idx ast` renders a traversable outline containing script, template, and style nodes.
- Common `App.svelte` and SvelteKit route components can appear as architecture entrypoints.

## Contracts

- Built-in language plugin id: `svelte`.
- Supported extension: `.svelte` (case-insensitive when selecting files).
- Existing CLI output formats remain unchanged; `language=svelte` is a new value.

## Edge cases

- Components may contain no script or style section.
- Instance and module scripts may both be present and may use TypeScript syntax.
- Large component sections must be split within the configured chunk token limit.
- Svelte fragments do not always carry source offsets; child offsets are used for AST display.

## Related files

- `src/languages/svelte.ts`
- `src/engine/indexer.ts`
- `src/engine/dependency-resolver.ts`
- `src/cli/commands/ast.ts`
- `src/cli/commands/index.ts`
- `src/cli/commands/ensure-indexed.ts`

## Verification

- Plugin unit tests for parsing, symbols, imports, chunks, entrypoints, and malformed input.
- Engine tests for default registration, extension scanning, language ids, and dependency resolution.
- CLI AST test for a `.svelte` component.
- Build first, then run focused and full tests and exercise the built CLI through `tsx bin/indexer-cli.js`.

## Risks / unknowns

- Preprocessed languages such as CoffeeScript are intentionally unsupported because parsing happens before preprocessing.
- Svelte compiler AST details may evolve; the traversable view only depends on public node `type`, `start`, and `end` fields.

## Evidence

- Confirmed by code: all indexing and discovery integration points listed above use the language plugin registry or explicit extension lists.
- Confirmed by tests: existing language plugins define the expected parser, symbol, import, chunk, entrypoint, and CLI patterns.
- Confirmed by docs: Svelte 5 `parse(source, { modern: true })` returns the public modern root with module/instance scripts, fragment, and CSS nodes.
