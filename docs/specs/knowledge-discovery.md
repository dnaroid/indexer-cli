# Knowledge discovery cache

Implementation: `src/knowledge/service.ts`, `src/knowledge/discovery-cache.ts`.

Regression evidence: `tests/unit/knowledge/discovery-cache.test.ts`, `tests/unit/knowledge/service.test.ts`, `tests/unit/knowledge/manifest.test.ts`.

Discovery still authoritatively scans project documents (including current gitignore and configured document filters) on every invocation. The project-local `.indexer-cli/knowledge-discovery-v1.json` is only a bounded best-effort hint for title, discovery signals, and an exact-byte SHA-256 hash. A row is reusable only when its format/config/project identity and filesystem fingerprint (`dev`, `ino`, size, nanosecond mtime and ctime) match. Thus replacements, renames, deletes, same-size edits with restored mtime, configuration changes, and cache-format changes do not reuse stale data.

Changed or unreadable files are read normally. Cache entries are committed only when pre- and post-read fingerprints agree, preventing a racing read from being persisted. Corrupt or unwritable caches are ignored; atomic replacement prevents partial writes. The cache is never used by record, status, prepare, or verify: those operations retain authoritative exact-byte reads and hashes. Discovery is deterministic and contains no LLM calls.

Classification entries indexed before exact-byte hashes were introduced have no `metadata.indexedSourceHashFormat` marker. For those legacy entries only, discovery and status may compare the former normalized-text hash so unchanged documents remain unattested rather than falsely changed. `record` and manifest apply write `sha256-exact-v1`; marked entries always use exact-byte comparison, including before they have verification receipts.
