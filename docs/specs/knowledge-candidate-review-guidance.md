# Knowledge candidate review guidance

## Scope

This specification defines how `idx wiki status`, `idx wiki audit`,
`idx wiki search`, and `idx context` guide an agent when discovery finds new or
changed document candidates.

## Behavior

- Default `status`/`audit` print a compact `Review:` count and
  `idx wiki discover` pointer when candidates require review;
  `--verbose` restores the detailed `Recommendation:`.
  `search --verbose` and search JSON retain discovery guidance; ordinary search
  and context do not perform unrelated discovery or repeat maintenance guidance
  on every retrieval. Their evidence freshness/trust warnings remain visible.
- Candidate review distinguishes two categories from normal discovery:
  - an **unclassified candidate** has no `knownClassification` and must be read
    and classified with `idx wiki record` before it becomes registered project
    knowledge, but its indexed content is already available to retrieval as
    default-trusted, explicitly unreviewed evidence;
  - a **changed classified candidate** has `knownClassification` and
    `changedSinceClassification: true`; it remains registered project knowledge,
    but its changed source requires review against the existing
    classification/metadata.
- Recommendations tell the agent to run `idx wiki discover` when durable
  classification is needed, but they do not block retrieval. Unclassified
  candidates may be used immediately with default-trust/unreviewed warnings;
  `idx wiki record` promotes selected documents into durable registered
  knowledge with lifecycle/relations/verification semantics. Changed classified
  candidates get review-existing-classification/metadata guidance and may be
  re-recorded to confirm or update that metadata.
- For non-primary classifications such as `guide`, `design-only`, `meta-index`,
  and `other`, re-recording after review refreshes the recorded source hash; they
  do not have a separate verify lifecycle. Primary knowledge keeps the distinct
  `record` versus `verify` lifecycle, and `verify` is still allowed only after
  evidence review.
- Mixed candidate sets describe both obligations separately. They must not imply
  that changed classified candidates became unregistered merely because their
  source hash changed.
- Default or explicit trust does not satisfy candidate-review obligations.
  Trust controls whether evidence may be used with warnings; a changed
  classified source still requires review, and unclassified documents still
  require classification before becoming registered knowledge.
- The detailed recommendation explicitly tells the agent to inform the user that the
  applicable candidate reviews remain.
- `status`/`audit` JSON exposes `candidateCount`,
  `unclassifiedCandidateCount`, and `changedClassifiedCandidateCount`. `search`
  JSON exposes the same review counts alongside its results. JSON includes the
  equivalent `recommendation` string when either review category is non-zero.
- When no candidates require review, human-readable output does not print a
  recommendation and JSON output omits the `recommendation` property. This
  applies to commands and modes that include discovery guidance.
- Normal `idx wiki discover` continues to surface changed already-classified
  documents. `idx wiki discover --all-unclassified` continues to exclude every
  existing knowledge entry, even when its source has changed.

## Rationale

A combined candidate count alone hides whether work is new classification or
maintenance of already-registered knowledge. The command must make the relevant
follow-up action explicit without weakening the maintenance signal for changed
guides, design references, meta indexes, historical specs, or other recorded
documents.

## Evidence

- Candidate counting: `src/knowledge/service.ts`
- CLI implementation: `src/cli/commands/wiki.ts`
- Context implementation: `src/cli/commands/context.ts`
- Shared recommendation: `src/cli/format/knowledge.ts`
- CLI coverage: `tests/cli/commands.test.ts`
- Service coverage: `tests/unit/knowledge/service.test.ts`
- Agent guidance: `src/cli/commands/skills.ts`
- User documentation: `README.md`
