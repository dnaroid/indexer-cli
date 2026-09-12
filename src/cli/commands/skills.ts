export type GeneratedSkill = {
	name: string;
	directory: string;
	content: string;
};

function buildRepoDiscoverySkillContent(): string {
	return `---
name: repo-discovery
description: FIRST choice for indexed repo discovery and behavioral specs. Use when the code owner/file/symbol is unknown, including “how does this behavior work?” questions; for architecture or finding code by behavior; for any caller/dependency trace in an unfamiliar subsystem; for specs/contracts/requirements/freshness and the implementation/tests that enforce them; for behavioral-knowledge bootstrap; and for material behavior changes that may require creating/updating/verifying a primary spec or checking impact/relations. Use it even when a changed implementation path is already known if the question asks which specs/contracts/relations are affected. Prefer exact Read/rg/LSP only for pure known-path or identifier lookup.
allowed-tools: Bash(idx context:*), Bash(idx wiki:*), Bash(idx architecture:*), Bash(idx structure:*), Bash(idx ast:*), Bash(idx search:*), Bash(idx explain:*), Bash(idx deps:*), Bash(rg:*), Bash(grep:*)
---

# Indexed repository guidance

Pick the single cheapest indexed command that answers the question. Start compact,
read the smallest returned ranges, and expand only for a named gap.

## Route

- Project behavior/contract question needing implementation/tests/freshness →
  \`idx context <query>\`.
- Need only authoritative specs/contracts → \`idx wiki search <query>\`.
- Before a material behavior change → find the current primary contract with
  \`idx context <query>\` or \`idx wiki search <query>\`.
- Material behavior change complete / contract-impact question →
  \`idx wiki impact <task-paths...>\` using this task's changed paths.
- Broad unfamiliar subsystem → \`idx architecture --path-prefix <area>\`.
- Directory/module inventory →
  \`idx structure --path-prefix <area> --max-files 20 --max-depth 2\`.
- One known large file →
  \`idx ast <file> --max-depth 3 --max-nodes 40 --no-include-text\`.
- Unknown implementation by behavior → \`idx search <query> --max-files 3\`.
- Known symbol → \`idx explain file::symbol --signature-only\`.
- Known path/symbol dependencies →
  \`idx deps <path|file::symbol> --direction <...> --depth 1\`.
- Exact path/range → Read directly. Exact identifier/regex → \`rg\`/LSP, not
  semantic search.

## Compact tool guidance

- \`repo_search\` guidance applies directly: search behavior, not a pile of
  synonyms. Keep hybrid ranking unless lexical matches mislead. First pass is at
  most 3 results and no \`--include-content\`. Scope with \`--path-prefix\` or
  \`--dedupe-file\` when useful. After finding causal code, stop broad search.
- Read returned ranges instead of whole files. Do not mechanically chain
  \`search → explain\` or \`explain → Read\` when direct range reading is cheaper.
- \`structure\`: first pass max 20 files/depth 2; narrow with \`--kind\`; use
  \`--cursor\` instead of asking for hundreds of files.
- \`ast\`: first pass depth 3/nodes 40/no text; continue with \`--cursor\` and
  add snippets only when the outline cannot answer the gap.
- \`explain\`: prefer \`file::symbol\`; start signature-only. Add body only for
  a named implementation gap, normally at most 20 lines.
- \`deps\`: start depth 1 and one useful direction. Use \`--mode calls\`,
  \`--show-edges\`, \`--tests\`, or deeper traversal only for a named gap.
- Exact identifier, phrase, path, or regex is lookup, not discovery. Use
  Read/\`rg\`/LSP instead of semantic search.

## Knowledge rules

- Primary project specs/contracts are authoritative. Catalogs, summaries,
  embeddings, rankings, and relation candidates are routing evidence only.
- For a material behavior-changing task, keep the authoritative primary spec
  aligned in the **same task**. Update the existing primary spec when it governs
  the behavior. If no suitable primary contract exists, create a focused primary
  spec file before recording metadata. Do not create specs for mechanical
  refactors, typo/formatting changes, exact renames, or other non-behavioral work.
- \`idx wiki record\` classifies/indexes metadata; it is **not** semantic
  verification. A newly created primary spec remains unverified until its
  implementation/evidence has actually been reviewed. Run \`idx wiki verify\`
  only after checking the primary source against relevant code/tests/evidence.
- Treat \`unverified\`, \`spec-changed\`, \`inputs-changed\`,
  \`spec+inputs-changed\`, and \`missing-source\` as review obligations, not as
  current truth. Do not present a non-fresh primary spec as unquestionably current
  without reviewing the relevant implementation/tests.
- Gitignored code relations remain dependency documentation but do not participate
  in verified-input freshness tracking. Treat the relate warning as intentional;
  context code hints include only paths present in the current code index.
- After material behavior-changing implementation, run task-scoped
  \`idx wiki impact <changed paths...>\` even when the files are already known.
  Review uncovered paths plus new/moved/changed documents and semantic/graph
  candidates. Empty known impact does not prove no impact; uncovered paths still
  require semantic review. Similarity never creates a durable relation by itself.
- A reviewed no-impact outcome is valid. Never invent a relation merely to make
  coverage non-empty.
- New/moved/changed document candidates must be classified. For low-signal docs
  that normal discovery may miss, use \`idx wiki discover --all-unclassified\`.
- When \`idx wiki status\`, \`idx wiki audit\`, \`idx wiki search\`, or
  \`idx context\` reports a candidate-review recommendation, explicitly tell the
  user that unreviewed candidates remain, run \`idx wiki discover\`, read each
  source, and classify it with \`idx wiki record\`. Candidates are not registered
  knowledge until they have been reviewed.
- When a primary spec moves, establish/classify the new path, preserve or repair
  evidence-backed code/test/spec relations, verify the new path after semantic
  review, and remove old metadata only after the new authority is established.
- Changed code never automatically rewrites spec semantics. Decide whether the
  contract changed by comparing intended behavior, primary source, code, and tests.

## Material-change completion checkpoint

For material project behavior changes, do not finish until all applicable steps
below are complete:

1. Locate and read the governing primary contract before or during implementation.
2. Update that contract, or create a focused primary spec if none governs the
   behavior. Edit the real source document; metadata alone is not a spec.
3. Run \`idx wiki impact <task-changed-paths...>\`; prefer task-scoped paths over
   the whole dirty worktree.
4. Review uncovered implementation paths and all new/moved/changed document
   candidates. Repair only relations supported by concrete evidence.
5. Run \`idx wiki verify --path <primary-spec>\` only after reviewing the final
   primary source plus relevant implementation/tests/evidence.
6. Ensure affected current primary specs are fresh, or explicitly report any
   remaining review obligation instead of silently treating it as current.

## Stop conditions

- One useful indexed result is enough when it answers the question.
- Run a second discovery command only for a specific unresolved gap.
- Once exact files/ranges are known, switch to direct reading/editing/testing.
- Do not broaden output merely because more indexed data exists.
- Mechanical/non-behavioral edits do not require the material-change knowledge
  checkpoint.
`;
}

export const GENERATED_SKILLS: GeneratedSkill[] = [
	{
		name: "repo-discovery",
		directory: "repo-discovery",
		content: buildRepoDiscoverySkillContent(),
	},
];

export const DEPRECATED_SKILL_DIRECTORIES = [
	"context-pack",
	"semantic-search",
	"repo-structure",
	"repo-architecture",
	"symbol-explain",
	"dependency-trace",
];

export const GENERATED_SKILL_DIRECTORIES = GENERATED_SKILLS.map(
	(skill) => skill.directory,
);
