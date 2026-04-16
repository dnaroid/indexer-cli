import { afterEach, describe, expect, it } from "vitest";
import { detectInstallMethod } from "../../../src/core/update-check.js";

const originalArgv = process.argv.slice();

afterEach(() => {
	process.argv = originalArgv.slice();
});

describe("detectInstallMethod", () => {
	it("detects npx from cache path", () => {
		process.argv = [
			process.argv[0],
			"/home/user/.npm/_npx/abc123/node_modules/.bin/indexer-cli",
		];
		expect(detectInstallMethod()).toBe("npx");
	});

	it("detects pnpm-global install", () => {
		process.argv = [
			process.argv[0],
			"/home/user/.pnpm/global/xyz/node_modules/.bin/indexer-cli",
		];
		expect(detectInstallMethod()).toBe("pnpm-global");
	});

	it("detects yarn-global install", () => {
		process.argv = [
			process.argv[0],
			"/home/user/.yarn/global/node_modules/.bin/indexer-cli",
		];
		expect(detectInstallMethod()).toBe("yarn-global");
	});

	it("defaults to npm-global for standard bin paths", () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		expect(detectInstallMethod()).toBe("npm-global");
	});

	it("returns unknown when argv[1] is undefined", () => {
		process.argv = [process.argv[0]];
		expect(detectInstallMethod()).toBe("unknown");
	});

	it("returns unknown when argv[1] is empty string", () => {
		process.argv = [process.argv[0], ""];
		expect(detectInstallMethod()).toBe("unknown");
	});
});
