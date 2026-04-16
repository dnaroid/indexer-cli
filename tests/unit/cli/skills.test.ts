import { describe, expect, it } from "vitest";
import { GENERATED_SKILLS } from "../../../src/cli/commands/skills.js";

function expectIntroParagraphStructure(content: string): void {
	expect(content).toMatch(
		/# .*\n\nUse this .*\.\n\n[A-Z].*\.\n\n## Route to one command/s,
	);
}

describe("generated skills", () => {
	it("does not generate the removed context-pack skill", () => {
		expect(
			GENERATED_SKILLS.some((entry) => entry.name === "context-pack"),
		).toBe(false);
	});

	it("generates only the consolidated repo-discovery skill", () => {
		expect(GENERATED_SKILLS).toHaveLength(1);
		expect(GENERATED_SKILLS[0]?.name).toBe("repo-discovery");
	});

	it("keeps the consolidated repo-discovery routing structure", () => {
		const skill = GENERATED_SKILLS.find(
			(entry) => entry.name === "repo-discovery",
		);

		expect(skill).toBeDefined();
		expect(skill?.content).toContain(
			"# Use repo-discovery as the indexed entry point",
		);
		expect(skill?.content).toContain("## Route to one command");
		expect(skill?.content).toContain("## Operating rules");
		expect(skill?.content).toContain("## Skip idx when");
		expect(skill?.content).toContain("## CLI reference");
		expect(skill?.content).toContain(
			"Use this skill first for unfamiliar codebases",
		);
		expect(skill?.content).toContain(
			"Pick the single cheapest command that answers the question, run it, and stop when you have enough context.",
		);
	});

	it("keeps the intro and next-step structure readable", () => {
		expectIntroParagraphStructure(GENERATED_SKILLS[0]!.content);
	});

	it("all skills reference idx, not npx", () => {
		for (const skill of GENERATED_SKILLS) {
			expect(
				skill.content,
				`${skill.name} should not contain "npx -y indexer-cli"`,
			).not.toContain("npx -y indexer-cli");

			const hasIdxCommand = [
				"idx search",
				"idx structure",
				"idx architecture",
				"idx explain",
				"idx deps",
			].some((cmd) => skill.content.includes(cmd));
			expect(
				hasIdxCommand,
				`${skill.name} should contain an idx command (search, structure, architecture, explain, or deps)`,
			).toBe(true);
		}
	});

	it("all skill allowed-tools use idx", () => {
		for (const skill of GENERATED_SKILLS) {
			expect(skill.content).toMatch(/allowed-tools:.*Bash\(idx/);
			expect(
				skill.content,
				`${skill.name} should not have allowed-tools with npx`,
			).not.toMatch(/allowed-tools:.*Bash\(npx/);
			expect(skill.content).toContain("Bash(idx architecture:*)");
			expect(skill.content).toContain("Bash(idx structure:*)");
			expect(skill.content).toContain("Bash(idx search:*)");
			expect(skill.content).toContain("Bash(idx explain:*)");
			expect(skill.content).toContain("Bash(idx deps:*)");
		}
	});
});
