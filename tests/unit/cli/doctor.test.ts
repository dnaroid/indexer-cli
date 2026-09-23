import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addProject } from "../../../src/core/registry.js";
import { SKILLS_VERSION } from "../../../src/core/skills-version.js";
import { installSpecTemplate, SPEC_TEMPLATE } from "../../../src/cli/spec-template.js";
import { registerDoctorCommand } from "../../../src/cli/commands/doctor.js";
import { performInit } from "../../../src/cli/commands/init.js";
import { performUninstall } from "../../../src/cli/commands/uninstall.js";
import { forceRefreshProjectSkills, refreshRegisteredProjectSkillsIfNeeded } from "../../../src/core/version-check.js";

vi.mock("../../../src/cli/commands/init.js", () => ({ performInit: vi.fn() }));
vi.mock("../../../src/cli/commands/uninstall.js", () => ({ performUninstall: vi.fn() }));
vi.mock("../../../src/cli/commands/setup.js", () => ({ performSetup: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));
vi.mock("../../../src/core/version-check.js", () => ({
	forceRefreshProjectSkills: vi.fn(),
	refreshRegisteredProjectSkillsIfNeeded: vi.fn(),
}));

describe("doctor source contract", () => {
	it("doctor command is registered in entry.ts", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/entry.ts"),
			"utf8",
		);

		expect(source).toContain(
			'import { registerDoctorCommand } from "./commands/doctor.js";',
		);
		expect(source).toContain("registerDoctorCommand(program);");
	});

	it("doctor is in SKIP_MIGRATION_COMMANDS", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/entry.ts"),
			"utf8",
		);

		expect(source).toContain('"doctor"');
		expect(source).toContain("const SKIP_MIGRATION_COMMANDS = new Set([");
	});

	it("reinit is not in SKIP_MIGRATION_COMMANDS", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/entry.ts"),
			"utf8",
		);

		expect(source).not.toContain('"reinit"');
	});

	it("doctor command imports performInit, performUninstall, skills refresh helpers and registry functions", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/commands/doctor.ts"),
			"utf8",
		);

		expect(source).toContain('import { performInit } from "./init.js";');
		expect(source).toContain(
			'import { performUninstall } from "./uninstall.js";',
		);
		expect(source).toContain("forceRefreshProjectSkills");
		expect(source).toContain("refreshRegisteredProjectSkillsIfNeeded");
		expect(source).toContain("getRegisteredProjects");
		expect(source).toContain("cleanStaleEntries");
		expect(source).toContain("performSetup");
	});
});

describe("doctor command registration", () => {
	it("accepts optional [dir] argument and options", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/commands/doctor.ts"),
			"utf8",
		);

		expect(source).toContain('.argument("[dir]"');
		expect(source).toContain("--check-skills-only");
		expect(source).toContain("--skills-only");
		expect(source).toContain("-f, --force");
	});
});

describe("doctor spec template repair", () => {
	let root: string;
	let originalHome: string | undefined;
	let originalExitCode: number | undefined;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "idx-doctor-template-"));
		originalHome = process.env.INDEXER_CLI_HOME;
		originalExitCode = process.exitCode;
		process.env.INDEXER_CLI_HOME = path.join(root, "home");
		process.exitCode = undefined;
		vi.resetAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(refreshRegisteredProjectSkillsIfNeeded).mockResolvedValue({ checked: 0, refreshed: 0, failed: 0, stale: 0 });
		vi.mocked(performUninstall).mockImplementation(async (project) => {
			await rm(path.join(project, ".indexer-cli"), { recursive: true, force: true });
		});
		vi.mocked(performInit).mockImplementation(async (project) => {
			const dataDir = path.join(project, ".indexer-cli");
			await mkdir(dataDir, { recursive: true });
			await installSpecTemplate(dataDir);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.INDEXER_CLI_HOME;
		else process.env.INDEXER_CLI_HOME = originalHome;
		process.exitCode = originalExitCode;
		await rm(root, { recursive: true, force: true });
	});

	async function project(name: string, register = false): Promise<string> {
		const projectRoot = path.join(root, name);
		const dataDir = path.join(projectRoot, ".indexer-cli");
		await mkdir(dataDir, { recursive: true });
		await writeFile(path.join(dataDir, "config.json"), JSON.stringify({ skillsVersion: SKILLS_VERSION }));
		if (register) addProject({ projectPath: projectRoot, cliVersion: "2.0.7", skillsVersion: SKILLS_VERSION });
		return projectRoot;
	}

	async function doctor(...args: string[]): Promise<void> {
		const program = new Command();
		registerDoctorCommand(program);
		await program.parseAsync(["node", "idx", "doctor", ...args]);
	}

	function template(projectRoot: string): string {
		return path.join(projectRoot, ".indexer-cli", "spec-template.md");
	}

	it("repairs missing templates in valid registered projects with current skills during --check-skills-only", async () => {
		const missing = await project("missing", true);
		const custom = await project("custom", true);
		await writeFile(template(custom), "user template\n");
		const stale = path.join(root, "stale");
		addProject({ projectPath: stale, cliVersion: "2.0.7", skillsVersion: SKILLS_VERSION });

		await doctor("--check-skills-only");

		expect(await readFile(template(missing), "utf8")).toBe(SPEC_TEMPLATE);
		expect(await readFile(template(custom), "utf8")).toBe("user template\n");
		expect(performInit).not.toHaveBeenCalled();
		expect(forceRefreshProjectSkills).not.toHaveBeenCalled();
		expect(refreshRegisteredProjectSkillsIfNeeded).toHaveBeenCalledOnce();
	});

	it("repairs selected registered and workspace projects during --skills-only without overwriting edits", async () => {
		const registered = await project("registered", true);
		const workspace = path.join(root, "workspace");
		const missing = await project("workspace/missing");
		const custom = await project("workspace/custom");
		await writeFile(template(custom), "edited");

		await doctor("--skills-only", "--force");
		await doctor(workspace, "--skills-only", "--force");

		expect(await readFile(template(registered), "utf8")).toBe(SPEC_TEMPLATE);
		expect(await readFile(template(missing), "utf8")).toBe(SPEC_TEMPLATE);
		expect(await readFile(template(custom), "utf8")).toBe("edited");
		expect(forceRefreshProjectSkills).toHaveBeenCalledTimes(3);
		expect(performUninstall).not.toHaveBeenCalled();
	});

	it("restores the original template across full reinitialization, including failed init", async () => {
		const edited = await project("workspace/edited");
		const missing = await project("workspace/missing");
		const failed = await project("workspace/failed");
		await writeFile(template(edited), "user content\n");
		await writeFile(template(failed), "keep on failure\n");
		vi.mocked(performInit).mockImplementation(async (projectRoot) => {
			if (projectRoot === failed) throw new Error("init failed");
			const dataDir = path.join(projectRoot, ".indexer-cli");
			await mkdir(dataDir, { recursive: true });
			await installSpecTemplate(dataDir);
		});

		await doctor(path.join(root, "workspace"), "--force");

		expect(await readFile(template(edited), "utf8")).toBe("user content\n");
		expect(await readFile(template(missing), "utf8")).toBe(SPEC_TEMPLATE);
		expect(await readFile(template(failed), "utf8")).toBe("keep on failure\n");
		expect(performUninstall).toHaveBeenCalledTimes(3);
		expect(process.exitCode).toBe(1);
	});

	it("leaves an existing template untouched when full reinitialization is cancelled", async () => {
		const selected = await project("selected", true);
		await writeFile(template(selected), "keep me");
		vi.mocked(createInterface).mockReturnValue({
			question: vi.fn().mockResolvedValue("n"),
			close: vi.fn(),
		} as unknown as ReturnType<typeof createInterface>);

		await doctor();

		expect(await readFile(template(selected), "utf8")).toBe("keep me");
		expect(performUninstall).not.toHaveBeenCalled();
		expect(performInit).not.toHaveBeenCalled();
	});
});
