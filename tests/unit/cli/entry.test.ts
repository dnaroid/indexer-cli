import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

async function loadEntryInternals<T>(): Promise<T> {
	const filePath = path.resolve(
		import.meta.dirname,
		"../../../src/cli/entry.ts",
	);
	const source = readFileSync(filePath, "utf8");
	const match = source.match(
		/const HANDLED_COMMANDER_EXIT_CODES[\s\S]*?(?=program\n\t\.name)/,
	);
	if (!match) {
		throw new Error(`Unable to extract internals from ${filePath}`);
	}

	const transpiled = ts.transpileModule(
		`${match[0]}\nexport { HANDLED_COMMANDER_EXIT_CODES, isHandledCommanderExit };`,
		{
			compilerOptions: {
				module: ts.ModuleKind.ES2022,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText;

	const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
	return (await import(moduleUrl)) as T;
}

const entryInternals = await loadEntryInternals<{
	HANDLED_COMMANDER_EXIT_CODES: Set<string>;
	isHandledCommanderExit: (error: unknown) => boolean;
}>();

describe("CLI entry error handling", () => {
	it("treats commander help and version exits as handled", () => {
		expect(entryInternals.HANDLED_COMMANDER_EXIT_CODES).toEqual(
			new Set([
				"commander.helpDisplayed",
				"commander.help",
				"commander.version",
				"commander.unknownCommand",
				"commander.missingArgument",
				"indexer.preActionFailed",
			]),
		);
		expect(
			entryInternals.isHandledCommanderExit({
				code: "commander.helpDisplayed",
			}),
		).toBe(true);
		expect(
			entryInternals.isHandledCommanderExit({ code: "commander.help" }),
		).toBe(true);
		expect(
			entryInternals.isHandledCommanderExit({ code: "commander.version" }),
		).toBe(true);
		expect(
			entryInternals.isHandledCommanderExit({
				code: "commander.unknownCommand",
			}),
		).toBe(true);
		expect(
			entryInternals.isHandledCommanderExit({
				code: "commander.missingArgument",
			}),
		).toBe(true);
		expect(
			entryInternals.isHandledCommanderExit({
				code: "indexer.preActionFailed",
			}),
		).toBe(true);
	});

	it("ignores unrelated values and exit codes", () => {
		expect(entryInternals.isHandledCommanderExit(undefined)).toBe(false);
		expect(entryInternals.isHandledCommanderExit(null)).toBe(false);
		expect(entryInternals.isHandledCommanderExit(new Error("boom"))).toBe(
			false,
		);
		expect(entryInternals.isHandledCommanderExit({ code: "other" })).toBe(
			false,
		);
	});
});
