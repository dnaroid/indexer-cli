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
			// semantic-search uses rawContent, so its allowed-tools line is embedded in the YAML
			if (skill.name === "semantic-search") {
				expect(skill.content).toContain("Bash(idx search:*)");
				expect(skill.content).not.toContain("Bash(npx");
				continue;
			}
			// rendered skills have an explicit allowed-tools line from renderSkill()
			expect(
				skill.content,
				`${skill.name} should have allowed-tools with idx`,
			).toMatch(/allowed-tools:.*Bash\(idx/);
			expect(
				skill.content,
				`${skill.name} should not have allowed-tools with npx`,
			).not.toMatch(/allowed-tools:.*Bash\(npx/);
		}
	});
});
