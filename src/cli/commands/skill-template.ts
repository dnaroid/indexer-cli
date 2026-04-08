/**
 * SKILL.md template for Claude Code integration.
 *
 * Written to `.claude/skills/semantic-search/SKILL.md` during `indexer-cli init`.
 */
export const SKILL_MD = `\
---
name: repo-discovery
description: Mandatory for repository discovery. Before grep/glob/find, first use indexer-cli whenever the task involves finding implementations, tracing behavior, locating symbols, identifying entry points, inspecting module structure, or understanding an unfamiliar area of this repo.
allowed-tools: Bash(indexer-cli:*)
---

# Repository discovery with indexer-cli

Use this skill for discovery tasks inside this repository.

## Required behavior

Always start with indexer-cli for repository discovery.
Do not use grep, glob, or find until indexer-cli was insufficient, or you need an exact literal text match after narrowing the area.

## Load this skill when

- You need to find where something is implemented
- You need to trace a symbol, handler, feature, or behavior
- You are entering an unfamiliar module or directory
- You need structure, entry points, or dependency context
- The task is exploratory and you do not yet know the right file

## Skip this skill when

- The exact file is already known and the task stays inside it
- You only need an exact literal text match
- The task is outside this repository

## First command

Run one of these first:

\`\`\`bash
indexer-cli search "<query>" --json
indexer-cli search "<query>" --json --path-prefix src/<area>
indexer-cli structure --json --path-prefix src/<area>
indexer-cli architecture --json
indexer-cli index --status --json
`;
