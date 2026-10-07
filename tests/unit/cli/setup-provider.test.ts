import { execSync } from "node:child_process";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { performSetup, registerSetupCommand } from "../../../src/cli/commands/setup.js";
import { ensureIdxBinary, installGlobal } from "../../../src/core/idx-binary.js";
import { loadOpenRouterApiKey } from "../../../src/embedding/factory.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));
vi.mock("../../../src/core/global-config.js", () => ({ reportGlobalConfig: vi.fn() }));
vi.mock("../../../src/core/idx-binary.js", () => ({ ensureIdxBinary: vi.fn(), installGlobal: vi.fn() }));
vi.mock("../../../src/embedding/factory.js", () => ({ loadOpenRouterApiKey: vi.fn() }));

describe("setup provider prerequisites", () => {
	let exitCode: typeof process.exitCode;
	beforeEach(() => {
		exitCode = process.exitCode;
		process.exitCode = undefined;
		vi.resetAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(loadOpenRouterApiKey).mockReturnValue("secret-test-key");
		vi.mocked(installGlobal).mockReturnValue(true);
		vi.mocked(ensureIdxBinary).mockReturnValue({ scriptStatus: "unchanged", pathUpdated: false, launchMode: "global-wrapper", targetPath: "/tmp/idx" });
		vi.mocked(execSync).mockImplementation((command) => {
			if (command === "node --version") return "v22.19.0";
			if (command === "ollama list") return "jina-8k nomic-embed-text-v2-moe";
			return "ok";
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = exitCode;
	});
	async function setup(...args: string[]): Promise<void> {
		const program = new Command();
		registerSetupCommand(program);
		await program.parseAsync(["node", "idx", "setup", ...args]);
	}
	it("defaults to OpenRouter without executing any Ollama command or exposing the key", async () => {
		await setup();
		expect(loadOpenRouterApiKey).toHaveBeenCalledOnce();
		expect(installGlobal).toHaveBeenCalledOnce();
		expect(vi.mocked(execSync).mock.calls.some(([command]) => String(command).includes("ollama"))).toBe(false);
		expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("secret-test-key");
		expect(process.exitCode).toBeUndefined();
	});
	it("fails before any system changes when the key is absent", async () => {
		vi.mocked(loadOpenRouterApiKey).mockReturnValue(undefined);
		await setup();
		expect(process.exitCode).toBe(1);
		expect(execSync).not.toHaveBeenCalled();
		expect(installGlobal).not.toHaveBeenCalled();
		expect(ensureIdxBinary).not.toHaveBeenCalled();
	});
	it("checks local Ollama and both models without needing a key", async () => {
		vi.mocked(loadOpenRouterApiKey).mockReturnValue(undefined);
		await setup("--embedding", "local");
		expect(loadOpenRouterApiKey).not.toHaveBeenCalled();
		expect(execSync).toHaveBeenCalledWith("ollama ps", expect.anything());
		expect(execSync).toHaveBeenCalledWith("ollama list", expect.anything());
		expect(process.exitCode).toBeUndefined();
	});
	it("fails local setup when Ollama is missing and clears results on the next invocation", () => {
		vi.mocked(execSync).mockImplementation((command) => {
			if (command === "command -v ollama") throw new Error("not installed");
			return command === "node --version" ? "v22.19.0" : "ok";
		});
		expect(performSetup({ embeddingModes: ["local"] })).toBe(false);
		expect(process.exitCode).toBe(1);
		process.exitCode = undefined;
		expect(performSetup()).toBe(true);
		expect(process.exitCode).toBeUndefined();
	});
	it("checks both providers for mixed projects", () => {
		expect(performSetup({ embeddingModes: ["local", "openrouter"] })).toBe(true);
		expect(loadOpenRouterApiKey).toHaveBeenCalledOnce();
		expect(execSync).toHaveBeenCalledWith("ollama ps", expect.anything());
	});
	it("rejects invalid modes before installing anything", async () => {
		await expect(setup("--embedding", "invalid")).rejects.toThrow("--embedding must be local or openrouter");
		expect(installGlobal).not.toHaveBeenCalled();
	});
});
