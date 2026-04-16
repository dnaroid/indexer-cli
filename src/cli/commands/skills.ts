export type GeneratedSkill = {
	name: string;
	directory: string;
	content: string;
};

export const GENERATED_SKILLS: GeneratedSkill[] = [
	{
		name: "repo-discovery",
		directory: "repo-discovery",
		content: `---
name: repo-discovery
description: FIRST choice for repository discovery and code understanding. Use this to choose the cheapest indexed path for architecture, structure, behavior, symbol, or dependency questions before broad file reads or grep.
allowed-tools: Bash(idx architecture:*), Bash(idx structure:*), Bash(idx search:*), Bash(idx explain:*), Bash(idx deps:*)
---

# Use repo-discovery as the indexed entry point

Use this skill first for unfamiliar codebases, high-level exploration, behavior tracing, symbol discovery, or impact analysis.

Pick the single cheapest command that answers the question, run it, and stop when you have enough context.

## Route to one command

- \`idx architecture\` — repo shape, entry points, module boundaries
- \`idx structure\` — file trees, exported symbols, contents of a directory/module
- \`idx search\` — conceptual behavior questions like "how does X work?"
- \`idx explain\` — a known symbol when you want indexed explanation
- \`idx deps\` — callers, callees, or impact for a known path/module

## Operating rules

- Start with exactly **ONE** idx command. Each idx result is large; parallel or overlapping discovery burns tokens on duplicate context.
- Prefer the cheapest route that fits the question. Only run a second idx command if the first clearly failed or left a specific gap.
- Use \`--path-prefix\` whenever the subsystem is known, e.g. \`src/api/\`, \`src/auth/\`.
- For \`idx structure\`, also narrow with \`--kind\` when possible.
- For \`idx deps\`, start with \`--depth 1\`; increase only if first-hop impact is insufficient.
- For \`idx explain\`, prefer \`file::symbol\` when the name may be ambiguous.
- \`--include-content\` is expensive. Use it only when you need implementation detail *without* planning to \`Read\`; if you'll read files anyway, skip it.
- After \`idx search\`, read the returned files/ranges. Do **not** follow search with \`idx explain\` on the same results.
- Do **not** run \`idx explain\` as a prelude to reading a file you already know you need.
- Do **not** chain discovery steps mechanically (\`search → explain\`, \`explain → Read\`) when direct reading is cheaper.

## Use idx vs grep/LSP

idx is **semantic** search: use it when you do **not** know the exact name and need to find code by meaning.

Use \`grep\`/LSP when the target is already concrete:
- exact identifier name → \`grep\`, \`lsp_symbols\`, or references/definition tools
- exact file path → \`Read\`
- known file + known symbol → \`idx explain file::symbol\` or LSP if exact lookup is enough

Rule of thumb: if you can write an exact search pattern, use \`grep\`/LSP. Use idx for exploration, not lookup.

## Query guidance

- Good \`idx search\` queries are specific concepts, not generic phrases.
- Broad natural-language queries produce noise across unrelated files.
- Prefer domain-specific wording over vague phrases like \`"validate data"\` or \`"send notification"\`.
- Pair broad concepts with \`--path-prefix\` and cap output with \`--max-files\` when exploring large areas.

## Examples

\`\`\`bash
# Good: high-level repo shape
idx architecture --path-prefix src/

# Good: inspect one subsystem
idx structure --path-prefix src/api/ --kind function

# Good: semantic discovery for unknown behavior
idx search "how request retries are scheduled" --path-prefix src/jobs/ --max-files 5

# Good: explain a known symbol, scoped to a file
idx explain src/api/client.ts::createClient

# Good: first-hop impact from a known module
idx deps src/api/client.ts --direction callers --depth 1

# Bad: semantic search for an exact identifier
idx search "MyType" --path-prefix src/models/

# Better: exact lookup is cheaper
grep "MyType" src/models/
\`\`\`

## Skip idx when

- you already know the exact file to read
- you need an exact identifier lookup
- you already know the file and want document-local symbols/usages
- you are done discovering and are now editing or validating code

## CLI reference

- Architecture: \`idx architecture [--path-prefix <area>] [--include-fixtures]\`
- Structure: \`idx structure [--path-prefix <area>] [--kind <kind>] [--max-depth <n>] [--max-files <n>] [--include-internal] [--include-fixtures] [--no-tests]\`
- Search: \`idx search <query> [--max-files <n>] [--path-prefix <area>] [--chunk-types <types>] [--min-score <score>] [--include-content] [--include-imports]\`
- Explain: \`idx explain <symbol|file::symbol> [--path-prefix <area>] [--include-fixtures]\`
- Deps: \`idx deps <path> [--direction callers|callees|both] [--depth <n>]\`
`,
	},
];

export const DEPRECATED_SKILL_DIRECTORIES = [
	"context-pack",
	"semantic-search",
	"repo-structure",
	"repo-architecture",
	"symbol-explain",
	"dependency-trace",
];

export const GENERATED_SKILL_DIRECTORIES = GENERATED_SKILLS.map(
	(skill) => skill.directory,
);
