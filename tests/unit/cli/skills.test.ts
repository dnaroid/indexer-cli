import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	GENERATED_SKILLS,
	GENERATED_SKILL_DIRECTORIES,
} from "../../../src/cli/commands/skills.js";

const readmePath = path.resolve(import.meta.dirname, "../../../README.md");

describe("generated discovery skills", () => {
	it("drops the old repo-discovery router skill", () => {
		expect(
			GENERATED_SKILLS.find((skill) => skill.name === "repo-discovery"),
		).toBe(undefined);
	});

	it("defines focused command skills with semantic names", () => {
		expect(GENERATED_SKILL_DIRECTORIES).toEqual([
			"semantic-search",
			"repo-structure",
			"repo-architecture",
			"repo-context",
			"symbol-explain",
			"dependency-trace",
		]);
		expect(GENERATED_SKILLS.map((skill) => skill.name)).toEqual(
			GENERATED_SKILL_DIRECTORIES,
		);
	});

	it("uses semantic naming for search-oriented skill guidance", () => {
		const searchSkill = GENERATED_SKILLS.find(
			(skill) => skill.name === "semantic-search",
		);

		expect(searchSkill?.content).toContain("name: semantic-search");
		expect(searchSkill?.content).not.toContain("## Choose this skill when");
		expect(searchSkill?.content).not.toContain("## Auto-load when");
		expect(searchSkill?.content).toContain(
			"# Use semantic-search for implementation hunting",
		);
	});

	it("binds each specialized skill to the matching command", () => {
		const searchSkill = GENERATED_SKILLS.find(
			(skill) => skill.name === "semantic-search",
		);
		const structureSkill = GENERATED_SKILLS.find(
			(skill) => skill.name === "repo-structure",
		);
		const architectureSkill = GENERATED_SKILLS.find(
			(skill) => skill.name === "repo-architecture",
		);
		const contextSkill = GENERATED_SKILLS.find(
			(skill) => skill.name === "repo-context",
		);
		const explainSkill = GENERATED_SKILLS.find(
			(skill) => skill.name === "symbol-explain",
		);
		const depsSkill = GENERATED_SKILLS.find(
			(skill) => skill.name === "dependency-trace",
		);

		expect(searchSkill?.content).toContain(
			"description: Use when you know the behavior or concept to find but not the file, and want ranked implementation candidates.",
		);
		expect(structureSkill?.content).toContain(
			"description: Use when you need the file-and-symbol layout of a directory or subsystem before reading implementation details.",
		);
		expect(architectureSkill?.content).toContain(
			"description: Use when you need a high-level view of entry points, modules, and cross-module dependencies in a subsystem or repo.",
		);
		expect(contextSkill?.content).toContain(
			"description: Use when you need a compact summary of the whole repo, current changes, or one area without opening many files.",
		);
		expect(explainSkill?.content).toContain(
			"description: Use when the symbol name is already known and you need its signature, module context, and callers fast.",
		);
		expect(depsSkill?.content).toContain(
			"description: Use when you already know the file or module to trace and need callers, callees, or likely change impact.",
		);

		expect(searchSkill?.content).toContain('npx indexer-cli search "<query>"');
		expect(searchSkill?.content).toContain(
			"allowed-tools: Bash(npx indexer-cli search:*)",
		);
		expect(searchSkill?.content).toContain(
			"Valid --chunk-types values: full_file, imports, preamble, declaration, module_section, impl, types.",
		);
		expect(structureSkill?.content).toContain(
			"npx indexer-cli structure --path-prefix src/<area>",
		);
		expect(structureSkill?.content).toContain(
			"allowed-tools: Bash(npx indexer-cli structure:*)",
		);
		expect(structureSkill?.content).toContain(
			"Valid --kind values: function, class, method, interface, type, variable, module, signal.",
		);
		expect(architectureSkill?.content).toContain(
			"npx indexer-cli architecture",
		);
		expect(architectureSkill?.content).toContain(
			"allowed-tools: Bash(npx indexer-cli architecture:*)",
		);
		expect(contextSkill?.content).toContain(
			"npx indexer-cli context --scope changed",
		);
		expect(contextSkill?.content).toContain(
			"allowed-tools: Bash(npx indexer-cli context:*)",
		);
		expect(contextSkill?.content).toContain(
			"Valid --scope values: all, changed, relevant-to:<path>.",
		);
		expect(explainSkill?.content).toContain("npx indexer-cli explain <symbol>");
		expect(explainSkill?.content).toContain(
			"allowed-tools: Bash(npx indexer-cli explain:*)",
		);
		expect(depsSkill?.content).toContain(
			"npx indexer-cli deps <path> --direction callers",
		);
		expect(depsSkill?.content).toContain(
			"allowed-tools: Bash(npx indexer-cli deps:*)",
		);
		expect(depsSkill?.content).toContain(
			"Valid --direction values: callers, callees, both.",
		);
		expect(searchSkill?.content).not.toContain("npx indexer-cli setup");
		expect(searchSkill?.content).not.toContain("npx indexer-cli uninstall");
		expect(explainSkill?.content).toContain(
			"Do not use this skill for symbol discovery; use it only once the symbol name is already known.",
		);
	});

	it("keeps README agent integration examples aligned with generated discovery skills", () => {
		const readme = readFileSync(readmePath, "utf8");

		expect(readme).toContain('npx indexer-cli search "<query>"');
		expect(readme).toContain(
			"npx indexer-cli structure --path-prefix src/<area>",
		);
		expect(readme).toContain("npx indexer-cli architecture");
		expect(readme).toContain(
			"npx indexer-cli context --scope relevant-to:src/<area>",
		);
		expect(readme).not.toContain("npx indexer-cli index --status");
	});
});
