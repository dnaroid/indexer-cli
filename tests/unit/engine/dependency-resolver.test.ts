import { describe, expect, it } from "vitest";
import { resolveDependency } from "../../../src/engine/dependency-resolver.js";

describe("resolveDependency", () => {
	it("classifies node: imports as builtins", () => {
		expect(resolveDependency("node:fs", "src/index.ts", new Set())).toEqual({
			dependencyType: "builtin",
		});
	});

	it("classifies NODE_BUILTINS imports as builtins", () => {
		expect(resolveDependency("path", "src/index.ts", new Set())).toEqual({
			dependencyType: "builtin",
		});
		expect(resolveDependency("fs/promises", "src/index.ts", new Set())).toEqual(
			{
				dependencyType: "builtin",
			},
		);
	});

	it("classifies non-relative imports as external", () => {
		expect(resolveDependency("react", "src/index.ts", new Set())).toEqual({
			dependencyType: "external",
		});
	});

	it("resolves relative imports with an exact file match", () => {
		const knownFiles = new Set(["src/utils.ts"]);

		expect(resolveDependency("./utils.ts", "src/index.ts", knownFiles)).toEqual(
			{
				dependencyType: "internal",
				toPath: "src/utils.ts",
			},
		);
	});

	it("resolves .js import specifiers to .ts and .tsx files", () => {
		expect(
			resolveDependency(
				"./utils.js",
				"src/index.ts",
				new Set(["src/utils.ts"]),
			),
		).toEqual({
			dependencyType: "internal",
			toPath: "src/utils.ts",
		});

		expect(
			resolveDependency(
				"./Button.jsx",
				"src/index.ts",
				new Set(["src/Button.tsx"]),
			),
		).toEqual({
			dependencyType: "internal",
			toPath: "src/Button.tsx",
		});
	});

	it("resolves directory imports to index files", () => {
		expect(
			resolveDependency("./lib", "src/index.ts", new Set(["src/lib/index.ts"])),
		).toEqual({
			dependencyType: "internal",
			toPath: "src/lib/index.ts",
		});

		expect(
			resolveDependency(
				"./components",
				"src/index.ts",
				new Set(["src/components/index.tsx"]),
			),
		).toEqual({
			dependencyType: "internal",
			toPath: "src/components/index.tsx",
		});
	});

	it("returns internal without toPath for unknown relative imports", () => {
		expect(resolveDependency("./missing", "src/index.ts", new Set())).toEqual({
			dependencyType: "internal",
		});
	});
});
