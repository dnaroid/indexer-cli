# CLAUDE.md

## Skill-first code discovery

For any task that involves finding code, understanding structure, tracing an implementation, or exploring an unfamiliar
area, load the `semantic-search` skill immediately with `skill(name="semantic-search")`.

Default discovery flow in this repo:

1. Load `semantic-search`.
2. Use `indexer-cli search "<query>" --json` for targeted lookups.
3. Use `indexer-cli structure --json --path-prefix <dir>` when you need the layout of an area.
4. Fall back to `grep`/`glob` only when the user already gave an exact file or you need a literal string match.

Do not skip the skill just because text search might also work. This project was initialized with indexer-cli, so
repository exploration should bias toward `indexer-cli` first.
