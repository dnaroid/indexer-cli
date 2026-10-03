import { Command } from "commander";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerKnowledgeCommand } from "../../../src/cli/commands/knowledge.js";
import { config } from "../../../src/core/config.js";
import { runCLI } from "../../helpers/cli-runner.js";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "knowledge-cli-"));
	await mkdir(path.join(root, ".indexer-cli"));
	await writeFile(path.join(root, ".indexer-cli/config.json"), "{}");
	await writeFile(path.join(root, "code.ts"), "const a = 1;");
	await writeFile(path.join(root, "spec.md"), "---\nkind: spec\nstatus: active\n---\n## Implementation\n`code.ts`\n");
	vi.spyOn(console, "log").mockImplementation(() => {});
	process.exitCode = 0;
});
afterEach(async () => { process.exitCode = 0; config.load(root); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
it("exposes only dirty and acknowledge, without external-project or JSON options", () => {
	const program = new Command();
	registerKnowledgeCommand(program);
	const knowledge = program.commands[0];
	expect(knowledge.commands.map(command => command.name())).toEqual(["dirty", "acknowledge"]);
	for (const command of knowledge.commands) expect(command.options).toEqual([]);
});

it("prints only yes/no for current-project dirtiness, including fail-closed errors", async () => {
	const check = (cwd = root) => runCLI(["knowledge", "dirty"], { cwd });
	const initial = check();
	expect(initial).toEqual({ exitCode: 0, stdout: "yes", stderr: "" });
	expect(await readdir(path.join(root, ".indexer-cli"))).toEqual(["config.json"]);
	const ack = runCLI(["knowledge", "acknowledge", "spec.md"], { cwd: root });
	expect(ack.exitCode, ack.stderr).toBe(0);
	expect(ack.stdout).toBe("Acknowledged: spec.md");
	expect((await readdir(path.join(root, ".indexer-cli"))).sort()).toEqual(["config.json", "knowledge-reviews"]);
	expect(check()).toEqual({ exitCode: 0, stdout: "no", stderr: "" });
	await mkdir(path.join(root, "nested"));
	expect(check(path.join(root, "nested"))).toEqual({ exitCode: 0, stdout: "no", stderr: "" });
	await writeFile(path.join(root, "code.ts"), "const a = 2;");
	expect(check()).toEqual({ exitCode: 0, stdout: "yes", stderr: "" });
	await rm(path.join(root, "code.ts"));
	const incomplete = check();
	expect(incomplete.exitCode).toBe(2);
	expect(incomplete.stdout).toBe("yes");
	expect(incomplete.stderr).toContain("incomplete");
	await rm(path.join(root, ".indexer-cli"), { recursive: true });
	const missingProject = check();
	expect(missingProject.exitCode).toBe(2);
	expect(missingProject.stdout).toBe("yes");
	expect(missingProject.stderr).toContain("Knowledge review failed");
});

it("does not acknowledge missing dependencies or unknown specs", () => {
	const result = runCLI(["knowledge", "acknowledge", "missing.md"], { cwd: root });
	expect(result.exitCode).toBe(2);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("Knowledge review failed");
	expect(runCLI(["knowledge", "dirty"], { cwd: root }).stdout).toBe("yes");
});
