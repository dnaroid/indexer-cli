import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanProjectDocuments } from "../../../src/knowledge/document-scanner.js";

describe("scanProjectDocuments", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), "idx-doc-scan-"));
		tempDirs.push(dir);
		return dir;
	}

	it("keeps document files separate and filters configured noise", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "fixtures"), { recursive: true });
		await mkdir(path.join(root, ".claude/skills/demo"), { recursive: true });
		await writeFile(path.join(root, "docs/spec.md"), "# Contract\n", "utf8");
		await writeFile(path.join(root, "docs/readme.txt"), "notes\n", "utf8");
		await writeFile(path.join(root, "docs/code.ts"), "export {}\n", "utf8");
		await writeFile(path.join(root, "fixtures/fake.md"), "# Fixture\n", "utf8");
		await writeFile(
			path.join(root, ".claude/skills/demo/SKILL.md"),
			"# Skill\n",
			"utf8",
		);

		const result = await scanProjectDocuments(root, {
			extensions: [".md", ".txt"],
			excludePaths: ["fixtures/**", ".claude/skills/**"],
		});
		expect(result).toEqual(["docs/readme.txt", "docs/spec.md"]);
	});

	it("lets explicit include paths override document exclusions", async () => {
		const root = tempDir();
		await mkdir(path.join(root, "fixtures"), { recursive: true });
		await writeFile(path.join(root, "fixtures/real.md"), "# Contract\n", "utf8");
		const result = await scanProjectDocuments(root, {
			extensions: [".md"],
			includePaths: ["fixtures/real.md"],
			excludePaths: ["fixtures/**"],
		});
		expect(result).toEqual(["fixtures/real.md"]);
	});

	it("keeps oversized files discoverable but does not follow arbitrary symlinked directories", async () => {
		const root = tempDir();
		const external = tempDir();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(path.join(root, "docs/large.md"), "x".repeat(100), "utf8");
		await writeFile(path.join(external, "outside.md"), "# Outside\n", "utf8");
		await symlink(external, path.join(root, "linked-docs"));

		const result = await scanProjectDocuments(root, {
			extensions: [".md"],
		});
		expect(result).toEqual(["docs/large.md"]);
	});

	it("never sends explicitly included outside-root symlink documents to indexing", async () => {
		const root = tempDir();
		const external = tempDir();
		await writeFile(path.join(external, "outside.md"), "private content");
		await symlink(external, path.join(root, "linked-docs"));
		const warnings: string[] = [];
		const result = await scanProjectDocuments(root, {
			extensions: [".md"], includePaths: ["linked-docs/**"],
			onWarning: warning => warnings.push(warning.code),
		});
		expect(result).toEqual([]);
		expect(warnings).toEqual(["OUTSIDE_PROJECT"]);
	});
});
