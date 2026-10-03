---
kind: other
status: active
---

# Add opt-in offline spec review monitoring

## Status

Accepted. This supersedes only the exclusion of durable review baselines in the
Interface section of [knowledge maintenance](../specs/knowledge-maintenance.md).
The removed wiki/registry system is not restored.

## Context and evidence

The user requested a cheap CLI dirtiness flag for the knowledge base: a spec is
dirty when its declared dependencies changed and the agent has not checked it.
They approved treating specs without an acknowledgment as dirty. Existing task
audit reports relationships but intentionally has no durable acknowledgment;
index freshness cannot prove that an agent compared the contract to its code.

## Decision and scope

Add only `knowledge dirty` and explicit `knowledge acknowledge` commands for
the current initialized project, with no project or JSON options. Compare exact local
content hashes for explicit active specs and their declared dependencies, with
per-spec project-local receipts. Audit/index keep their current meanings. Monitor
state is opt-in and advisory, not a mandatory product-wide review obligation.
No provider, index read/refresh or automatic CLI update is needed.

The user's subsequent clarification makes `idx knowledge dirty` the minimal
current-project interface: one yes/no line rather than external-project monitoring
or detailed JSON. It reuses the same comparison; successful checks exit 0 for
either value, while incomplete checks return conservative yes with stderr and
exit 2. The user explicitly retained acknowledgment to record review and clear
dirty for selected specs. The initially added detailed status and external-project
options were a misinterpretation, rejected and removed before delivery; they are
not supported interfaces or compatibility obligations.

The detailed contract is [offline review monitoring](../specs/knowledge-review-monitoring.md).

## Alternatives

- Git timestamps/commit baselines: cannot reliably represent acknowledged dirty
  workspace bytes, ignored dependencies or non-Git projects.
- Persist mtime/size shortcuts: cheaper byte reads but can miss preserved timestamps
  and same-size edits; correctness takes precedence for the first implementation.
- SQLite receipts: couples a cheap check to database initialization/migration and
  index availability; independent atomic per-spec files avoid that coupling.
- Automatic acknowledgment after audit/index: falsely equates relationship
  discovery or indexing with an agent's actual semantic comparison.

## Consequences and revisit triggers

Initial projects need explicit reviews; broad directory declarations increase
local I/O. Receipts disappear with project data and are not team-wide certificates.
Assumption: monitoring projects can afford hashing declared dependencies; measure
large-project latency before adding a persistent cache with explicit safety rules.
Revisit shared state only if portable/team attestations become a requirement.
