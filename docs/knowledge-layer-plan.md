# Project document discovery

The former knowledge-layer implementation plan described wiki commands,
registries, verification receipts, and review obligations that are not part of
the current product contract. The active contract is
[knowledge maintenance](specs/knowledge-maintenance.md).

All project Markdown is indexed subject to ignore and configured exclusion
rules. Search, ask, and context retrieve documents and code through shared
workflows. Explicit frontmatter kind/status has precedence; optional inferred
classification is advisory, and unknown documents remain searchable.

After relevant changes, `idx audit <changed-paths...>` reports explicit spec
declarations separately from possible document candidates. Agents inspect the
source and correct real semantic drift; a match is not proof of incorrectness,
and no documentation ceremony is required when the source remains accurate.
