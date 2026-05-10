export type GeneratedSkill = {
	name: string;
	directory: string;
	content: string;
};

function buildRepoDiscoverySkillContent(): string {
	return `---
name: repo-discovery
description: FIRST choice for repository discovery and code understanding. Use this to choose the cheapest indexed path for architecture, structure, behavior, symbol, AST, or dependency questions before broad file reads or blind text search.
allowed-tools: Bash(idx architecture:*), Bash(idx structure:*), Bash(idx ast:*), Bash(idx search:*), Bash(idx explain:*), Bash(idx deps:*), Bash(rg:*), Bash(grep:*)
---

# Use repo-discovery as the indexed entry point

Use this skill first for unfamiliar codebases, high-level exploration, behavior tracing, symbol discovery, or impact analysis.

Pick the single cheapest command that answers the question, run it, and stop when you have enough context.

## Route to one command

- \`idx architecture\` — repo shape, entry points, module boundaries, cycle causes, unresolved dependency classes
- \`idx structure\` — file trees, exported symbols with line ranges, contents of a directory/module
- \`idx ast <file>\` — compact syntax tree for one large file; use before repeated reads when ranges are coarse or JSX/parent structure matters
- \`idx search\` — conceptual behavior questions like "how does X work?"; returns ranked file ranges plus \`why=\` reason codes
- \`idx explain\` — a known symbol when you want indexed explanation
- \`idx deps\` — imported-by/imports for a known path/module, or callers/callees for a known callable symbol with \`--mode calls\`

## Operating rules

- Start with exactly **ONE** idx command. Each idx result is large; parallel or overlapping discovery burns tokens on duplicate context.
- Prefer the cheapest route that fits the question. Only run a second idx command if the first clearly failed or left a specific gap.
- Use \`--path-prefix\` whenever the subsystem is known, e.g. \`src/api/\`, \`src/auth/\`.
- For \`idx structure\`, also narrow with \`--kind\` when possible.
- If \`idx structure\` prints \`TRUNC\`/\`NEXT\`, run the \`NEXT\` command only when the hidden page is still relevant.
- Use \`idx ast <file>\` after you know a large file is relevant and need a map before reading ranges; if you are about to make a second overlapping \`Read\` on that file, run \`idx ast\` first.
- If \`idx ast\` prints \`TRUNC\`/\`NEXT\`, run \`NEXT\` only when the hidden nodes are still relevant.
- For \`idx deps\`, start with \`--depth 1\`; use \`--mode calls path::symbol\` when module imports are too coarse; increase depth only if first-hop impact is insufficient.
- For \`idx explain\`, prefer \`file::symbol\` when the name may be ambiguous.
- \`--include-content\` is expensive. Use it only when you need implementation detail *without* planning to \`Read\`; if you'll read files anyway, skip it.
- After \`idx search\`, read the returned files/ranges. Do **not** follow search with \`idx explain\` on the same results.
- Use \`Read next:\` from \`idx search\` as the default next file/range selection unless you have a better reason.
- Do **not** run \`idx explain\` as a prelude to reading a file you already know you need.
- Do **not** chain discovery steps mechanically (\`search → explain\`, \`explain → Read\`) when direct reading is cheaper.

## Use idx vs exact text search/LSP

idx is **semantic** search: use it when you do **not** know the exact name and need to find code by meaning.

Use exact text search/LSP when the target is already concrete:
- exact identifier name → \`rg\` (preferred), \`grep\`, \`lsp_symbols\`, or references/definition tools
- exact small file path → \`Read\`
- exact large file path + unknown internal layout or nested JSX → \`idx ast <file>\`, then read the smallest ranges
- known file + known symbol → \`idx explain file::symbol\` or LSP if exact lookup is enough

Rule of thumb: avoid broad blind \`rg\`/\`grep\`/\`find\` during discovery, but if you can write an exact search pattern, use \`rg\`/LSP. Use idx for exploration, not lookup.

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

# Good: reduce noisy search output before choosing files to read
idx search "auth session token validation" --dedupe-file --exclude-tests --max-files 5

# Good: focus search on public API/type chunks
idx search "payment processor interface" --chunk-types api --mode hybrid

# Good: continue a capped structure page only if more files are needed
idx structure --path-prefix src --max-depth 2 --max-files 20 --cursor 20

# Good: map one large file before choosing exact Read ranges
idx ast src/api/client.ts --max-depth 4 --max-nodes 80

# Good: explain a known symbol, scoped to a file
idx explain src/api/client.ts::createClient

# Good: first-hop import impact from a known module
idx deps src/api/client.ts --direction callers --depth 1

# Good: inspect the import specifier behind dependency edges
idx deps src/api/client.ts --show-edges

# Good: trace symbol-level callers/callees when module deps are too coarse
idx deps src/api/client.ts::createClient --mode calls --direction both --depth 1

# Bad: semantic search for an exact identifier
idx search "MyType" --path-prefix src/models/

# Better: exact lookup is cheaper
rg -n "MyType" src/models/
\`\`\`

## Skip idx when

- you already know the exact small file/range to read
- you need an exact identifier lookup
- you already know the file and want document-local symbols/usages
- you are done discovering and are now editing or validating code

## CLI reference

- Architecture: \`idx architecture [--path-prefix <area>] [--include-fixtures]\`
- Structure: \`idx structure [--path-prefix <area>] [--kind <kind>] [--max-depth <n>] [--max-files <n>] [--cursor <n>] [--include-internal] [--include-fixtures] [--no-tests] [--include-tests-summary]\`
- AST: \`idx ast <file> [--max-depth <n>] [--max-nodes <n>] [--cursor <n>] [--no-include-text]\`
- Search: \`idx search <query> [--max-files <n>] [--path-prefix <area>] [--chunk-types <types|api|impl|tests|imports>] [--mode hybrid|semantic|lexical|symbol] [--min-score <score>] [--include-content] [--include-imports] [--dedupe-file] [--dedupe-symbol] [--cluster] [--exclude-tests] [--include-tests]\`
- Explain: \`idx explain <symbol|file::symbol> [--path-prefix <area>] [--include-fixtures] [--include-body] [--body-lines <n>] [--signature-only]\`
- Deps: \`idx deps <path|path::symbol> [--mode modules|calls] [--direction callers|callees|both] [--depth <n>] [--show-edges] [--tests]\`
`;
}

export const GENERATED_SKILLS: GeneratedSkill[] = [
	{
		name: "repo-discovery",
		directory: "repo-discovery",
		content: buildRepoDiscoverySkillContent(),
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
