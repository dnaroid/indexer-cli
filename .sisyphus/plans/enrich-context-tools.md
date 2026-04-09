# Plan: Enriched Index & Context Tools

Goal: reduce paid model token spend by precomputing context via free local Ollama during indexing, and serving dense
ready-to-use context through CLI commands instead of requiring multiple exploration calls.

Key insight: Ollama is free locally → shift computation to indexing time, serve pre-digested context at query time.

---

## P0 — Foundation

### 1. `indexer-cli enrich` — Ollama-generated metadata at index time

During/after `indexer-cli index`, run each chunk through Ollama to generate and store in SQLite:

- **`module_summary`** (per file) — 1-2 sentences describing the module's purpose
- **`symbol_description`** (per exported symbol) — what it does, in plain language
- **`dependency_note`** (per inter-module dependency) — why module A depends on module B

Storage: new columns/tables in existing SQLite DB.
Updates: incremental — only re-enrich chunks that changed since last index.

```bash
indexer-cli enrich                          # enrich all indexed chunks
indexer-cli enrich --module src/engine/searcher.ts  # single module
indexer-cli enrich --dry-run                # preview what would be enriched
```

This is the foundation — everything below consumes data produced here.

#### Large file handling: map-reduce summarization

Local Ollama models have limited context windows (8K–32K tokens). Large files (500+ lines) may exceed them. Solution: *
*map-reduce** using the existing `src/chunking/` infrastructure.

**Two-pass approach:**

1. **Map** — each chunk separately → 1-sentence description (fits any context window)
2. **Reduce** — concatenate chunk descriptions → 1-2 sentence module summary

```
Large file (1500 lines, 3 chunks)
  ├── chunk 1 (imports + module_section)  → Ollama → "Handles CLI argument parsing and command registration"
  ├── chunk 2 (class SearchResult)        → Ollama → "Data class for ranked search results with score and metadata"
  └── chunk 3 (function searchChunks)     → Ollama → "Runs vector similarity search against LanceDB index"
                                                                     ↓
                          concatenated chunk summaries (~3 sentences) → Ollama → module_summary
```

For small files (single chunk) — one pass, no reduce needed.

Pseudo-implementation:

```typescript
async function enrichFile(filePath: string, chunks: Chunk[]): Promise<string> {
  if (chunks.length === 1) {
    return ollama.generate(
      `Summarize this module in 1-2 sentences:\n${chunks[0].content}`
    );
  }

  // Map: summarize each chunk in parallel
  const chunkSummaries = await Promise.all(
    chunks.map(c =>
      ollama.generate(`Describe this code section in 1 sentence:\n${c.content}`)
    )
  );

  // Reduce: combine chunk summaries into module summary
  return ollama.generate(
    `Based on these section descriptions, summarize the module in 1-2 sentences:\n` +
    chunkSummaries.join('\n')
  );
}
```

Key constraint: reduce input is N short sentences (not raw code), so it always fits the context window even for files
with 20+ chunks (~20 sentences ≈ 300 tokens).

### 2. `indexer-cli context` — single onboarding query

Aggregates enriched data from the DB into a dense context block. No Ollama calls at query time — pure aggregation.

Returns:

- Architecture overview (from `architecture` + `module_summary` for each module)
- Key symbols with descriptions (from `symbol_description`)
- Module dependency graph with notes (from `dependency_note`)
- Convention hints (naming patterns, error handling style, test structure — detected from enriched metadata)

```bash
indexer-cli context                        # full project onboarding block
indexer-cli context --format=markdown      # human-readable
indexer-cli context --format=json          # machine-readable
indexer-cli context --scope=changed        # only modules affected by uncommitted changes
```

Replaces 5-10 separate `search` + `structure` + `architecture` calls with one.

---

## P1 — Focused tools

### 3. `indexer-cli explain <symbol>` — symbol context without file reads

From enriched index only, returns:

- Signature (already indexed)
- Description (from enrich)
- Callers — who invokes this symbol (from dependency-resolver)
- Callees — what this symbol calls
- Related symbols (same module exports)

```bash
indexer-cli explain searchChunks
indexer-cli explain src/engine/searcher.ts::searchChunks
```

One query replaces 3-5 file reads.

### 4. Diff-aware context

Uses `git diff` to identify changed files, then pulls from enriched index:

- Summaries of affected modules
- Symbols that may be impacted (callers of changed functions)
- Tests related to changed modules

```bash
indexer-cli context --scope=diff           # uncommitted changes
indexer-cli context --scope=diff --ref=HEAD~3  # last 3 commits
```

### 5. Symbol dependency graph — callers/callees

Leverages existing `dependency-resolver.ts` to expose:

```bash
indexer-cli deps src/engine/searcher.ts --direction=callers
indexer-cli deps src/engine/searcher.ts --direction=callees
indexer-cli deps --symbol=searchChunks --depth=2
```

---

## P2 — Nice-to-have

### 6. Hotspot analysis

Uses git history + code complexity to identify critical areas:

```bash
indexer-cli hotspots                       # top 10 hotspots
indexer-cli hotspots --sort=commits        # most frequently changed
indexer-cli hotspots --sort=complexity     # highest cyclomatic complexity
indexer-cli hotspots --sort=deps           # most depended-upon
```

Data sources:

- `git log --follow` for change frequency per file
- tree-sitter for cyclomatic complexity
- dependency-resolver for fan-in/fan-out count

Useful for: guiding the model to pay extra attention to fragile/critical code.

---

## Implementation order

1. `enrich` — foundation, populates DB with Ollama-generated descriptions
2. `context` — aggregation layer, consumes enriched data
3. `explain` — focused symbol queries on enriched data
4. `diff-aware context` — git-integrated scope filtering
5. `deps` — expose existing dependency data
6. `hotspots` — git history analysis

## No static files

Everything lives in `.indexer-cli/` DB. No AGENTS.md, no files to sync. Index is already incrementally updated —
enriched metadata follows the same lifecycle.
