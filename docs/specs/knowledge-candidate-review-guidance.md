# Knowledge candidate review guidance

## Scope

This specification defines how `idx wiki status`, `idx wiki audit`,
`idx wiki search`, and `idx context` guide an agent when discovery finds new or
changed document candidates.

## Behavior

- When one or more candidates require review, human-readable output includes an
  explicit `Recommendation:` alongside the command response.
- The recommendation tells the agent to run `idx wiki discover`, read each
  candidate's source, and classify it with `idx wiki record`.
- The recommendation explicitly tells the agent to inform the user that
  unreviewed candidates remain.
- The recommendation warns that a candidate is not registered project knowledge
  until its source has been reviewed.
- JSON output from `status`, `audit`, and `search` includes the equivalent
  `recommendation` string when the candidate count is greater than zero.
- When no candidates require review, human-readable output does not print a
  recommendation and JSON output omits the `recommendation` property. This
  applies independently to each covered command.

## Rationale

A candidate count alone can be mistaken for an empty or already-maintained
knowledge base. The command must make the required follow-up action explicit so
an agent does not silently ignore unreviewed project documents.

## Evidence

- CLI implementation: `src/cli/commands/wiki.ts`
- Context implementation: `src/cli/commands/context.ts`
- Shared recommendation: `src/cli/format/knowledge.ts`
- CLI coverage: `tests/cli/commands.test.ts`
- Agent guidance: `src/cli/commands/skills.ts`
- User documentation: `README.md`
