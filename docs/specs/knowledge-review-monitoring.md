---
kind: spec
status: active
---

# Offline knowledge review monitoring

## Behavior

`idx knowledge dirty` is the minimal current-project dirtiness flag. It prints
exactly one lowercase line: `yes` if any selected spec is dirty/unreviewed, `no`
if all selected specs are clean (including an empty selected set). It resolves
the project from the working directory, including nested directories, and accepts
no project/JSON options. Successful checks exit 0 for either answer; callers read
the value rather than interpreting dirtiness as a command failure. Incomplete
checks conservatively print `yes`, explain the failure on stderr and exit 2;
they must never print `no`. It uses local content comparison,
with no models, indexing, state writes or automatic acknowledgment.

The flag checks whether explicitly declared active specs have been acknowledged
against their current source and Implementation/Tests dependencies. Project
resolution requires an initialized `.indexer-cli/config.json` and supports
directories beneath the selected root.
No database, snapshot, Git history, classifier, embedding provider, migration,
skill refresh or automatic update is used. Checking dirty does not write review state.

Only source frontmatter `kind: spec` and `status: active` selects a spec. Inferred
metadata is not used; unknown and inactive documents remain outside this monitor.
Document discovery follows the configured document selection and ignore rules.
Inline backtick declarations in Implementation/Tests sections are dependencies;
ordinary mentions and Markdown links are not. Symbols conservatively track the
whole file, without symbol-resolution claims. Directory declarations recursively
cover all regular files and directory membership, including ignored files, but
exclude `.git` and `.indexer-cli` subtrees. Unrelated paths do not dirty a spec.

`idx knowledge acknowledge <spec-paths...>`
records an explicit agent/human attestation **after** comparing the named source
specs with their current implementation/tests and fixing real semantic drift.
It is not a correctness certificate or an automatic semantic check. Each selected
spec stores SHA-256 hashes of its own bytes and dependencies. Specs with no receipt
start dirty (`never-reviewed`); specs with no declarations stay dirty
(`no-declarations`) and cannot be acknowledged. Source changes, dependency
changes, directory additions/deletions and declaration changes invalidate the
comparison (`content-changed`). Named spec paths are project-root-relative even
when invoked from a nested directory. Successful acknowledgment prints
`Acknowledged: <paths>` and exits 0; failures explain the problem on stderr and
exit 2 without success output. Exact content reversions are clean again; this
tracks current content equality, not every historical edit or Git commit.

The knowledge CLI exposes only `dirty` and `acknowledge`: no detailed status,
external-project or JSON options. An empty selected set returns `no`; this does
not imply that unregistered/undeclared docs were checked. Internal report reasons
remain implementation details, not additional CLI commands.
Review and index freshness are distinct: indexing and task audit never
acknowledge a spec or clear monitoring state.

## Constraints and failure cases

Missing/unreadable dependencies, unsupported symlinks/special files, escaping
paths, malformed receipts, skipped oversized docs and scanner warnings fail
closed with `yes` and exit 2, not `no`. Deleted explicitly named files
require correcting the declaration before acknowledgment; deletion inside an
existing declared directory is a normal content-change signal. No-declaration
specs require adding meaningful dependencies before acknowledgment.

Receipts live under `.indexer-cli/knowledge-reviews/<sha256-spec-path>.json`, one
versioned file per spec, replaced through an atomic temporary-file rename.
Different spec acknowledgments do not overwrite each other's state. All selected
specs are validated before writing; an I/O failure during a multi-spec write can
leave a subset acknowledged. Simultaneous writes for the same spec are last-writer
wins. Scanning is not an atomic filesystem snapshot: acknowledgment must run after
task edits stop; subsequent dirty checks detect later changes. Broad directory
declarations read more bytes; work is local and hashes are reused across specs
within each invocation, with no persistent mtime cache that could miss same-size
or preserved-timestamp edits. Deleting project data removes attestations and makes
specs unreviewed again. No source prose or credentials are stored in receipts.

See [the decision](../decisions/offline-knowledge-review-monitoring.md) and
[task-scoped audit](knowledge-maintenance.md) for their separate responsibilities.

## Implementation

- `src/knowledge/review-state.ts`
- `src/cli/commands/knowledge.ts`
- `src/cli/entry.ts`

## Tests

- `tests/unit/knowledge/review-state.test.ts`
- `tests/unit/cli/knowledge.test.ts`

## Verification

Verify never-reviewed → acknowledge → clean → dependency change → dirty, plus
spec edits, directory membership changes, content reversion, unrelated files,
invalid receipts and acknowledgment failures. Verify current-project
`dirty` outputs only yes/no, works in nested directories, preserves read-only
behavior and fails closed for missing dependencies/project configuration.
No provider is required.
