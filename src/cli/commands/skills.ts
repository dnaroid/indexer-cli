import { SKILLS_VERSION } from "../../core/skills-version.js";

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
allowed-tools: Bash(idx search:*)
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

Search without \`--include-content\`.

\`\`\`bash
idx search "prize"
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
idx search "password reset" --path-prefix auth
\`\`\`

## Skip when

- you need a file tree or symbol inventory
- you already know the exact file and line range
- the query is an identifier; use grep/LSP/symbol-explain instead

## Command patterns

\`\`\`bash
# Phase 1: discover
idx search "rate limiting"
idx search "password reset" --path-prefix auth

# Phase 2: Read returned files/lines with Read tool

# Rare exception: inline content when expecting <5 hits
idx search "input validation" --include-content --max-files 3
\`\`\`

## CLI reference

- Positional args: \`<query>\`
- Options: \`--max-files\`, \`--path-prefix\`, \`--chunk-types\`, \`--min-score\`, \`--include-content\`,
  \`--include-imports\`

### Allowed \`--chunk-types\`

\`full_file\`, \`imports\`, \`preamble\`, \`declaration\`, \`module_section\`, \`impl\`, \`types\`

Imports and preamble are excluded by default. Use \`--include-imports\` to include them.

## Anti-patterns

- ❌ 3+ overlapping searches
- ❌ broad searches with \`--include-content\`
- ❌ long synonym-heavy queries
- ❌ re-searching after Phase 1 already found the locations
- ❌ grepping the same concept after semantic search already found it
- ❌ loading this skill via \`skill\` when you already know the \`idx\` command
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
		description: `FIRST choice when you need to see what's inside a package/directory — all files, classes, functions, exports in a compact tree. Produces a symbol-level map of any path prefix. Use BEFORE opening multiple files to understand layout. Triggers - "show me the structure of X", "what's in this module", "list the symbols". ALWAYS narrow with --path-prefix or --kind; unfiltered output can exceed 800 tokens.`,
		heading: "Use repo-structure for tree and symbol-map questions",
		useWhen:
			"Use this when the agent needs to see how files and symbols are organized in an area of the repo before reading implementation details.",
		focusHint:
			"Keep the request centered on one repo area or one symbol kind so the tree stays readable.",
		allowedTools: ["Bash(idx structure:*)"],
		rules: [
			"Prefer structure when layout matters more than implementation snippets.",
			"ALWAYS use --path-prefix or --kind to keep output focused.",
			"Combine --path-prefix with --kind for the tightest result (e.g. --path-prefix engine --kind class).",
			"By default only exported symbols are shown. Use --include-internal to see private methods and non-exported helpers.",
			"Fixtures and vendor paths are excluded by default. Use --include-fixtures to include them.",
			"Test files are included by default. Use --no-tests to exclude them and focus on production code.",
		],
		skipWhen: [
			"You need dependency relationships rather than physical structure",
			"You need semantic search results rather than a tree",
		],
		commandSamples: [
			"idx structure --path-prefix <area>",
			"idx structure --path-prefix <area> --kind class",
			"idx structure --kind function",
			"idx structure --path-prefix <area> --include-internal",
			"idx structure --include-fixtures",
			"idx structure --no-tests",
			"idx structure --path-prefix <area> --no-tests",
		],
		cliReference: [
			"Options: --path-prefix <string>, --kind <string>, --max-depth <number>, --max-files <number>, --include-internal, --include-fixtures, --no-tests.",
			"Allowed --kind values: function, class, method, interface, type, variable, module, signal.",
			"By default shows only exported symbols. Add --include-internal to show all symbols (methods, private members).",
			"By default excludes fixtures/vendor paths. Add --include-fixtures to include them.",
			"By default includes test files. Add --no-tests to exclude test files from output.",
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
		allowedTools: ["Bash(idx architecture:*)"],
		rules: [
			"Use architecture when the question is about system shape, not a single symbol.",
			"Filter by path prefix when only one subsystem matters.",
			"Pay attention to cyclic dependencies — they indicate tight coupling that may affect where you make changes.",
			"Follow up with `deps <hot-path>` to drill into specific module relationships, or `explain <symbol>` to understand a key class.",
		],
		skipWhen: [
			"You need callers/callees for one specific file or symbol",
			"You need dense narrative context instead of a graph-shaped overview",
		],
		commandSamples: [
			"idx architecture",
			"idx architecture --path-prefix <area>",
		],
		cliReference: ["Options: --path-prefix <string>, --include-fixtures."],
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
		allowedTools: ["Bash(idx explain:*)"],
		rules: [
			"Use explain only when the symbol name is already known.",
			"Use <file>::<symbol> syntax when the same symbol name exists in multiple files (e.g. `explain engine/indexer.ts::IndexerEngine`).",
			"Use bare <symbol> when the name is unique in the codebase.",
			"Keep the prompt centered on a single symbol for the cleanest output.",
			"Use --path-prefix to limit results to files under a specific path.",
			"Tests and fixtures are excluded by default. Add --include-fixtures to include them.",
			"Exact name matches take priority; fuzzy matches only appear when no exact match exists.",
		],
		skipWhen: [
			"You need to discover candidate symbols first",
			"You need repo-wide structure rather than one-symbol context",
		],
		commandSamples: [
			"idx explain <symbol>",
			"idx explain <file>::<symbol>",
			"idx explain <symbol> --path-prefix <area>",
		],
		cliReference: [
			"Positional args: <symbol> or <file>::<symbol>.",
			"Options: --path-prefix <string>, --include-fixtures.",
			"Tests/fixtures excluded by default. Exact matches prioritized over fuzzy matches.",
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
		allowedTools: ["Bash(idx deps:*)"],
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
			"idx deps <path>",
			"idx deps <path> --direction callers",
			"idx deps <path> --direction callees",
			"idx deps <path> --depth 2",
		],
		cliReference: [
			"Positional args: <path>.",
			"Options: --direction <dir>, --depth <n>.",
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
