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

# Use repo-discovery as the single indexed entry point

Use this skill first when the task is about understanding an unfamiliar codebase, locating behavior, identifying important symbols, or tracing impact.

Choose the single cheapest discovery path, run it, and stop as soon as you have enough context.

## Routing rules

- Use \`idx architecture\` for repo shape, entry points, and high-level module boundaries.
- Use \`idx structure\` for file trees, exported symbols, and "what's in this directory/module?" questions.
- Use \`idx search\` for behavior and flow questions like "how does X work?" or "what happens when Y?".
- Use \`idx explain\` when the symbol name is already known.
- Use \`idx deps\` when the path/module is already known and you need callers, callees, or impact.

## Hard rules

- Start with exactly one indexed command, not several.
- Prefer the cheapest matching command.
- Do not run overlapping discovery commands for the same question unless the first one clearly failed.
- After \`idx search\`, read the returned files and ranges instead of re-running search from another angle.
- Narrow with \`--path-prefix\` whenever the subsystem is known.
- For \`idx structure\`, use \`--path-prefix\` or \`--kind\` unless the repo is tiny.
- For \`idx deps\`, start with \`--depth 1\` and increase only when first-hop impact is insufficient.
- For \`idx explain\`, prefer \`<file>::<symbol>\` when the name may be ambiguous.

## Escalation path

- architecture → structure
- structure → explain
- search → Read tool on returned files
- explain → deps
- deps → architecture only if broader system context is still missing

## Skip when

- you already know the exact file and lines to read
- the task is an exact identifier lookup better handled by grep/LSP
- you are no longer in discovery mode and are already editing code

## Command samples

Use one matching example; these are alternatives, not a sequence.

\`\`\`bash
idx architecture --path-prefix src/cli
idx structure --path-prefix src/cli --kind function
idx search "refresh skills"
idx explain src/cli/commands/init.ts::refreshClaudeSkills
idx deps src/cli/commands/init.ts --direction callers
\`\`\`

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
