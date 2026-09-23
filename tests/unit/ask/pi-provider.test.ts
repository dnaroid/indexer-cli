import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import { createPiAskModel } from "../../../src/ask/pi-provider.js";

function child() {
	const proc = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
	proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = vi.fn();
	return proc;
}
const request = { instructions: "instructions", messages: [{ role: "user" as const, text: "hello" }], tools: [], maxOutputTokens: 10, timeoutMs: 1000 };
const call = (model: ReturnType<typeof createPiAskModel>) => model.turn(request);
const close = (proc: ReturnType<typeof child>, code = 0) => proc.emit("close", code);

afterEach(() => { vi.useRealTimers(); spawn.mockReset(); });

describe("createPiAskModel", () => {
	it("requires explicit provider/model and never falls back to IDX_ASK_MODEL", async () => {
		const prior = { provider: process.env.IDX_PI_PROVIDER, model: process.env.IDX_PI_MODEL, ask: process.env.IDX_ASK_MODEL };
		try {
			delete process.env.IDX_PI_PROVIDER; delete process.env.IDX_PI_MODEL; process.env.IDX_ASK_MODEL = "secret-fallback";
			expect(() => createPiAskModel()).toThrow("Configure IDX_PI_PROVIDER and IDX_PI_MODEL");
			expect(() => createPiAskModel({ provider: "p" })).toThrow("Configure IDX_PI_PROVIDER and IDX_PI_MODEL");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			for (const [key, value] of Object.entries({ IDX_PI_PROVIDER: prior.provider, IDX_PI_MODEL: prior.model, IDX_ASK_MODEL: prior.ask })) value === undefined ? delete process.env[key] : process.env[key] = value;
		}
	});

	it("spawns the worker safely, sends request on stdin, and parses the response envelope", async () => {
		const proc = child(); spawn.mockReturnValue(proc);
		const promise = call(createPiAskModel({ provider: "custom-provider", model: "model-1", agentDir: "/custom/pi-home" }));
		expect(spawn).toHaveBeenCalledOnce();
		const [executable, args, options] = spawn.mock.calls[0];
		expect(executable).toBe(process.execPath); expect(args.at(-1)).toMatch(/pi-worker\.(?:js|ts)$/);
		expect(options).toMatchObject({ shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PI_CODING_AGENT_DIR: "/custom/pi-home" } });
		const request = JSON.parse(proc.stdin.read()?.toString() ?? "{}");
		expect(request).toMatchObject({ provider: "custom-provider", model: "model-1", request: { instructions: "instructions", tools: [] } });
		proc.stdout.end(JSON.stringify({ value: { text: "answer", toolCalls: [] } })); close(proc);
		expect(await promise).toEqual({ text: "answer", toolCalls: [], notices: [] });
	});

	it("kills a timed out worker", async () => {
		vi.useFakeTimers(); const proc = child(); spawn.mockReturnValue(proc);
		const promise = createPiAskModel({ provider: "p", model: "m", timeoutMs: 25 }).turn({ ...request, timeoutMs: 25 });
		const rejected = expect(promise).rejects.toThrow("Pi request timed out");
		await vi.advanceTimersByTimeAsync(25); await rejected;
		expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
	});

	it("caps output and stderr and sanitizes process, exit, stdin, and malformed-envelope failures", async () => {
		for (const mode of ["output", "stderr", "error", "exit", "stdin", "json", "envelope"] as const) {
			const proc = child(); spawn.mockReturnValue(proc);
			const promise = call(createPiAskModel({ provider: "p", model: "m", timeoutMs: 1000 }));
			const rejected = expect(promise).rejects.toThrow(mode === "output" ? "Pi response too large" : mode === "json" || mode === "envelope" ? "Invalid JSON from Pi" : "Pi request failed");
			if (mode === "output") proc.stdout.write(Buffer.alloc(100_001));
			else if (mode === "stderr") proc.stderr.write(Buffer.alloc(100_001));
			else if (mode === "error") proc.emit("error", new Error("credential SECRET"));
			else if (mode === "exit") close(proc, 2);
			else if (mode === "stdin") proc.stdin.emit("error", new Error("secret"));
			else { proc.stdout.end(mode === "json" ? "not-json" : "{}"); close(proc); }
			await rejected;
			if (mode === "error" || mode === "stdin" || mode === "output" || mode === "stderr") expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
		}
	});

	it("rejects oversized requests before starting a process", async () => {
		const model = createPiAskModel({ provider: "p", model: "m" });
		await expect(model.turn({ ...request, instructions: "x".repeat(256_001) })).rejects.toThrow("Ask request exceeds model context limit");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("sanitizes synchronous spawn errors", async () => {
		spawn.mockImplementation(() => { throw new Error("SECRET invalid environment"); });
		await expect(call(createPiAskModel({ provider: "p", model: "m" }))).rejects.toThrow(/^Pi request failed$/);
	});
});
