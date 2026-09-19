# Agent skill and `.gitignore` ownership contract

## Scope

This specification defines what `indexer-cli` may add to or remove from a
project's root `.gitignore` when initializing, installing coding-agent skills,
refreshing those skills, migrating a project, or uninstalling.

## Plain initialization

Plain `idx init` without `--claude` or `--codex` owns only indexer-cli project
state. It may add `.indexer-cli/` to `.gitignore`, but it must not add agent or
context paths such as:

- `.claude/`
- `.agents/`
- `CLAUDE.md`
- `AGENTS.md`

The same rule applies when a project is initialized with no enabled skill
targets after migration or re-initialization.

## Opt-in skill installation

Agent integration is explicit. When a target is enabled, idx may ignore only
the directories that it generates itself:

- Claude: `.claude/skills/repo-discovery/`
- Codex: `.agents/skills/repo-discovery/`

Idx must not ignore the whole `.claude/` or `.agents/` root. Other agent
settings, context files, custom skills, and repository instructions remain
outside idx ownership.

If additional generated skills are introduced later, the same rule applies:
only each concrete idx-generated skill directory may be added to `.gitignore`.

## Existing ignore rules

Root-anchored and unanchored forms of an idx-owned root path are equivalent for
the purpose of avoiding duplicate entries. For example, an existing
`/.indexer-cli/` satisfies a request to ignore `.indexer-cli/`; idx must not add
a second redundant line.

Existing user-authored context ignore rules are preserved. The presence of
`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.agents/`, or other unrelated patterns
must not be rewritten merely because idx initializes or refreshes its index.

## Uninstall and legacy cleanup

`idx uninstall` removes current idx-generated skill directories and their
narrow `.gitignore` entries. A project with no configured/generated idx skill
must retain user-owned broad agent/context ignore rules and files.

Older idx releases historically added broad `.claude/` or `.agents/` rules.
Uninstall may remove those legacy broad rules only when the corresponding idx
skill target is recorded in project config or a known idx-generated/deprecated
skill artifact is actually found and removed. This preserves backwards cleanup
without treating arbitrary user agent configuration as idx-owned.

## Evidence

- Init/skill ignore ownership: `src/cli/commands/init.ts`
- Uninstall/legacy cleanup ownership: `src/cli/commands/uninstall.ts`
- CLI regressions: `tests/cli/commands.test.ts`
- Helper/root-anchor regressions: `tests/unit/cli/init.test.ts`
- Language init compatibility: `tests/cli/commands-python.test.ts`,
  `tests/cli/commands-ruby.test.ts`, `tests/cli/commands-csharp.test.ts`
- User-facing behavior: `README.md`
