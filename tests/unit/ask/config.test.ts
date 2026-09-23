import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAskConfig } from "../../../src/ask/config.js";

describe("loadAskConfig", () => {
	let dirs: string[] = [];
	afterEach(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); dirs = []; });
	function home(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idx-ask-config-")); dirs.push(dir); return dir; }
	function write(root: string, content: string): void {
		const file = path.join(root, "idx", ".env"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
	}

	it("loads only the global file independent of cwd and parses dotenv values without expansion", () => {
		const h = home(); write(path.join(h, ".config"), `OPENAI_API_KEY='quoted=value #x' # note\nIDX_ASK_MODEL="model=one"\nOPENAI_BASE_URL=https://example.test/a=b\nIDX_PI_MODEL=$OPENAI_API_KEY\nUNKNOWN=ignored\n`);
		const cwd = process.cwd();
		try {
			const project = home();
			fs.writeFileSync(path.join(project, ".env"), "OPENAI_API_KEY=project-secret\nIDX_ASK_BACKEND=pi\n");
			process.chdir(project);
			expect(loadAskConfig({}, h)).toEqual({ backend: "openai", apiKey: "quoted=value #x", model: "model=one", baseUrl: "https://example.test/a=b", piModel: "$OPENAI_API_KEY", retries: 2 });
		} finally { process.chdir(cwd); }
	});

	it("honors absolute XDG path and environment precedence including empty values", () => {
		const h = home(); const xdg = home(); write(xdg, "OPENAI_API_KEY=file\nIDX_ASK_BACKEND=pi\nIDX_PI_PROVIDER=p\n");
		expect(loadAskConfig({ XDG_CONFIG_HOME: xdg, OPENAI_API_KEY: "", IDX_ASK_BACKEND: "openai", PI_CODING_AGENT_DIR: "/agent" }, h)).toEqual({ backend: "openai", apiKey: "", piProvider: "p", piAgentDir: "/agent", retries: 2 });
	});

	it("uses defaults when global file is missing and ignores relative XDG paths", () => {
		expect(loadAskConfig({ XDG_CONFIG_HOME: "relative" }, home())).toEqual({ backend: "openai", retries: 2 });
	});

	it("parses bounded retry and explicit fallback settings with environment precedence", () => {
		const h = home(); write(path.join(h, ".config"), "IDX_ASK_FALLBACK_MODEL=from-file\nIDX_ASK_FALLBACK_API_KEY=file-key\n");
		expect(loadAskConfig({ XDG_CONFIG_HOME: path.join(h, ".config"), IDX_ASK_RETRIES: "0", IDX_ASK_FALLBACK_MODEL: "env-model", IDX_ASK_FALLBACK_API_KEY: "" }, h)).toEqual({ backend: "openai", retries: 0, fallback: { backend: "openai", model: "env-model", apiKey: "", baseUrl: undefined } });
		for (const value of ["-1", "6", "2.5", "no"]) expect(() => loadAskConfig({ IDX_ASK_RETRIES: value }, h)).toThrow("Invalid IDX_ASK_RETRIES");
	});

	it("requires complete fallback selection and effective Pi provider", () => {
		const h = home();
		expect(() => loadAskConfig({ IDX_ASK_FALLBACK_BACKEND: "pi" }, h)).toThrow("IDX_ASK_FALLBACK_MODEL is required");
		expect(() => loadAskConfig({ IDX_ASK_FALLBACK_MODEL: "m", IDX_ASK_FALLBACK_BACKEND: "pi" }, h)).toThrow("IDX_ASK_FALLBACK_PROVIDER is required");
		expect(loadAskConfig({ IDX_ASK_BACKEND: "pi", IDX_PI_PROVIDER: "p", IDX_ASK_FALLBACK_BACKEND: "pi", IDX_ASK_FALLBACK_MODEL: "m" }, h)).toMatchObject({ fallback: { backend: "pi", model: "m", piProvider: "p" } });
	});

	it("keeps primary and fallback token limits independent with environment precedence", () => {
		const h = home();
		write(path.join(h, ".config"), "IDX_ASK_CONTEXT_TOKENS=120000\nIDX_ASK_MAX_OUTPUT_TOKENS=8000\nIDX_ASK_FALLBACK_MODEL=small\nIDX_ASK_FALLBACK_CONTEXT_TOKENS=16000\n");
		const config = loadAskConfig({ IDX_ASK_CONTEXT_TOKENS: "64000", IDX_ASK_FALLBACK_MAX_OUTPUT_TOKENS: "1000" }, h);
		expect(config).toMatchObject({ contextTokens: 64000, maxOutputTokens: 8000, fallback: { contextTokens: 16000, maxOutputTokens: 1000 } });
		const independent = loadAskConfig({ IDX_ASK_CONTEXT_TOKENS: "64000", IDX_ASK_MAX_OUTPUT_TOKENS: "8000", IDX_ASK_FALLBACK_MODEL: "other" }, home());
		expect(independent.fallback?.contextTokens).toBeUndefined();
		expect(independent.fallback?.maxOutputTokens).toBeUndefined();
	});

	it("rejects empty and invalid model limits without exposing their values", () => {
		for (const [key, values] of [
			["IDX_ASK_CONTEXT_TOKENS", ["", "2047", "2000001", "secret", "4096.5"]],
			["IDX_ASK_MAX_OUTPUT_TOKENS", ["", "0", "200001", "NaN"]],
		] as const) {
			for (const value of values) expect(() => loadAskConfig({ [key]: value }, home())).toThrow(`Invalid ${key}`);
		}
		expect(() => loadAskConfig({ IDX_ASK_FALLBACK_CONTEXT_TOKENS: "16000" }, home())).toThrow("IDX_ASK_FALLBACK_MODEL is required");
		expect(() => loadAskConfig({ IDX_ASK_BACKEND: "pi", IDX_PI_PROVIDER: "p", IDX_ASK_FALLBACK_MODEL: "m", IDX_ASK_FALLBACK_PROVIDER: "" }, home())).toThrow("IDX_ASK_FALLBACK_PROVIDER is required");
	});

	it("rejects invalid backend without exposing input", () => {
		const h = home(); write(path.join(h, ".config"), "IDX_ASK_BACKEND=secret-invalid\n");
		expect(() => loadAskConfig({}, h)).toThrow("Invalid IDX_ASK_BACKEND (expected openai or pi)");
	});

	it("rejects oversized and non-regular config files safely", () => {
		const h = home(); const root = path.join(h, ".config"); write(root, `#${"x".repeat(65536)}\n`);
		expect(() => loadAskConfig({}, h)).toThrow("Ask configuration file too large");
		fs.rmSync(path.join(root, "idx", ".env")); fs.mkdirSync(path.join(root, "idx", ".env"));
		expect(() => loadAskConfig({}, h)).toThrow("Invalid ask configuration file");
	});

	it("sanitizes unreadable file errors", () => {
		const h = home(); write(path.join(h, ".config"), "OPENAI_API_KEY=secret\n");
		const read = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw Object.assign(new Error("secret path"), { code: "EACCES" }); });
		try { expect(() => loadAskConfig({}, h)).toThrow("Unable to read ask configuration file"); }
		finally { read.mockRestore(); }
	});
});
