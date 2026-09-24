export type GeneratedSkill = {
	name: string;
	directory: string;
	content: string;
};

function buildRepoDiscoverySkillContent(): string {
	return `---
name: repo-discovery
description: FIRST choice for indexed repo discovery and behavioral specs. Use when the code owner/file/symbol is unknown, including “how does this behavior work?” questions; for architecture, finding code by behavior, or tracing dependencies in an unfamiliar subsystem; for specs/contracts and their implementation/tests; and for material behavior changes that may require updating a spec or checking impact. Use it even when a changed implementation path is already known if the question asks which specs are affected. Prefer exact Read/rg/LSP only for pure known-path or identifier lookup.
allowed-tools: Bash(idx context:*), Bash(idx audit:*), Bash(idx architecture:*), Bash(idx structure:*), Bash(idx ast:*), Bash(idx search:*), Bash(idx explain:*), Bash(idx deps:*), Bash(rg:*), Bash(grep:*)
---

# Indexed repository guidance

Pick the single cheapest indexed command that answers the question. For
project behavior, contracts, implementation, and tests, start with
\`idx context '<query>'\`. For unknown implementation by behavior, use
\`idx search '<query>' --max-files 3\`. The coding agent performs reasoning and
synthesis itself from returned evidence rather than delegating to a second model.
Use \`idx search '<query>' --mode lexical\` when semantic retrieval is unavailable
or an exact text-oriented pass is preferred. Mandatory retrieval diagnostics
remain visible; never treat warnings or TRUNC/NEXT hints as optional evidence.
Setup, initialization, and explicit indexing remain explicit operations. When a specific
low-level operation is needed, use the commands below. Start compact, read the
smallest returned ranges, and expand only for a named gap.

## Route

- General behavior/task discovery request → \`idx context '<query>'\`.
- Discovery without an LLM → \`idx search '<query>' --mode lexical\`.
- Project behavior/contract question needing implementation/tests →
  \`idx context <query>\`.
- Search project documents and code together → \`idx search <query>\`.
- Before a material behavior change → find relevant documents with
  \`idx context <query>\` or \`idx search <query>\`.
- Material behavior change complete → \`idx audit <changed-paths...>\`.
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
  synonyms. Keep hybrid ranking for behavior discovery; it independently combines
  semantic, lexical, symbol, and path candidates. First pass is at
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

- Read the primary source: summaries and rankings are navigation aids, not
  authoritative statements or proof of completeness.
- Specs describe behavior, scenarios, constraints, and interfaces—not an
  inventory of implementation details. Update meaningful high-level specs when
  behavior changes; skip documentation ceremony for non-behavioral edits.
- Start a task with \`idx context\` or a focused indexed command before implementation. After a material
  behavior change, run task-scoped \`idx audit\` and compare the affected source
  documents with implementation and tests. Fix actual semantic drift; the audit
  does not prove a document is wrong or require edits when it remains accurate.
- All Markdown documents are indexed subject to ignore/exclusion filters.
  Explicit frontmatter kind/status wins; inferred purpose is advisory. Unknown
  documents remain searchable and audit candidates. Never invent relations or
  documentation ceremony for non-behavioral changes.
- For new specs, use the non-overwriting template installed at
  \`.indexer-cli/spec-template.md\`. Declare \`kind: spec\` and the intended
  \`status\` in frontmatter. In \`Implementation\` and \`Tests\` sections, list
  project-root-relative paths in backticks, optionally \`path::Symbol\`.
  Existing useful documents need no mandatory reformatting.

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
