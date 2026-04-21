import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package launcher script", () => {
	it("uses node entrypoint and is not self-recursive shell wrapper", () => {
		const launcherPath = path.resolve(
			import.meta.dirname,
			"../../../bin/indexer-cli.js",
		);
		const content = readFileSync(launcherPath, "utf8");

		expect(content).toContain("#!/usr/bin/env node");
		expect(content).toContain('require("../dist/cli/entry.js")');
		expect(content).not.toContain("exec '/usr/local/bin/indexer-cli' \"$@\"");
	});
});
