# Knowledge discovery

Implementation: `src/knowledge/service.ts`, `src/knowledge/discovery.ts`,
`src/knowledge/document-scanner.ts`.

Regression evidence: `tests/unit/knowledge/service.test.ts`,
`tests/unit/knowledge/discovery.test.ts`,
`tests/unit/knowledge/document-scanner.test.ts`,
`tests/unit/knowledge/manifest.test.ts`.

Discovery scans project documents using the current gitignore and configured
document filters on every invocation. Each readable document is read directly:
its exact bytes supply the SHA-256 hash, and its decoded text supplies the title
and discovery signals. Repeated calls therefore use current document contents
and the current analysis implementation, including after same-size edits with
restored mtime, renames, deletes, and filter changes. Files that disappear or
become unreadable after scanning are skipped.

Discovery has no persistent cache and does not write discovery state to disk or
the database. Legacy discovery JSON files are unused, left untouched, and may
be deleted. Record, status, prepare, and verify retain
their independent exact-byte reads and hashes. Discovery is deterministic and
contains no LLM calls.

Classification entries indexed before exact-byte hashes were introduced have no
`metadata.indexedSourceHashFormat` marker. For those legacy entries only,
discovery and status may compare the former normalized-text hash so unchanged
documents remain unattested rather than falsely changed. `record` and manifest
apply write `sha256-exact-v1`; marked entries always use exact-byte comparison,
including before they have verification receipts.
