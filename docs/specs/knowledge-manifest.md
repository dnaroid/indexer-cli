# Knowledge manifest (optional)

Export includes existing manually recorded entries with deterministic IDs and
explicit relations, making a fresh clone portable without requiring an earlier
manifest import. Inferred relations are never promoted to declared evidence.
Manifest-managed entries export only their owned declaration edges. No export
includes verification baselines or receipts; applying into a populated registry
still rejects unrelated explicit-edge collisions rather than silently adopting them.

Implementation: `src/knowledge/manifest.ts`, `src/knowledge/service.ts`,
`src/storage/sqlite.ts`, `src/cli/commands/wiki-manifest.ts`.
Regression evidence: `tests/unit/knowledge/manifest.test.ts`.

`idx wiki manifest` is an opt-in, Git-versionable JSON interchange format. It never creates a document folder, template, embedding, secret, verified source hash, verified relation hash, or verified input. `apply` records metadata and declared relations only; semantic verification remains the separate explicit `idx wiki verify` action.

## JSON contract

The root object has exactly `version: 1` and `knowledge`. `knowledge` is an array of objects with stable `id`, repository-relative `source`, `classification`, `behaviorType`, `lifecycle`, and non-empty `summary`. Optional fields are `owner` and `topics`. Valid classifications are `spec`, `spec-like`, `meta-index`, `design-only`, `guide`, and `other`; behavior types are `as-is`, `change`, `mixed`, and `unknown`; lifecycles are `active`, `proposed`, `historical`, `superseded`, and `unknown`.

Each entry may have `implements`, `tests`, `related`, `supersedes`, or `superseded-by`. Every item is `{ "id": "assertion-id", "target": "...", "evidence": { "selector": { "kind": "code-symbol", "value": "handleLogin" } } }`. Assertion IDs are globally unique. Selector kinds are `code-symbol`, `json-pointer`, and `document-section`; opaque selector strings are rejected. `implements` and `tests` targets are repository-relative code paths. The other relation targets are knowledge IDs. Example:

```json
{"version":1,"knowledge":[{"id":"auth-contract","source":"docs/auth.md","classification":"spec","behaviorType":"as-is","lifecycle":"active","owner":"security","summary":"Authentication contract.","topics":["auth"],"implements":[{"id":"auth-handler","target":"src/auth.ts","evidence":{"selector":{"kind":"code-symbol","value":"handleLogin"}}}],"tests":[{"id":"auth-test","target":"tests/auth.test.ts"}]}]}
```

Validation rejects unknown fields at every level, malformed values, duplicate IDs, canonical source aliases, assertion IDs and relation identities, missing knowledge targets, cycles formed by either supersession direction, traversal, non-files, and symlinks. A `superseded` entry without an incoming declaration is a warning. Validation is consistency-only: it does not infer a relation from prose or alter source documents.

## Commands and safety

* `idx wiki manifest validate --file knowledge.json [--json]`
* `idx wiki manifest export --file knowledge.json`
* `idx wiki manifest apply --file knowledge.json [--json]`

Output ordering is stable by source and relation kind/path. Export includes manually recorded entries with their explicit relations, and manifest-authoritative entries with their manifest-owned relations. It excludes inferred relations, verification baselines, receipts, and embeddings. Apply does not import or fabricate verification state; existing as-is freshness remains compatible, and a downgrade from a primary classification clears verification.

Export paths must be lexically and real-path contained by the project root. Existing destination symlinks and parent directories that resolve outside the root are rejected; the destination is opened with no-follow semantics to prevent a symlink swap where supported.

Reapply is authoritative for the manifest's own relation set: removed declarations are removed while inferred and other provenance remain. Apply requires the host store's `applyKnowledgeManifestAtomically(projectId, operations)` capability. It preflights relation collisions and atomically updates every entry, manifest-owned relation, and any required verification-baseline clearing; on an error, no declaration in that apply is changed. Stores without this capability refuse apply before writes rather than risking a partial update.

Manifest declarations are authoritative typed dependencies. A document merely mentioning `src/a.ts` is not an `implements` or `tests` declaration in manifest mode. `normalizeManifestDeclarations()` and `declarationForSource()` expose the declared set; persisted `metadata.manifest.authoritative === true` is available through `isManifestAuthoritativeEntry()`. `KnowledgeService.record` preserves declared edges for marked sources and stores prose references as navigation-only `metadata.mentions`. The legacy prose dependency heuristic remains unchanged for non-manifest records.

## Host integration

`src/cli/commands/wiki.ts` registers `registerWikiManifestCommand(wiki, withWikiRuntime)`. The callback requires `{ projectRoot, metadata: KnowledgeStore, projectId? }` and defaults to `DEFAULT_PROJECT_ID`. `SqliteMetadataStore` supplies a synchronous SQLite transaction for the entire manifest; service record integration preserves relation ownership.
