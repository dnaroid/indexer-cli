import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";

const tempDirs: string[] = [];

async function loadReinitInternals<T>(): Promise<T> {
	const filePath = path.resolve(
		import.meta.dirname,
		"../../../src/cli/commands/reinit.ts",
	);
	const source = readFileSync(filePath, "utf8");
	const match = source.match(
		/async function pathExists[\s\S]*?(?=export function registerReinitCommand)/,
	);
	if (!match) {
		throw new Error(`Unable to extract reinit helpers from ${filePath}`);
	}

	const transpiled = ts.transpileModule(
		`import { constants as fsConstants } from "node:fs";\nimport { access } from "node:fs/promises";\nimport path from "node:path";\n${match[0]}\nexport { pathExists };`,
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

const reinitInternals = await loadReinitInternals<{
	pathExists: (targetPath: string) => Promise<boolean>;
}>();

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("reinit directory scanning", () => {
	it("finds projects with .indexer-cli directory", async () => {
		const workspace = mkdtempSync(path.join(tmpdir(), "indexer-cli-reinit-"));
		tempDirs.push(workspace);

		mkdirSync(path.join(workspace, "project-a"));
		mkdirSync(path.join(workspace, "project-a", ".indexer-cli"));
		mkdirSync(path.join(workspace, "project-b"));
		mkdirSync(path.join(workspace, "project-b", ".indexer-cli"));
		mkdirSync(path.join(workspace, "project-c"));

		const entries = await readdir(workspace, { withFileTypes: true });
		const indexedProjects: string[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}

			const projectPath = path.join(workspace, entry.name);
			if (
				await reinitInternals.pathExists(path.join(projectPath, ".indexer-cli"))
			) {
				indexedProjects.push(projectPath);
			}
		}

		expect(indexedProjects).toHaveLength(2);
		expect(
			indexedProjects.map((projectPath) => path.basename(projectPath)).sort(),
		).toEqual(["project-a", "project-b"]);
	});

	it("ignores non-directory entries", async () => {
		const workspace = mkdtempSync(path.join(tmpdir(), "indexer-cli-reinit-"));
		tempDirs.push(workspace);

		mkdirSync(path.join(workspace, "project-a"));
		mkdirSync(path.join(workspace, "project-a", ".indexer-cli"));
		writeFileSync(path.join(workspace, "project-b"), "not a directory", "utf8");

		const entries = await readdir(workspace, { withFileTypes: true });
		const indexedProjects: string[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}

			const projectPath = path.join(workspace, entry.name);
			if (
				await reinitInternals.pathExists(path.join(projectPath, ".indexer-cli"))
			) {
				indexedProjects.push(projectPath);
			}
		}

		expect(indexedProjects).toEqual([path.join(workspace, "project-a")]);
	});

	it("returns empty for workspace with no indexed projects", async () => {
		const workspace = mkdtempSync(path.join(tmpdir(), "indexer-cli-reinit-"));
		tempDirs.push(workspace);

		mkdirSync(path.join(workspace, "project-a"));
		mkdirSync(path.join(workspace, "project-b"));
		mkdirSync(path.join(workspace, "project-c"));

		const entries = await readdir(workspace, { withFileTypes: true });
		const indexedProjects: string[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}

			const projectPath = path.join(workspace, entry.name);
			if (
				await reinitInternals.pathExists(path.join(projectPath, ".indexer-cli"))
			) {
				indexedProjects.push(projectPath);
			}
		}

		expect(indexedProjects).toEqual([]);
	});
});

describe("reinit source contract", () => {
	it("reinit command is registered in entry.ts", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/entry.ts"),
			"utf8",
		);

		expect(source).toContain(
			'import { registerReinitCommand } from "./commands/reinit.js";',
		);
		expect(source).toContain("registerReinitCommand(program);");
	});

	it("reinit is in SKIP_MIGRATION_COMMANDS", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/entry.ts"),
			"utf8",
		);

		expect(source).toContain('"reinit"');
		expect(source).toContain("const SKIP_MIGRATION_COMMANDS = new Set([");
	});

	it("reinit command imports performInit, performUninstall and refreshClaudeSkills", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/commands/reinit.ts"),
			"utf8",
		);

		expect(source).toContain(
			'import { performInit, refreshClaudeSkills } from "./init.js";',
		);
		expect(source).toContain(
			'import { performUninstall } from "./uninstall.js";',
		);
	});
});

describe("reinit command registration", () => {
	it("accepts <dir> argument and options", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/commands/reinit.ts"),
			"utf8",
		);

		expect(source).toContain(
			'.argument("<dir>", "path to workspace directory containing projects")',
		);
		expect(source).toContain(
			'.option("--skills-only", "only refresh skills without full reinstall")',
		);
		expect(source).toContain(
			'.option("-f, --force", "skip confirmation prompt")',
		);
	});
});
