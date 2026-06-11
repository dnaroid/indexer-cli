import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const CLI_ROOT = path.resolve(__dirname, "..", "..", "..");

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function run(command: string, args: string[], cwd = CLI_ROOT): string {
	return execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function installIntoPrefix(prefixDir: string): void {
	mkdirSync(path.join(prefixDir, "bin"), { recursive: true });
	mkdirSync(path.join(prefixDir, "lib"), { recursive: true });
	run("npm", ["install", "-g", ".", "--prefix", prefixDir], CLI_ROOT);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("published package install metadata", () => {
	it("exposes both idx and indexer-cli bins", () => {
		const pkg = JSON.parse(readFileSync(path.join(CLI_ROOT, "package.json"), "utf8")) as {
			bin?: Record<string, string>;
		};

		expect(pkg.bin).toEqual({
			idx: "./bin/indexer-cli.js",
			"indexer-cli": "./bin/indexer-cli.js",
		});
	});

	it("creates both launchers in a temporary npm global prefix and runs idx --version", () => {
		const distEntry = path.join(CLI_ROOT, "dist", "cli", "entry.js");
		expect(existsSync(distEntry)).toBe(true);
		const pkg = JSON.parse(readFileSync(path.join(CLI_ROOT, "package.json"), "utf8")) as {
			version: string;
		};

		const prefixDir = createTempDir("indexer-cli-npm-prefix-");
		installIntoPrefix(prefixDir);

		const idxPath = path.join(prefixDir, "bin", "idx");
		const legacyPath = path.join(prefixDir, "bin", "indexer-cli");

		expect(existsSync(idxPath)).toBe(true);
		expect(existsSync(legacyPath)).toBe(true);

		const idxVersion = run(idxPath, ["--version"]);
		const legacyVersion = run(legacyPath, ["--version"]);

		expect(idxVersion).toContain(pkg.version);
		expect(legacyVersion).toContain(pkg.version);
	});

	it("does not let idx update exit silently when auto-update is blocked", () => {
		const distEntry = path.join(CLI_ROOT, "dist", "cli", "entry.js");
		expect(existsSync(distEntry)).toBe(true);

		const prefixDir = createTempDir("indexer-cli-npm-prefix-");
		installIntoPrefix(prefixDir);

		const idxPath = path.join(prefixDir, "bin", "idx");
		let stderr = "";

		try {
			execFileSync(idxPath, ["update"], {
				cwd: CLI_ROOT,
				encoding: "utf8",
				env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			stderr = Buffer.isBuffer((error as { stderr?: unknown }).stderr)
				? ((error as { stderr: Buffer }).stderr.toString("utf8"))
				: String((error as { stderr?: unknown }).stderr ?? "");
		}

		expect(stderr).toContain("Update skipped:");
		expect(stderr.trim().length).toBeGreaterThan("Update skipped:".length);
	});
});
