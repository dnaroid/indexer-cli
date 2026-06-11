import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

async function loadUpdateInternals<T>(): Promise<T> {
	const filePath = path.resolve(
		import.meta.dirname,
		"../../../src/cli/commands/update.ts",
	);
	const source = readFileSync(filePath, "utf8");
	const match = source.match(
		/function resolveUpdatedCliInvocation[\s\S]*?(?=function runFreshSkillsRefresh)/,
	);
	if (!match) {
		throw new Error(`Unable to extract update internals from ${filePath}`);
	}

	(globalThis as typeof globalThis & { __updateTestMocks?: unknown }).__updateTestMocks = {
		existsSync: (target: string) => target === "/tmp/prefix/bin/idx",
		processValue: {
			argv: ["node", "/tmp/prefix/bin/idx", "update"],
			execPath: "/usr/bin/node",
		},
	};

	const transpiled = ts.transpileModule(
		`const existsSync = globalThis.__updateTestMocks.existsSync;
const process = globalThis.__updateTestMocks.processValue;
${match[0]}
export { resolveUpdatedCliInvocation };`,
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

const updateInternals = await loadUpdateInternals<{
	resolveUpdatedCliInvocation: () => { command: string; args: string[] };
}>();

describe("update command helpers", () => {
	it("reruns doctor through the current node launcher instead of relying on idx on PATH", () => {
		expect(updateInternals.resolveUpdatedCliInvocation()).toEqual({
			command: "/usr/bin/node",
			args: ["/tmp/prefix/bin/idx"],
		});
	});
});
