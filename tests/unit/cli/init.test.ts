import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";

const tempDirs: string[] = [];

async function loadInitInternals<T>(): Promise<T> {
	const filePath = path.resolve(
		import.meta.dirname,
		"../../../src/cli/commands/init.ts",
	);
	const source = readFileSync(filePath, "utf8");
	const match = source.match(
		/async function pathExists[\s\S]*?(?=async function ensureGitignoreEntries)/,
	);
	if (!match) {
		throw new Error(`Unable to extract init helpers from ${filePath}`);
	}

	const transpiled = ts.transpileModule(
		`import { constants as fsConstants } from "node:fs";\nimport { access, mkdir, rm, writeFile } from "node:fs/promises";\nimport path from "node:path";\n${match[0]}\nexport { pathExists, writeClaudeSkills, refreshClaudeSkills };`,
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

const initInternals = await loadInitInternals<{
	refreshClaudeSkills: (
		projectRoot: string,
		skillDirectories?: string[],
		skills?: Array<{ directory: string; content: string }>,
		deprecatedSkillDirectories?: string[],
	) => Promise<void>;
}>();

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("init command helpers", () => {
	it("refreshes only this CLI's generated skill directories", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-"));
		tempDirs.push(projectRoot);

		const skillsRoot = path.join(projectRoot, ".claude", "skills");
		mkdirSync(path.join(skillsRoot, "repo-discovery"), { recursive: true });
		mkdirSync(path.join(skillsRoot, "custom-skill"), { recursive: true });
		writeFileSync(
			path.join(skillsRoot, "repo-discovery", "SKILL.md"),
			"stale repo discovery",
			"utf8",
		);
		writeFileSync(
			path.join(skillsRoot, "custom-skill", "SKILL.md"),
			"keep me",
			"utf8",
		);

		await initInternals.refreshClaudeSkills(
			projectRoot,
			["repo-discovery"],
			[
				{
					directory: "repo-discovery",
					content: "name: repo-discovery\n",
				},
			],
		);

		const repoDiscovery = readFileSync(
			path.join(skillsRoot, "repo-discovery", "SKILL.md"),
			"utf8",
		);
		const customSkill = readFileSync(
			path.join(skillsRoot, "custom-skill", "SKILL.md"),
			"utf8",
		);
		const skillDirectories = readdirSync(skillsRoot).sort();

		expect(repoDiscovery).toContain("name: repo-discovery");
		expect(skillDirectories).toEqual(["custom-skill", "repo-discovery"]);
		expect(customSkill).toBe("keep me");
	});

	it("removes deprecated generated skill directories during refresh", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "indexer-cli-init-"));
		tempDirs.push(projectRoot);

		const skillsRoot = path.join(projectRoot, ".claude", "skills");
		mkdirSync(path.join(skillsRoot, "semantic-search"), { recursive: true });
		writeFileSync(
			path.join(skillsRoot, "semantic-search", "SKILL.md"),
			"old multi-skill artifact",
			"utf8",
		);
		mkdirSync(path.join(skillsRoot, "context-pack"), { recursive: true });
		writeFileSync(
			path.join(skillsRoot, "context-pack", "SKILL.md"),
			"deprecated skill",
			"utf8",
		);

		await initInternals.refreshClaudeSkills(
			projectRoot,
			["repo-discovery"],
			[
				{
					directory: "repo-discovery",
					content: "name: repo-discovery\n",
				},
			],
			["context-pack", "semantic-search"],
		);

		expect(() =>
			readFileSync(path.join(skillsRoot, "context-pack", "SKILL.md"), "utf8"),
		).toThrow();
		expect(() =>
			readFileSync(
				path.join(skillsRoot, "semantic-search", "SKILL.md"),
				"utf8",
			),
		).toThrow();
		const repoDiscovery = readFileSync(
			path.join(skillsRoot, "repo-discovery", "SKILL.md"),
			"utf8",
		);
		const skillDirectories = readdirSync(skillsRoot);
		expect(repoDiscovery).toContain("name: repo-discovery");
		expect(skillDirectories).toEqual(["repo-discovery"]);
	});
});

describe("init command hook", () => {
	it("uses idx command in post-commit hook", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/commands/init.ts"),
			"utf8",
		);
		expect(source).toContain("idx index --skip-if-locked");
		expect(source).not.toContain("npx -y indexer-cli index");
	});
});
