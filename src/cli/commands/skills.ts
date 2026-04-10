type SkillDefinition = {
	name: string;
	directory: string;
	description: string;
	heading: string;
	purpose: string;
	allowedTools: string[];
	autoLoadWhen: string[];
	rules: string[];
	skipWhen?: string[];
	firstCommands: string[];
	notes?: string[];
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
		definition.purpose,
		"",
		"## Auto-load when",
		"",
		...definition.autoLoadWhen.map((item) => `- ${item}`),
		"",
		"## Rules",
		"",
		...definition.rules.map((item) => `- ${item}`),
	];

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
		"## First commands",
		"",
		"```bash",
		...definition.firstCommands,
		"```",
	);

	if (definition.notes && definition.notes.length > 0) {
		sections.push(
			"",
			"## Notes",
			"",
			...definition.notes.map((item) => `- ${item}`),
		);
	}

	return `${sections.join("\n")}\n`;
}

const SKILL_DEFINITIONS: SkillDefinition[] = [
	{
		name: "semantic-search",
		directory: "semantic-search",
		description:
			"Use for semantic implementation search in this repository with npx indexer-cli search before opening many files.",
		heading: "Use semantic-search for implementation hunting",
		purpose:
			"Use this when the agent already knows it needs semantic search results, not a tree or architecture map. Keep the prompt short and centered on the code concept to find.",
		allowedTools: ["Bash(npx indexer-cli search:*)"],
		autoLoadWhen: [
			"Find where a feature, function, handler, or pattern is implemented",
			"Search for examples of a concept across the repo",
			"Narrow discovery by path, chunk type, score, or fields",
		],
		rules: [
			"Start with npx indexer-cli search instead of grep when the request is semantic or concept-based.",
			"Prefer compact JSON fields first; include content only after the right chunk is found.",
			"Use --path-prefix or --chunk-types when you already know the likely area.",
		],
		skipWhen: [
			"You need a file tree or symbol inventory instead of search results",
			"You already know the exact file and line range to inspect",
		],
		firstCommands: [
			'npx indexer-cli search "<query>"',
			'npx indexer-cli search "<query>" --path-prefix src/<area>',
			'npx indexer-cli search "<query>" --chunk-types impl,types',
		],
		notes: [
			"Useful fields: filePath, startLine, endLine, score, primarySymbol.",
			"Valid --chunk-types values: full_file, imports, preamble, declaration, module_section, impl, types.",
		],
	},
	{
		name: "repo-structure",
		directory: "repo-structure",
		description:
			"Use for file-tree and symbol-map questions in this repository with npx indexer-cli structure.",
		heading: "Use repo-structure for tree and symbol-map questions",
		purpose:
			"Use this when the agent needs to see how files and symbols are organized in an area of the repo before reading implementation details.",
		allowedTools: ["Bash(npx indexer-cli structure:*)"],
		autoLoadWhen: [
			"Show the file tree for a module or directory",
			"List symbols by area or symbol kind",
			"Limit structure output to a path prefix or max depth",
		],
		rules: [
			"Prefer structure when layout matters more than implementation snippets.",
			"Use --path-prefix and --kind to keep output focused.",
			"Use JSON output for agents unless a human explicitly asks for text.",
		],
		skipWhen: [
			"You need dependency relationships rather than physical structure",
			"You need semantic search results rather than a tree",
		],
		firstCommands: [
			"npx indexer-cli structure",
			"npx indexer-cli structure --path-prefix src/<area>",
			"npx indexer-cli structure --kind function",
		],
		notes: [
			"Valid --kind values: function, class, method, interface, type, variable, module, signal.",
		],
	},
	{
		name: "repo-architecture",
		directory: "repo-architecture",
		description:
			"Use for entry points, dependency graphs, and module-level architecture questions with npx indexer-cli architecture.",
		heading: "Use repo-architecture for dependency-graph questions",
		purpose:
			"Use this when the agent needs a high-level snapshot of modules, entry points, and dependency shape before going deeper.",
		allowedTools: ["Bash(npx indexer-cli architecture:*)"],
		autoLoadWhen: [
			"Identify entry points or major modules",
			"Inspect dependency-map shape across an area of the repo",
			"Understand architecture before refactoring or large changes",
		],
		rules: [
			"Use architecture when the question is about system shape, not a single symbol.",
			"Filter by path prefix when only one subsystem matters.",
			"Use JSON output to preserve structured dependency data.",
		],
		skipWhen: [
			"You need callers/callees for one specific file or symbol",
			"You need dense narrative context instead of a graph-shaped overview",
		],
		firstCommands: [
			"npx indexer-cli architecture",
			"npx indexer-cli architecture --path-prefix src/<area>",
		],
	},
	{
		name: "repo-context",
		directory: "repo-context",
		description:
			"Use for dense, token-efficient project summaries with npx indexer-cli context.",
		heading: "Use repo-context for dense summaries",
		purpose:
			"Use this when the agent wants a compressed view of a subsystem, changed area, or dependency neighborhood without opening many files.",
		allowedTools: ["Bash(npx indexer-cli context:*)"],
		autoLoadWhen: [
			"Summarize the current project or a changed area",
			"Collect context relevant to one path before editing",
			"Get dependency-limited snapshots for prompt building",
		],
		rules: [
			"Prefer context when you want breadth over exact source snippets.",
			"Use --scope to target all, changed, or relevant-to:<path>.",
			"Lower --max-deps when you need a tighter prompt budget.",
		],
		skipWhen: [
			"You need exact implementation locations or ranked chunks",
			"You need a file tree or architecture graph instead of a summary",
		],
		firstCommands: [
			"npx indexer-cli context",
			"npx indexer-cli context --scope changed",
			"npx indexer-cli context --scope relevant-to:src/<area>",
		],
		notes: ["Valid --scope values: all, changed, relevant-to:<path>."],
	},
	{
		name: "symbol-explain",
		directory: "symbol-explain",
		description:
			"Use for one-symbol understanding with npx indexer-cli explain <symbol>.",
		heading: "Use symbol-explain for one symbol at a time",
		purpose:
			"Use this when the task centers on one function, class, type, or symbol and the agent needs signature, usage, and containing module context fast.",
		allowedTools: ["Bash(npx indexer-cli explain:*)"],
		autoLoadWhen: [
			"Understand what one symbol does",
			"Inspect the signature and callers of one function or class",
			"Get targeted context before editing a known symbol",
		],
		rules: [
			"Use explain only when the symbol name is already known.",
			"Do not use this skill for symbol discovery; use it only once the symbol name is already known.",
			"Keep the prompt centered on a single symbol for the cleanest output.",
		],
		skipWhen: [
			"You need to discover candidate symbols first",
			"You need repo-wide structure rather than one-symbol context",
		],
		firstCommands: ["npx indexer-cli explain <symbol>"],
	},
	{
		name: "dependency-trace",
		directory: "dependency-trace",
		description:
			"Use for caller/callee and impact-trace questions with npx indexer-cli deps <path>.",
		heading: "Use dependency-trace for impact analysis",
		purpose:
			"Use this when the agent needs to know who imports a module, what it imports, or how far change impact may spread.",
		allowedTools: ["Bash(npx indexer-cli deps:*)"],
		autoLoadWhen: [
			"Trace callers or callees for a module or symbol",
			"Estimate change impact before refactoring",
			"Follow dependency chains in one direction or both",
		],
		rules: [
			"Use deps when the question is about relationships, not source snippets.",
			"Set --direction callers or --direction callees when only one side matters.",
			"Increase depth only when the first hop is not enough.",
		],
		skipWhen: [
			"You need a repo-wide architecture snapshot rather than one trace",
			"You do not yet know the path or symbol to trace",
		],
		firstCommands: [
			"npx indexer-cli deps <path>",
			"npx indexer-cli deps <path> --direction callers",
			"npx indexer-cli deps <path> --direction callees",
		],
		notes: ["Valid --direction values: callers, callees, both."],
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
		content: renderSkill(definition),
	}),
);

export const GENERATED_SKILL_DIRECTORIES = GENERATED_SKILLS.map(
	(skill) => skill.directory,
);
