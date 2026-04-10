import { describe, expect, it } from "vitest";
import { GENERATED_SKILLS } from "../../../src/cli/commands/skills.js";

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
});
