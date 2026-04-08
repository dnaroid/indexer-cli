/**
 * SKILL.md template for Claude Code integration.
 *
 * Written to `.claude/skills/semantic-search/SKILL.md` during `indexer-cli init`.
 */
export const CLAUDE_MD = `\
# CLAUDE.md

## Skill-first code discovery

For any task that involves finding code, understanding structure, tracing an implementation, or exploring an unfamiliar area, load the \`semantic-search\` skill immediately with \`skill(name="semantic-search")\`.

Default discovery flow in this repo:
1. Load \`semantic-search\`.
2. Use \`indexer-cli search "<query>" --json\` for targeted lookups.
3. Use \`indexer-cli structure --json --path-prefix <dir>\` when you need the layout of an area.
4. Fall back to \`grep\`/\`glob\` only when the user already gave an exact file or you need a literal string match.

Do not skip the skill just because text search might also work. This project was initialized with indexer-cli, so repository exploration should bias toward \`indexer-cli\` first.

## Skill loading compatibility

\`skill_use\` is unreliable in this environment and may return \`not_found\` for valid skills. Use \`skill(name="...")\` as the primary loading path.
`;

export const SKILL_MD = `\
---
name: semantic-search
description: Load this for repo discovery. Use indexer-cli before grep/glob/find when you need to find code, trace implementations, inspect structure, or understand an unfamiliar area.
allowed-tools: Bash(indexer-cli:*)
---

# Semantic search with indexer-cli

Use this skill before grep/glob/find when the task is about discovery inside this repo.

## Load this skill when

- You need to find where something is implemented
- You are entering an unfamiliar module or directory
- You want the structure of an area, not just a filename
- You need entry points, symbols, or dependency context

## Skip this skill when

- The user already gave the exact file and the task stays inside it
- You only need a literal text match
- The task is outside this repository

## First commands to try

\`\`\`bash
indexer-cli search "<query>" --json
indexer-cli search "<query>" --json --path-prefix src/<area>
indexer-cli structure --json --path-prefix src/<area>
indexer-cli architecture --json
indexer-cli index --status --json
\`\`\`

If results look stale, run:

\`\`\`bash
indexer-cli index
\`\`\`

## Default workflow

1. Start with \`search\` for a symbol, behavior, or concept.
2. Use \`structure\` when you need the layout of a directory.
3. Use \`architecture\` for higher-level dependency or entry-point questions.
4. Only fall back to grep/glob/find after indexer-cli was not enough.

## Query tips

- Keep queries short: 2-8 keywords
- Prefer identifiers or nouns over full sentences
- Add \`--path-prefix\` as soon as you know the area

## Examples

\`\`\`bash
indexer-cli search "search command handler" --json
indexer-cli search "SymbolExtractor" --json --path-prefix src
indexer-cli structure --json --path-prefix src/engine
\`\`\`
`;
