import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createTempProject,
	gitInit,
	removeTempProject,
	runCLI,
} from "../helpers/cli-runner";

let tempDir = "";

describe.sequential("deps call graph TypeScript receivers", () => {
	beforeAll(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "indexer-cli-call-graph-"));
		removeTempProject(tempDir);
		createTempProject(tempDir);
		writeFileSync(
			path.join(tempDir, "src", "imported.ts"),
			"export function imported() {}\nexport class ImportedLogger { info() {} }\n",
		);
		writeFileSync(
			path.join(tempDir, "src", "calls.ts"),
			`import { imported, ImportedLogger } from "./imported";

export class First {
	static make() {}
	normalizePath() {}
	detachedOnly() {}
	caller(logger: ImportedLogger) {
		this.normalizePath();
		imported();
		First.make();
		logger.info();
	}
	nested() {
		const lexical = () => this.normalizePath();
		function detached() { this.detachedOnly(); }
		lexical();
		detached();
	}
	objectLiteral() {
		const helper = { invoke() { this.normalizePath(); }, normalizePath() {} };
		helper.invoke();
	}
}

class Second {
	static make() {}
	normalizePath() {}
}

class Right { run() {} }
class Wrong { run() {} }
class service { static run() {} }
class helper { static invoke() {} }
function unrelated() { const service = new Wrong(); }
function lexical(service: Right) { service.run(); }
function local() { const service = new Right(); service.run(); }
function reassigned() {
	let service = new Wrong();
	service = new Right();
	service.run();
}
function objectReceiver() {
	const helper = { invoke() {} };
	helper.invoke();
}
`,
		);
		gitInit(tempDir);
		const init = runCLI(["init"], { cwd: tempDir });
		if (init.exitCode !== 0) throw new Error(init.stderr);
	}, 30_000);

	afterAll(() => removeTempProject(tempDir));

	it("resolves this calls only to the enclosing class and preserves imports/static calls", () => {
		const result = runCLI(
			[
				"deps",
				"src/calls.ts::First.caller",
				"--mode",
				"calls",
				"--direction",
				"callees",
				"--show-edges",
			],
			{ cwd: tempDir },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("src/calls.ts::First.normalizePath");
		expect(result.stdout).toContain("src/calls.ts::First.make");
		expect(result.stdout).toContain("src/imported.ts::imported");
		expect(result.stdout).toContain("src/imported.ts::ImportedLogger.info");
		expect(result.stdout).not.toContain("src/calls.ts::Second.normalizePath");
		expect(result.stdout).not.toContain("src/calls.ts::Second.make");
	});

	it("keeps lexical-arrow this but excludes nested regular-function this", () => {
		const result = runCLI(
			[
				"deps",
				"src/calls.ts::First.nested",
				"--mode",
				"calls",
				"--direction",
				"callees",
			],
			{ cwd: tempDir },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("src/calls.ts::First.normalizePath");
		expect(result.stdout).not.toContain("src/calls.ts::Second.normalizePath");
		expect(result.stdout).not.toContain("src/calls.ts::First.detachedOnly");
	});

	it("uses lexical receiver bindings and omits reassigned receivers", () => {
		const lexical = runCLI(
			["deps", "src/calls.ts::lexical", "--mode", "calls", "--direction", "callees"],
			{ cwd: tempDir },
		);
		const local = runCLI(
			["deps", "src/calls.ts::local", "--mode", "calls", "--direction", "callees"],
			{ cwd: tempDir },
		);
		const reassigned = runCLI(
			["deps", "src/calls.ts::reassigned", "--mode", "calls", "--direction", "callees"],
			{ cwd: tempDir },
		);

		expect(lexical.exitCode).toBe(0);
		expect(lexical.stdout).toContain("src/calls.ts::Right.run");
		expect(lexical.stdout).not.toContain("src/calls.ts::Wrong.run");
		expect(local.exitCode).toBe(0);
		expect(local.stdout).toContain("src/calls.ts::Right.run");
		expect(reassigned.exitCode).toBe(0);
		expect(reassigned.stdout).not.toContain("src/calls.ts::Right.run");
		expect(reassigned.stdout).not.toContain("src/calls.ts::Wrong.run");
		expect(reassigned.stdout).not.toContain("src/calls.ts::service.run");
	});

	it("does not reinterpret unresolved object bindings as same-named classes", () => {
		const result = runCLI(
			["deps", "src/calls.ts::objectReceiver", "--mode", "calls", "--direction", "callees"],
			{ cwd: tempDir },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("src/calls.ts::helper.invoke");
	});

	it("does not attribute object-literal method this to its enclosing class", () => {
		const result = runCLI(
			["deps", "src/calls.ts::First.objectLiteral", "--mode", "calls", "--direction", "callees"],
			{ cwd: tempDir },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).not.toContain("src/calls.ts::First.normalizePath");
	});
});
