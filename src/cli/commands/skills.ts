type SkillDefinition = {
	name: string;
	directory: string;
	rawContent?: string;
	description: string;
	heading: string;
	useWhen: string;
	focusHint?: string;
	allowedTools: string[];
	rules: string[];
	skipWhen?: string[];
	commandSamples: string[];
	cliReference?: string[];
};

function renderSkill(definition: SkillDefinition): string {
	const sections = [
		"---",
		`name: ${definition.name}`,
		`description: ${definition.description}`,
		`allowed-tools: ${definition.allowedTools.join(", ")}`,
		"---",
		"",
		`# ${definition.heading}`,
		"",
		definition.useWhen,
		"",
	];

	if (definition.focusHint) {
		sections.push(definition.focusHint, "");
	}

	sections.push("## Rules", "", ...definition.rules.map((item) => `- ${item}`));

	if (definition.skipWhen && definition.skipWhen.length > 0) {
		sections.push(
			"",
			"## Skip when",
			"",
			...definition.skipWhen.map((item) => `- ${item}`),
		);
	}

	sections.push(
		"",
		"## Command samples",
		"",
		"Use one matching example; these are alternatives, not a sequence.",
		"",
		"```bash",
		...definition.commandSamples,
		"```",
	);

	if (definition.cliReference && definition.cliReference.length > 0) {
		sections.push(
			"",
			"## CLI reference",
			"",
			...definition.cliReference.map((item) => `- ${item}`),
		);
	}

	return `${sections.join("\n")}\n`;
}

const SKILL_DEFINITIONS: SkillDefinition[] = [
	{
		name: "semantic-search",
		directory: "semantic-search",
		rawContent: `---
name: semantic-search
description:
  FIRST choice for CONCEPT and BEHAVIOR questions — "how is scoring calculated", "what happens on order cancel", "what if a user stops paying", "how does the system handle expired subscriptions", "lifecycle of a payment", "flow when X fails". Use BEFORE spawning explore agents for these questions — it traces cross-module behavior that grep misses. Do NOT use for keyword/identifier lookups (use grep/ast-grep instead). If the search term is a code identifier (class name, variable name, function name), this is the WRONG tool — use symbol-explain or grep instead.
allowed-tools: Bash(npx indexer-cli search:*)
---

# Use semantic-search for implementation hunting

Use when semantic search is already the right tool.
Keep the query short and centered on one code concept.

## Mandatory rules

### 1) Search count

- 1 search per question
- Max 2 only if the second is a truly different angle
- If search 1 answers the question: STOP

Never run 3+ overlapping searches.

### 2) Query shape

Use 1-3 domain-specific words. No synonyms.

Pick the single best concept word. Add words only to narrow scope.

- ✅ \`prize\`
- ✅ \`password reset\`
- ✅ \`rate limiting\`
- ❌ \`prize reward award\`
- ❌ \`chapter pass percent quiz result score\`
- ❌ \`order cancel payment failure refund\`

### 3) Two-phase retrieval — ALWAYS

#### Phase 1: Discover

Search without \`--include-content\`, with \`--fields filePath,startLine,endLine,primarySymbol\`.

\`\`\`bash
npx indexer-cli search "prize" --fields filePath,startLine,endLine,primarySymbol
\`\`\`

#### Phase 2: Read

Use the Read tool on the exact files and line ranges from Phase 1.

Do NOT:

- run another semantic search for the same concept
- grep the same concept
- grep terms revealed by Phase 1
- replace reading with \`--include-content\`

### Hard stop after Phase 1

If Phase 1 returned useful file paths and ranges, read them.

Only if Phase 1 returns nothing useful, do one fallback:

- one alternative semantic query, or
- grep

### 4) \`--include-content\` is rare

Use it only for a quick scan when you expect fewer than 5 results.

### 5) Narrow early with \`--path-prefix\`

If you know the subsystem, add \`--path-prefix\`.

\`\`\`bash
npx indexer-cli search "password reset" --path-prefix src/auth --fields filePath,startLine,endLine,primarySymbol
\`\`\`

## Skip when

- you need a file tree or symbol inventory
- you already know the exact file and line range
- the query is an identifier; use grep/LSP/symbol-explain instead

## Command patterns

\`\`\`bash
# Phase 1: discover
npx indexer-cli search "rate limiting" --fields filePath,startLine,endLine,primarySymbol
npx indexer-cli search "password reset" --path-prefix src/auth --fields filePath,startLine,endLine,primarySymbol

# Phase 2: Read returned files/lines with Read tool

# Rare exception: inline content when expecting <5 hits
npx indexer-cli search "input validation" --include-content --max-files 3
\`\`\`

## CLI reference

- Positional args: \`<query>\`
- Options: \`--max-files\`, \`--path-prefix\`, \`--chunk-types\`, \`--fields\`, \`--min-score\`, \`--include-content\`,
  \`--include-imports\`

### Allowed \`--chunk-types\`

\`full_file\`, \`imports\`, \`preamble\`, \`declaration\`, \`module_section\`, \`impl\`, \`types\`

Imports and preamble are excluded by default. Use \`--include-imports\` to include them.

### Allowed \`--fields\`

\`filePath\`, \`startLine\`, \`endLine\`, \`score\`, \`primarySymbol\`, \`content\`

## Anti-patterns

- ❌ 3+ overlapping searches
- ❌ broad searches with \`--include-content\`
- ❌ long synonym-heavy queries
- ❌ re-searching after Phase 1 already found the locations
- ❌ grepping the same concept after semantic search already found it
- ❌ loading this skill via \`skill\` when you already know the \`indexer-cli\` command
`,
		description: "",
		heading: "",
		useWhen: "",
		allowedTools: [],
		rules: [],
		commandSamples: [],
	},
	{
		name: "repo-structure",
		directory: "repo-structure",
		description: `FIRST choice when you need to see what's inside a package/directory — all files, classes, functions, exports in a tree. Produces a symbol-level map of any path prefix. Use BEFORE opening multiple files to understand layout. Triggers: "show me the structure of X", "what's in this module", "list the symbols". ALWAYS narrow with --path-prefix or --kind; unfiltered output can exceed 2500 tokens.`,
		heading: "Use repo-structure for tree and symbol-map questions",
		useWhen:
			"Use this when the agent needs to see how files and symbols are organized in an area of the repo before reading implementation details.",
		focusHint:
			"Keep the request centered on one repo area or one symbol kind so the tree stays readable.",
		allowedTools: ["Bash(npx indexer-cli structure:*)"],
		rules: [
			"Prefer structure when layout matters more than implementation snippets.",
			"ALWAYS use --path-prefix or --kind to keep output focused — unfiltered output dumps every symbol in the repo and can exceed 2500 tokens.",
			"Combine --path-prefix with --kind for the tightest result (e.g. --path-prefix src/engine --kind class).",
			"Use JSON output for agents unless a human explicitly asks for text.",
		],
		skipWhen: [
			"You need dependency relationships rather than physical structure",
			"You need semantic search results rather than a tree",
		],
		commandSamples: [
			"npx indexer-cli structure --path-prefix src/<area>",
			"npx indexer-cli structure --path-prefix src/<area> --kind class",
			"npx indexer-cli structure --kind function",
		],
		cliReference: [
			"Output: JSON by default; use --txt for human-readable text.",
			"Options: --path-prefix <string>, --kind <string>, --max-depth <number>, --max-files <number>, --txt.",
			"Allowed --kind values: function, class, method, interface, type, variable, module, signal.",
		],
	},
	{
		name: "repo-architecture",
		directory: "repo-architecture",
		description: `FIRST choice when user asks "what is this project", "explain the codebase", "how is this organized". Produces a full dependency graph, entry points, and module breakdown — everything needed to understand a repo without reading individual files. Use BEFORE reading package.json or exploring directories manually. Also the best starting point for onboarding: run this first, then drill into specific modules with deps or explain.`,
		heading: "Use repo-architecture for dependency-graph questions",
		useWhen:
			"Use this when the agent needs a high-level snapshot of modules, entry points, and dependency shape before going deeper. This is the cheapest way to orient in an unfamiliar codebase (~140 tokens for a typical project).",
		focusHint:
			"Keep the scope to the subsystem that matters so the graph highlights the right boundaries.",
		allowedTools: ["Bash(npx indexer-cli architecture:*)"],
		rules: [
			"Use architecture when the question is about system shape, not a single symbol.",
			"Filter by path prefix when only one subsystem matters.",
			"Use JSON output to preserve structured dependency data.",
			"Pay attention to cyclic dependencies — they indicate tight coupling that may affect where you make changes.",
			"Follow up with `deps <hot-path>` to drill into specific module relationships, or `explain <symbol>` to understand a key class.",
		],
		skipWhen: [
			"You need callers/callees for one specific file or symbol",
			"You need dense narrative context instead of a graph-shaped overview",
		],
		commandSamples: [
			"npx indexer-cli architecture",
			"npx indexer-cli architecture --path-prefix src/<area>",
		],
		cliReference: [
			"Output: JSON by default; use --txt for human-readable text.",
			"Options: --path-prefix <string>, --include-fixtures, --txt.",
		],
	},
	{
		name: "repo-context",
		directory: "repo-context",
		description:
			"FIRST choice for changed-area and subsystem summaries. Load this before opening many files when you need whole-repo orientation, changed-scope context, or a dependency-neighborhood snapshot without exact implementation snippets. ALWAYS pass --scope; without it the output can exceed 5000 tokens.",
		heading: "Use repo-context for dense summaries",
		useWhen:
			"Use this when the agent wants a compressed view of a subsystem, changed area, or dependency neighborhood without opening many files.",
		focusHint:
			"Keep the scope explicit so the summary stays dense instead of drifting across the repo.",
		allowedTools: ["Bash(npx indexer-cli context:*)"],
		rules: [
			"Prefer context when you want breadth over exact source snippets.",
			"ALWAYS use --scope — default `--scope all` outputs every symbol in the repo and can exceed 5000 tokens. Use --scope relevant-to:<path> for a focused neighborhood or --scope changed for uncommitted changes.",
			"Lower --max-deps when you need a tighter prompt budget.",
		],
		skipWhen: [
			"You need exact implementation locations or ranked chunks",
			"You need a file tree or architecture graph instead of a summary",
		],
		commandSamples: [
			"npx indexer-cli context --scope relevant-to:src/<area>",
			"npx indexer-cli context --scope changed",
			"npx indexer-cli context --scope relevant-to:src/<area> --max-deps 10",
		],
		cliReference: [
			"Output: JSON by default; use --txt for human-readable text.",
			"Options: --scope <scope>, --max-deps <number>, --include-fixtures, --txt.",
			"Allowed --scope values: all, changed, relevant-to:<path>.",
		],
	},
	{
		name: "symbol-explain",
		directory: "symbol-explain",
		description:
			"FIRST choice once the symbol name is known. Load this before manual caller/signature tracing to get one symbol's signature, module context, and callers fast. Output is ~80 tokens — the cheapest way to understand a single symbol.",
		heading: "Use symbol-explain for one symbol at a time",
		useWhen:
			"Use this when the task centers on one function, class, type, or symbol and the agent needs signature, usage, and containing module context fast.",
		focusHint:
			"Keep the request centered on one symbol name for the cleanest caller and signature output.",
		allowedTools: ["Bash(npx indexer-cli explain:*)"],
		rules: [
			"Use explain only when the symbol name is already known.",
			"Use <file>::<symbol> syntax when the same symbol name exists in multiple files (e.g. `explain src/engine/indexer.ts::IndexerEngine`).",
			"Use bare <symbol> when the name is unique in the codebase.",
			"Keep the prompt centered on a single symbol for the cleanest output.",
		],
		skipWhen: [
			"You need to discover candidate symbols first",
			"You need repo-wide structure rather than one-symbol context",
		],
		commandSamples: [
			"npx indexer-cli explain <symbol>",
			"npx indexer-cli explain <file>::<symbol>",
		],
		cliReference: [
			"Positional args: <symbol> or <file>::<symbol>.",
			"Output: JSON by default; use --txt for human-readable text.",
			"Options: --txt.",
		],
	},
	{
		name: "dependency-trace",
		directory: "dependency-trace",
		description:
			"FIRST choice once the file or module is known and impact matters. Load this before manual import tracing to see callers, callees, and likely change impact. Output is ~140 tokens per depth level.",
		heading: "Use dependency-trace for impact analysis",
		useWhen:
			"Use this when the agent needs to know who imports a module, what it imports, or how far change impact may spread.",
		focusHint:
			"Start with a single path or module and keep depth low until the first-hop trace stops being enough.",
		allowedTools: ["Bash(npx indexer-cli deps:*)"],
		rules: [
			"Use deps when the question is about relationships, not source snippets.",
			"Set --direction callers or --direction callees when only one side matters.",
			"Start at depth 1 (default). Increase to --depth 2 only when the first hop is not enough — each depth level adds more callers/callees.",
		],
		skipWhen: [
			"You need a repo-wide architecture snapshot rather than one trace",
			"You do not yet know the path or symbol to trace",
		],
		commandSamples: [
			"npx indexer-cli deps <path>",
			"npx indexer-cli deps <path> --direction callers",
			"npx indexer-cli deps <path> --direction callees",
			"npx indexer-cli deps <path> --depth 2",
		],
		cliReference: [
			"Positional args: <path>.",
			"Output: JSON by default; use --txt for human-readable text.",
			"Options: --direction <dir>, --depth <n>, --txt.",
			"Allowed --direction values: callers, callees, both.",
			"Behavior: --depth is effectively clamped to the range 1..5.",
		],
	},
];

export type GeneratedSkill = {
	name: string;
	directory: string;
	content: string;
};

export const GENERATED_SKILLS: GeneratedSkill[] = SKILL_DEFINITIONS.map(
	(definition) => ({
		name: definition.name,
		directory: definition.directory,
		content: definition.rawContent ?? renderSkill(definition),
	}),
);

export const DEPRECATED_SKILL_DIRECTORIES = ["context-pack"];

export const GENERATED_SKILL_DIRECTORIES = GENERATED_SKILLS.map(
	(skill) => skill.directory,
);
