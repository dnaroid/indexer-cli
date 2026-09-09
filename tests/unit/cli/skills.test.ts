import { describe, expect, it } from "vitest";
import { GENERATED_SKILLS } from "../../../src/cli/commands/skills.js";

function expectIntroParagraphStructure(content: string): void {
	expect(content).toMatch(
		/# Indexed repository guidance\n\nPick the single cheapest indexed command[\s\S]*?## Route/s,
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
		expect(skill?.content).toContain("# Indexed repository guidance");
		expect(skill?.content).toContain("## Route");
		expect(skill?.content).toContain("## Compact tool guidance");
		expect(skill?.content).toContain("## Knowledge rules");
		expect(skill?.content).toContain("## Stop conditions");
		expect(skill?.content).toContain(
			"Pick the single cheapest indexed command that answers the question.",
		);
		expect(skill?.content).toContain("idx context <query>");
		expect(skill?.content).toContain("idx wiki search <query>");
		expect(skill?.content).toContain("idx wiki impact <task-paths...>");
		expect(skill?.content).toContain("idx wiki record` classifies/indexes metadata");
	});

	it("mirrors the proven compact repo-discovery guidance", () => {
		const content = GENERATED_SKILLS[0]!.content;
		expect(content).toContain("idx search <query> --max-files 3");
		expect(content).toContain("--max-files 20 --max-depth 2");
		expect(content).toContain("--max-depth 3 --max-nodes 40 --no-include-text");
		expect(content).toContain("--signature-only");
		expect(content).toContain("--depth 1");
		expect(content).toContain("First pass is at\n  most 3 results and no `--include-content`");
		expect(content).toContain("Exact identifier, phrase, path, or regex is lookup");
		expect(content).toContain("After finding causal code, stop broad search");
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
				"idx context",
				"idx wiki",
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
			expect(skill.content).toContain("Bash(idx context:*)");
			expect(skill.content).toContain("Bash(idx wiki:*)");
		}
	});
});
