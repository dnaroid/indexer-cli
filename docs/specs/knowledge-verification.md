# Knowledge verification receipts

Implementation: `src/core/types.ts`, `src/knowledge/service.ts`, `src/knowledge/verification/evidence.ts`,
`src/knowledge/verification/selectors.ts`, `src/knowledge/verification/runner.ts`,
`src/storage/sqlite.ts`, `src/cli/commands/wiki-verification.ts`,
`src/cli/commands/wiki-verification-runner.ts`.
Regression evidence: `tests/unit/knowledge/verification.test.ts`,
`tests/unit/knowledge/service.test.ts`, `tests/unit/storage/sqlite.test.ts`,
`tests/unit/knowledge/maintenance-integration.test.ts`.

Source and input freshness hashes are SHA-256 over exact file bytes, not the
normalized text hashes used for retrieval deduplication. BOM characters inside
strings, trailing whitespace and binary differences cannot silently remain fresh.

`KnowledgeService.record()` classifies a source; it never verifies semantics.
`verify(path, receipt)` accepts only a version 1 caller-reviewed attestation prepared for
the exact current source, relation map, and non-ignored code-input hashes. It
rejects a source changed since `record`, so verification cannot silently update
classification metadata.

## Public integration API

```ts
const selector = await service.prepareVerificationSelector("src/auth.ts", {
  kind: "code-symbol", value: "refresh",
});
const options = { selectors: { "src/auth.ts": selector } };
const preparation = await service.prepareVerification("docs/auth.md", options);
await service.verify("docs/auth.md", receipt, options);
```

Build `receipt` as `KnowledgeVerificationReceipt` with `version: 1`, every field
from `preparation` (`sourcePath`, `sourceHash`, `relationsHash`, `inputs`), valid
`preparedAt`, non-empty reviewer and rationale, assertion/evidence labels, and
non-empty `assertionBindings` and `evidenceBindings`. An assertion binding must
name the prepared source and its exact hash. Evidence bindings may name that
source or a tracked input, always with its exact hash, and optionally an
inclusive line range. Labels are compatibility-only and do not constitute
evidence.
For zero tracked inputs set `zeroTrackedInputsAcknowledged: true` and explain it
in limitations. Attach selectors to matching inputs only after preparing their
fingerprints through the same `options`; selectors are relevance evidence and do not relax whole-file drift.
Missing/ambiguous selectors fail.

The service does not implicitly execute commands. Imported receipts may contain successful
`attestedRunnerChecks`, which are explicitly attestations; they cannot claim
`locallyRecordedRunnerChecks`. The separate `runVerificationChecks(commands,
execute)` API executes only through a caller-supplied explicit executor and
returns locally measured exit/result/log hashes. To store those checks, pass the
exact returned array to `verify` as `options.localRunnerChecks`; it is an
in-memory capability and a parsed/copied JSON array is rejected. JSON alone is
not proof of execution.

CLI `wiki prepare --path ... --output receipt.json` writes an unaccepted draft.
`wiki verify --path ... --receipt receipt.json` accepts only a completed receipt.
Repeatable `--check '<command>'` explicitly opts into shell execution in the
project root: each check has a 120-second timeout and a 4 MiB output limit, and
keeps a unique log. Failure, timeout, or truncated output prevents verification.
No command from imported JSON is executed. Evidence ranges must fit the current
file; checked evidence bytes are revalidated before the atomic database commit.

The receipt and input baseline are committed in one SQLite transaction. Old rows
with hash baselines but no receipt remain `unverified` with a
`legacy/unattested verification baseline` reason; no evidence is fabricated.
For this receiptless compatibility branch only, an old normalized indexing hash
is compared with the legacy normalized hash before reporting source drift. New
receipts always compare exact file bytes.

Preparation partitions code relations into tracked and ignored sets; ignored relations are reported as warnings and excluded from tracked coverage.
Status derives coverage from the current non-ignored code relation targets, not
only persisted input rows: removing an ignore rule makes an absent or changed
target immediately stale. An empty tracked set is not coverage.

Manifest assertion IDs and declared selector kind/value are deterministic
relation-map evidence. They are included in the relation hash, and manifest
selectors are used by default during preparation. Caller selector keys must
name exactly one tracked input; conflicting or ambiguous declaration selectors
are rejected.

`getStatuses(entries?)` parses ignore rules once and hashes shared files once per
request. Receiptless legacy baselines expose `verificationState: "legacy-unattested"`; attested receipts expose `"attested"`. Statuses expose tracked/ignored input counts, legacy-versus-attested
state, and conservative selector review hints. A selector never makes a changed
whole file fresh; status checks deliberately do not reread selector regions.
