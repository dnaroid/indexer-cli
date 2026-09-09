import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	expandReferenceToken,
	extractExplicitKnowledgeRelations,
	strongUnresolvedPathHint,
} from "../../../src/knowledge/relations.js";

describe("knowledge relation extraction", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), "idx-relations-"));
		tempDirs.push(dir);
		return dir;
	}

	it("resolves source-relative, package-relative, and linked knowledge paths", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "packages/tool/docs"), { recursive: true });
		await mkdir(path.join(root, "packages/tool/src"), { recursive: true });
		await mkdir(path.join(root, "packages/tool/tests"), { recursive: true });
		await writeFile(path.join(root, "packages/tool/package.json"), "{}", "utf8");
		await writeFile(path.join(root, "packages/tool/src/session.ts"), "export {}", "utf8");
		await writeFile(path.join(root, "packages/tool/tests/session.test.ts"), "test('',()=>{})", "utf8");
		await writeFile(path.join(root, "packages/tool/docs/auth.md"), "# Auth\n", "utf8");
		const source = "packages/tool/docs/session.md";
		await writeFile(path.join(root, source), "# Session\n", "utf8");

		const relations = await extractExplicitKnowledgeRelations(
			root,
			source,
			"See `src/session.ts`, `tests/session.test.ts`, and [Auth](./auth.md \"title\").",
		);
		expect(relations.code).toEqual([
			"packages/tool/src/session.ts",
			"packages/tool/tests/session.test.ts",
		]);
		expect(relations.knowledge).toEqual(["packages/tool/docs/auth.md"]);
		expect(relations.unresolved).toEqual([]);
	});

	it("uses explicit prose base hints and reports only strong unresolved paths", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "external/tool/src"), { recursive: true });
		await mkdir(path.join(root, "specs"), { recursive: true });
		await writeFile(path.join(root, "external/tool/src/worker.ts"), "export {}", "utf8");
		await writeFile(path.join(root, "specs/root.md"), "# Root\n", "utf8");

		const relations = await extractExplicitKnowledgeRelations(
			root,
			"specs/root.md",
			"Paths below are relative to `external/tool/`. Current input: `src/worker.ts`. Missing: `tests/missing.test.ts`. Command: `/foo/bar`.",
		);
		expect(relations.code).toEqual(["external/tool/src/worker.ts"]);
		expect(relations.unresolved).toEqual(["tests/missing.test.ts"]);
	});

	it("never resolves a symlink target outside the repository", async () => {
		const root = tempDir();
		const external = tempDir();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(path.join(root, "docs/spec.md"), "# Spec\n", "utf8");
		await writeFile(path.join(external, "secret.ts"), "secret", "utf8");
		await symlink(path.join(external, "secret.ts"), path.join(root, "docs/escape.ts"));

		const relations = await extractExplicitKnowledgeRelations(
			root,
			"docs/spec.md",
			"`./escape.ts`",
		);
		expect(relations.code).toEqual([]);
	});

	it("expands simple brace groups and limits unresolved hints to path-like tokens", () => {
		expect(expandReferenceToken("src/{a,b}.ts")).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
		expect(strongUnresolvedPathHint("src/missing.ts")).toBe(true);
		expect(strongUnresolvedPathHint("https://example.com/x.ts")).toBe(false);
	});
});

