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
		expect(skill?.content).toContain("npx -y indexer-cli context");
	});

	it("keeps the refined semantic-search template structure", () => {
		const skill = GENERATED_SKILLS.find(
			(entry) => entry.name === "semantic-search",
		);

		expect(skill).toBeDefined();
		expect(skill?.content).toContain("## Mandatory rules");
		expect(skill?.content).toContain("### 3) Two-phase retrieval — ALWAYS");
		expect(skill?.content).toContain("## Skip when");
		expect(skill?.content).toContain("## CLI reference");
		expect(skill?.content).toContain("## Anti-patterns");
		expect(skill?.content).toContain(
			"Use when semantic search is already the right tool.",
		);
		expect(skill?.content).toContain(
			"Keep the query short and centered on one code concept.",
		);
	});

	it("renders the intro and focus hint structure for every generated skill that uses renderSkill", () => {
		for (const skill of GENERATED_SKILLS) {
			if (skill.name === "semantic-search") continue;
			expectIntroParagraphStructure(skill.content);
		}
	});
});
