import { describe, expect, it } from "vitest";
import { GENERATED_SKILLS } from "../../../src/cli/commands/skills.js";

function expectIntroParagraphStructure(content: string): void {
	expect(content).toMatch(
		/# .*\n\nUse this when .*\.\n\n[A-Z].*\.\n\n## Rules/s,
	);
}

describe("generated skills", () => {
	it("does not generate the removed context-pack skill", () => {
		expect(
			GENERATED_SKILLS.some((entry) => entry.name === "context-pack"),
		).toBe(false);
	});

	it("still generates the repo-context skill", () => {
		const skill = GENERATED_SKILLS.find(
			(entry) => entry.name === "repo-context",
		);

		expect(skill).toBeDefined();
		expect(skill?.directory).toBe("repo-context");
		expect(skill?.content).toContain("name: repo-context");
		expect(skill?.content).toContain("npx indexer-cli context");
	});

	it("keeps the refined semantic-search template structure", () => {
		const skill = GENERATED_SKILLS.find(
			(entry) => entry.name === "semantic-search",
		);

		expect(skill).toBeDefined();
		expect(skill?.content).toContain(
			"Use this when the agent already knows it needs semantic search results, not a tree or architecture map.",
		);
		expect(skill?.content).toContain(
			"Keep the prompt short and centered on the code concept to find.",
		);
		expect(skill?.content).toContain("## Skip when");
		expect(skill?.content).toContain("## CLI reference");
		expectIntroParagraphStructure(skill!.content);
	});

	it("renders the intro and focus hint structure for every generated skill", () => {
		for (const skill of GENERATED_SKILLS) {
			expectIntroParagraphStructure(skill.content);
		}
	});
});
