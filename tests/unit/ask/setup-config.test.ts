import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAskConfig } from "../../../src/ask/setup-config.js";

const roots: string[] = [];
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "idx-ask-")); roots.push(root); return root; }
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ensureAskConfig", () => {
	it("creates a commented private template idempotently", () => {
		const home = temp();
		const file = ensureAskConfig({}, home);
		const contents = fs.readFileSync(file, "utf8");
		expect(contents).toContain("# OPENAI_API_KEY=");
		expect(contents.split("\n").filter(line => /^(OPENAI|IDX_|PI_)/.test(line))).toEqual([]);
		expect(parseEnv(contents)).toEqual({});
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
		fs.writeFileSync(file, "secret=untouched\n");
		fs.chmodSync(file, 0o640);
		expect(ensureAskConfig({}, home)).toBe(file);
		expect(fs.readFileSync(file, "utf8")).toBe("secret=untouched\n");
		expect(fs.statSync(file).mode & 0o777).toBe(0o640);
	});
	it("uses absolute XDG_CONFIG_HOME and does not follow an existing symlink", () => {
		const xdg = temp();
		const file = ensureAskConfig({ XDG_CONFIG_HOME: xdg }, temp());
		expect(file).toBe(path.join(xdg, "idx", ".env"));
		const victim = path.join(xdg, "victim");
		fs.writeFileSync(victim, "preserve\n");
		fs.rmSync(file);
		fs.symlinkSync(victim, file);
		expect(() => ensureAskConfig({ XDG_CONFIG_HOME: xdg }, temp())).toThrow();
		expect(fs.readFileSync(victim, "utf8")).toBe("preserve\n");
	});
	it("ignores relative XDG_CONFIG_HOME", () => {
		const home = temp();
		expect(ensureAskConfig({ XDG_CONFIG_HOME: "relative" }, home))
			.toBe(path.join(home, ".config", "idx", ".env"));
	});
	it("does not publish partial configuration after a write failure", () => {
		const home = temp();
		const write = fs.writeFileSync.bind(fs);
		const failure = vi.spyOn(fs, "writeFileSync").mockImplementationOnce((file) => {
			write(file, "partial");
			throw new Error("simulated write failure");
		});
		expect(() => ensureAskConfig({}, home)).toThrow("Unable to create optional idx ask configuration");
		failure.mockRestore();
		const directory = path.join(home, ".config", "idx");
		expect(fs.readdirSync(directory)).toEqual([]);
		const file = ensureAskConfig({}, home);
		expect(fs.readFileSync(file, "utf8")).toContain("# OPENAI_API_KEY=");
	});
	it("preserves a configuration created concurrently before publication", () => {
		const home = temp();
		const link = fs.linkSync.bind(fs);
		vi.spyOn(fs, "linkSync").mockImplementationOnce((source, destination) => {
			fs.writeFileSync(destination, "concurrent-user-config");
			link(source, destination);
		});
		const file = ensureAskConfig({}, home);
		expect(fs.readFileSync(file, "utf8")).toBe("concurrent-user-config");
		expect(fs.readdirSync(path.dirname(file))).toEqual([".env"]);
	});
	it.each(["directory", "dangling-symlink", "directory-symlink"])("preserves and refuses a %s target", (kind) => {
		const xdg = temp();
		const directory = path.join(xdg, "idx");
		fs.mkdirSync(directory);
		const target = path.join(directory, ".env");
		if (kind === "directory") fs.mkdirSync(target);
		else fs.symlinkSync(kind === "dangling-symlink" ? path.join(xdg, "missing") : xdg, target);
		expect(() => ensureAskConfig({ XDG_CONFIG_HOME: xdg }, temp())).toThrow("Unable to create optional idx ask configuration");
		expect(fs.lstatSync(target).isSymbolicLink()).toBe(kind !== "directory");
	});
	it("does not follow an idx directory symlink", () => {
		const xdg = temp();
		const destination = temp();
		fs.symlinkSync(destination, path.join(xdg, "idx"));
		expect(() => ensureAskConfig({ XDG_CONFIG_HOME: xdg }, temp())).toThrow();
		expect(fs.readdirSync(destination)).toEqual([]);
	});
	it("postinstall reports its path and preserves an existing file on repeat runs", () => {
		const xdg = temp();
		const script = path.resolve(__dirname, "../../../scripts/create-ask-config.cjs");
		const run = () => execFileSync(process.execPath, [script], {
			env: { ...process.env, XDG_CONFIG_HOME: xdg }, encoding: "utf8",
		});
		const target = path.join(xdg, "idx", ".env");
		expect(run()).toContain(target);
		expect(parseEnv(fs.readFileSync(target, "utf8"))).toEqual({});
		fs.writeFileSync(target, "do-not-read-or-print-this-secret");
		const output = run();
		expect(output).toContain(target);
		expect(output).not.toContain("do-not-read-or-print-this-secret");
		expect(fs.readFileSync(target, "utf8")).toBe("do-not-read-or-print-this-secret");
	});
	it("postinstall warns without failing for unsafe targets", () => {
		const xdg = temp();
		fs.writeFileSync(path.join(xdg, "idx"), "sensitive-error-content");
		const script = path.resolve(__dirname, "../../../scripts/create-ask-config.cjs");
		const result = spawnSync(process.execPath, [script], {
			env: { ...process.env, XDG_CONFIG_HOME: xdg }, encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toContain("Warning:");
		expect(result.stderr).toContain(path.join(xdg, "idx", ".env"));
		expect(result.stderr).not.toContain("sensitive-error-content");
	});
});
