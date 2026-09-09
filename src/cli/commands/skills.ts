export type GeneratedSkill = {
	name: string;
	directory: string;
	content: string;
};

function buildRepoDiscoverySkillContent(): string {
	return `---
name: repo-discovery
description: FIRST choice for indexed repository discovery and project knowledge. Use when files/symbols are unknown, when answering project behavior/contracts/requirements, tracing dependencies, or checking contract impact after behavior changes. Prefer exact Read/rg/LSP when the path or identifier is already known.
allowed-tools: Bash(idx context:*), Bash(idx wiki:*), Bash(idx architecture:*), Bash(idx structure:*), Bash(idx ast:*), Bash(idx search:*), Bash(idx explain:*), Bash(idx deps:*), Bash(rg:*), Bash(grep:*)
---

# Indexed repository guidance

Pick the single cheapest indexed command that answers the question. Start compact,
read the smallest returned ranges, and expand only for a named gap.

## Route

- Project behavior/contract question → \`idx context <query>\`.
- Need only authoritative specs/contracts → \`idx wiki search <query>\`.
- Material behavior change complete / contract-impact question →
  \`idx wiki impact <task-paths...>\` using this task's changed paths.
- Broad unfamiliar subsystem → \`idx architecture --path-prefix <area>\`.
- Directory/module inventory → \`idx structure --path-prefix <area> --max-files 20 --max-depth 2\`.
- One known large file → \`idx ast <file> --max-depth 3 --max-nodes 40 --no-include-text\`.
- Unknown implementation by behavior → \`idx search <query> --max-files 3\`.
- Known symbol → \`idx explain file::symbol --signature-only\`.
- Known path/symbol dependencies → \`idx deps <path|file::symbol> --direction <...> --depth 1\`.
- Exact path/range → Read directly. Exact identifier/regex → \`rg\`/LSP, not semantic search.

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
- \`idx wiki record\` classifies/indexes metadata; it is **not** semantic
  verification. Run \`idx wiki verify\` only after checking the primary source
  against relevant code/tests/evidence.
- Treat \`unverified\`, \`spec-changed\`, \`inputs-changed\`,
  \`spec+inputs-changed\`, and \`missing-source\` as review obligations, not as
  current truth.
- After material behavior-changing implementation, run task-scoped
  \`idx wiki impact <changed paths...>\` even when the files are already known.
  Review uncovered paths and semantic/graph candidates. Similarity never creates
  a durable relation by itself.
- A reviewed no-impact outcome is valid. Never invent a relation merely to make
  coverage non-empty.
- New/moved/changed document candidates must be classified. For low-signal docs
  that normal discovery may miss, use \`idx wiki discover --all-unclassified\`.

## Stop conditions

- One useful indexed result is enough when it answers the question.
- Run a second discovery command only for a specific unresolved gap.
- Once exact files/ranges are known, switch to direct reading/editing/testing.
- Do not broaden output merely because more indexed data exists.
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
