import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

	it("doctor command imports performInit, performUninstall, refreshClaudeSkills and registry functions", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/commands/doctor.ts"),
			"utf8",
		);

		expect(source).toContain(
			'import { performInit, refreshClaudeSkills } from "./init.js";',
		);
		expect(source).toContain(
			'import { performUninstall } from "./uninstall.js";',
		);
		expect(source).toContain("addProject");
		expect(source).toContain("getRegisteredProjects");
		expect(source).toContain("cleanStaleEntries");
	});
});

describe("doctor command registration", () => {
	it("accepts optional [dir] argument and options", () => {
		const source = readFileSync(
			path.resolve(import.meta.dirname, "../../../src/cli/commands/doctor.ts"),
			"utf8",
		);

		expect(source).toContain('.argument("[dir]"');
		expect(source).toContain("--skills-only");
		expect(source).toContain("-f, --force");
	});
});
