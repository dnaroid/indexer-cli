import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerWikiCommand } from "../../../src/cli/commands/wiki.js";

describe("wiki command registration", () => {
	it("registers receipt verification and offline lexical search commands", () => {
		const program = new Command();
		registerWikiCommand(program);
		const wiki = program.commands.find((command) => command.name() === "wiki");
		expect(wiki?.commands.map((command) => command.name())).toEqual(
			expect.arrayContaining(["prepare", "verify", "search"]),
		);
		expect(wiki?.commands.find((command) => command.name() === "verify")?.options.map((option) => option.long)).toEqual(
			expect.arrayContaining(["--path", "--receipt"]),
		);
		expect(wiki?.commands.find((command) => command.name() === "search")?.options.map((option) => option.long)).toContain("--mode");
	});
});
