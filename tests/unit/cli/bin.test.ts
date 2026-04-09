import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const launcher = require(path.join(repoRoot, "bin", "indexer-cli.js")) as {
	buildLaunchSpec: (options?: {
		argv?: string[];
		existsSyncFn?: (filePath: string) => boolean;
	}) => { command: string; args: string[] };
	resolveTsxCliPath: (options?: {
		existsSyncFn?: (filePath: string) => boolean;
	}) => string | null;
};

describe("CLI launcher", () => {
	it("prefers the compiled dist entry when available", () => {
		const spec = launcher.buildLaunchSpec({
			argv: ["setup"],
			existsSyncFn: (filePath) => filePath.endsWith("dist/cli/entry.js"),
		});

		expect(spec.command).toBe(process.execPath);
		expect(spec.args).toHaveLength(2);
		expect(spec.args[0]).toMatch(/dist[\\/]cli[\\/]entry\.js$/);
		expect(spec.args[1]).toBe("setup");
	});

	it("falls back to the local tsx runtime when dist output is missing", () => {
		const spec = launcher.buildLaunchSpec({
			argv: ["search", "foo"],
			existsSyncFn: (filePath) =>
				filePath.endsWith("node_modules/tsx/dist/cli.mjs"),
		});

		expect(spec.command).toBe(process.execPath);
		expect(spec.args).toHaveLength(4);
		expect(spec.args[0]).toMatch(/node_modules[\\/]tsx[\\/]dist[\\/]cli\.mjs$/);
		expect(spec.args[1]).toMatch(/src[\\/]cli[\\/]entry\.ts$/);
		expect(spec.args.slice(2)).toEqual(["search", "foo"]);
	});

	it("throws a clear error when neither dist output nor tsx exists", () => {
		expect(() =>
			launcher.buildLaunchSpec({
				argv: ["setup"],
				existsSyncFn: () => false,
			}),
		).toThrow(
			/neither dist\/cli\/entry\.js nor a local tsx runtime was found/i,
		);
	});

	it("resolves the local tsx cli path when installed in node_modules", () => {
		const tsxCliPath = launcher.resolveTsxCliPath({
			existsSyncFn: (filePath) =>
				filePath.endsWith("node_modules/tsx/dist/cli.mjs"),
		});

		expect(tsxCliPath).toMatch(/node_modules[\\/]tsx[\\/]dist[\\/]cli\.mjs$/);
	});
});
