import { describe, expect, it } from "vitest";
import { GENERATED_SKILLS } from "../../../src/cli/commands/skills.js";

describe("generated skills", () => {
	it("includes the context-pack skill template", () => {
		const skill = GENERATED_SKILLS.find(
			(entry) => entry.name === "context-pack",
		);

		expect(skill).toBeDefined();
		expect(skill?.directory).toBe("context-pack");
		expect(skill?.content).toContain("name: context-pack");
		expect(skill?.content).toContain("npx indexer-cli context-pack");
	});
});
