type SkillDefinition = {
  name: string;
  directory: string;
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
  ]

  if (definition.focusHint) {
    sections.push(definition.focusHint, "")
  }

  sections.push("## Rules", "", ...definition.rules.map((item) => `- ${item}`))

  if (definition.skipWhen && definition.skipWhen.length > 0) {
    sections.push(
      "",
      "## Skip when",
      "",
      ...definition.skipWhen.map((item) => `- ${item}`),
    )
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
  )

  if (definition.cliReference && definition.cliReference.length > 0) {
    sections.push(
      "",
      "## CLI reference",
      "",
      ...definition.cliReference.map((item) => `- ${item}`),
    )
  }

  return `${sections.join("\n")}\n`
}

const SKILL_DEFINITIONS: SkillDefinition[] = [
  {
    name: "semantic-search",
    directory: "semantic-search",
    description: `FIRST choice for CONCEPT and BEHAVIOR questions like "how is quiz scoring calculated" or "what happens on subscription cancel". Do NOT use for keyword/identifier lookups — use grep instead. If the search term is also a code identifier (entity name, class name, variable name), this is the WRONG tool.`,
    heading: "Use semantic-search for implementation hunting",
    useWhen:
      "Use this when the agent already knows it needs semantic search results, not a tree or architecture map.",
    focusHint:
      "Keep the prompt short and centered on the code concept to find.",
    allowedTools: ["Bash(npx indexer-cli search:*)"],
    rules: [
      `**2-4 domain-specific words**: "how claim prize", "billing webhook", "quiz scoring"`,
      `Do NOT write long queries with synonyms — it dilutes ranking.`,
      "Prefer compact JSON fields first; include content only after the right chunk is found.",
      "Use --path-prefix or --chunk-types when you already know the likely area.",
    ],
    skipWhen: [
      "You need a file tree or symbol inventory instead of search results",
      "You already know the exact file and line range to inspect",
    ],
    commandSamples: [
      "npx indexer-cli search \"<query>\"",
      "npx indexer-cli search \"<query>\" --path-prefix src/<area>",
      "npx indexer-cli search \"<query>\" --chunk-types impl,types",
    ],
    cliReference: [
      "Positional args: <query>.",
      "Options: --max-files <number>, --path-prefix <string>, --chunk-types <string>, --fields <list>, --min-score <number>, --include-content.",
      "Allowed --chunk-types values: full_file, imports, preamble, declaration, module_section, impl, types.",
      "Allowed --fields values: filePath, startLine, endLine, score, primarySymbol, content.",
    ],
  },
  {
    name: "repo-structure",
    directory: "repo-structure",
    description:
      `FIRST choice when you need to see what's inside a package/directory — all files, classes, functions, exports in a tree. Produces a symbol-level map of any path prefix. Use BEFORE opening multiple files to understand layout. Triggers: "show me the structure of X", "what's in this module", "list the symbols".`,
    heading: "Use repo-structure for tree and symbol-map questions",
    useWhen:
      "Use this when the agent needs to see how files and symbols are organized in an area of the repo before reading implementation details.",
    focusHint:
      "Keep the request centered on one repo area or one symbol kind so the tree stays readable.",
    allowedTools: ["Bash(npx indexer-cli structure:*)"],
    rules: [
      "Prefer structure when layout matters more than implementation snippets.",
      "Use --path-prefix and --kind to keep output focused.",
      "Use JSON output for agents unless a human explicitly asks for text.",
    ],
    skipWhen: [
      "You need dependency relationships rather than physical structure",
      "You need semantic search results rather than a tree",
    ],
    commandSamples: [
      "npx indexer-cli structure",
      "npx indexer-cli structure --path-prefix src/<area>",
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
    description:
      `FIRST choice when user asks "what is this project", "explain the codebase", "how is this organized". Produces a full dependency graph, entry points, and module breakdown — everything needed to understand a repo without reading individual files. Use BEFORE reading package.json or exploring directories manually.`,
    heading: "Use repo-architecture for dependency-graph questions",
    useWhen:
      "Use this when the agent needs a high-level snapshot of modules, entry points, and dependency shape before going deeper.",
    focusHint:
      "Keep the scope to the subsystem that matters so the graph highlights the right boundaries.",
    allowedTools: ["Bash(npx indexer-cli architecture:*)"],
    rules: [
      "Use architecture when the question is about system shape, not a single symbol.",
      "Filter by path prefix when only one subsystem matters.",
      "Use JSON output to preserve structured dependency data.",
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
      "FIRST choice for changed-area and subsystem summaries. Load this before opening many files when you need whole-repo orientation, changed-scope context, or a dependency-neighborhood snapshot without exact implementation snippets.",
    heading: "Use repo-context for dense summaries",
    useWhen:
      "Use this when the agent wants a compressed view of a subsystem, changed area, or dependency neighborhood without opening many files.",
    focusHint:
      "Keep the scope explicit so the summary stays dense instead of drifting across the repo.",
    allowedTools: ["Bash(npx indexer-cli context:*)"],
    rules: [
      "Prefer context when you want breadth over exact source snippets.",
      "Use --scope to target all, changed, or relevant-to:<path>.",
      "Lower --max-deps when you need a tighter prompt budget.",
    ],
    skipWhen: [
      "You need exact implementation locations or ranked chunks",
      "You need a file tree or architecture graph instead of a summary",
    ],
    commandSamples: [
      "npx indexer-cli context",
      "npx indexer-cli context --scope changed",
      "npx indexer-cli context --scope relevant-to:src/<area>",
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
      "FIRST choice once the symbol name is known. Load this before manual caller/signature tracing to get one symbol's signature, module context, and callers fast.",
    heading: "Use symbol-explain for one symbol at a time",
    useWhen:
      "Use this when the task centers on one function, class, type, or symbol and the agent needs signature, usage, and containing module context fast.",
    focusHint:
      "Keep the request centered on one symbol name for the cleanest caller and signature output.",
    allowedTools: ["Bash(npx indexer-cli explain:*)"],
    rules: [
      "Use explain only when the symbol name is already known.",
      "Do not use this skill for symbol discovery; use it only once the symbol name is already known.",
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
      "FIRST choice once the file or module is known and impact matters. Load this before manual import tracing to see callers, callees, and likely change impact.",
    heading: "Use dependency-trace for impact analysis",
    useWhen:
      "Use this when the agent needs to know who imports a module, what it imports, or how far change impact may spread.",
    focusHint:
      "Start with a single path or module and keep depth low until the first-hop trace stops being enough.",
    allowedTools: ["Bash(npx indexer-cli deps:*)"],
    rules: [
      "Use deps when the question is about relationships, not source snippets.",
      "Set --direction callers or --direction callees when only one side matters.",
      "Increase depth only when the first hop is not enough.",
    ],
    skipWhen: [
      "You need a repo-wide architecture snapshot rather than one trace",
      "You do not yet know the path or symbol to trace",
    ],
    commandSamples: [
      "npx indexer-cli deps <path>",
      "npx indexer-cli deps <path> --direction callers",
      "npx indexer-cli deps <path> --direction callees",
    ],
    cliReference: [
      "Positional args: <path>.",
      "Output: JSON by default; use --txt for human-readable text.",
      "Options: --direction <dir>, --depth <n>, --txt.",
      "Allowed --direction values: callers, callees, both.",
      "Behavior: --depth is effectively clamped to the range 1..5.",
    ],
  },
]

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
)

export const DEPRECATED_SKILL_DIRECTORIES = ["context-pack"]

export const GENERATED_SKILL_DIRECTORIES = GENERATED_SKILLS.map(
  (skill) => skill.directory,
)
