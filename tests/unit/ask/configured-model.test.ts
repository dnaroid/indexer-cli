import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAskConfig } from "../../../src/ask/config.js";
import { createConfiguredAskModel } from "../../../src/ask/configured-model.js";
import { createPiAskModel } from "../../../src/ask/pi-provider.js";
import { createAskModel } from "../../../src/ask/provider.js";

vi.mock("../../../src/ask/config.js", () => ({ loadAskConfig: vi.fn() }));
vi.mock("../../../src/ask/pi-provider.js", () => ({ createPiAskModel: vi.fn() }));
vi.mock("../../../src/ask/provider.js", () => ({ createAskModel: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

describe("configured ask model", () => {
	it("does not load config until inference, and reuses its backend", async () => {
		const turn = vi.fn().mockResolvedValue({ text: "ok", toolCalls: [] });
		vi.mocked(loadAskConfig).mockReturnValue({ backend: "openai", apiKey: "key", model: "model", baseUrl: "https://api.example/v1", retries: 2 });
		vi.mocked(createAskModel).mockReturnValue({ turn });
		const model = createConfiguredAskModel();
		expect(loadAskConfig).not.toHaveBeenCalled();
		const request = { instructions: "instructions", messages: [], tools: [], maxOutputTokens: 1, timeoutMs: 100 };
		await expect(model.turn(request)).resolves.toMatchObject({ text: "ok", toolCalls: [] });
		await model.turn(request);
		expect(loadAskConfig).toHaveBeenCalledTimes(1);
		expect(createAskModel).toHaveBeenCalledWith({ apiKey: "key", model: "model", baseUrl: "https://api.example/v1" });
		expect(createPiAskModel).not.toHaveBeenCalled();
	});

	it("routes Pi settings without passing OpenAI credentials or model", async () => {
		vi.mocked(loadAskConfig).mockReturnValue({ backend: "pi", apiKey: "unused-secret", model: "api-model", piProvider: "provider", piModel: "pi-model", piAgentDir: "/private/pi", retries: 2 });
		vi.mocked(createPiAskModel).mockReturnValue({ turn: vi.fn().mockResolvedValue({ text: "", toolCalls: [] }) });
		await createConfiguredAskModel().turn({ instructions: "instructions", messages: [], tools: [], maxOutputTokens: 1, timeoutMs: 100 });
		expect(createPiAskModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "provider", model: "pi-model", agentDir: "/private/pi", limits: expect.objectContaining({ contextTokens: undefined, maxOutputTokens: undefined }) }));
		expect(createAskModel).not.toHaveBeenCalled();
	});

	it("does not silently switch to direct API when Pi fails", async () => {
		vi.mocked(loadAskConfig).mockReturnValue({ backend: "pi", retries: 2 });
		vi.mocked(createPiAskModel).mockReturnValue({ turn: vi.fn().mockRejectedValue(new Error("Pi unavailable")) });
		await expect(createConfiguredAskModel().turn({ instructions: "instructions", messages: [], tools: [], maxOutputTokens: 1, timeoutMs: 100 })).rejects.toThrow("Pi unavailable");
		expect(createAskModel).not.toHaveBeenCalled();
	});

	it("adapts legacy json calls through a native tool turn", async () => {
		const turn = vi.fn().mockResolvedValue({ text: "", toolCalls: [{ id: "call", name: "classify", arguments: { kind: "doc" } }] });
		vi.mocked(loadAskConfig).mockReturnValue({ backend: "openai", model: "m", retries: 2 });
		vi.mocked(createAskModel).mockReturnValue({ turn });
		await expect(createConfiguredAskModel().json("classify this", { text: "hello" }, "classify", { type: "object" })).resolves.toEqual({ kind: "doc" });
		expect(turn).toHaveBeenCalledWith(expect.objectContaining({ tools: [expect.objectContaining({ name: "classify" })], messages: [{ role: "user", text: '{"text":"hello"}' }] }));
	});

	it("passes distinct primary and fallback limits to their respective backends", async () => {
		const primary = { backend: "openai" as const, model: "large", contextTokens: 100_000, maxOutputTokens: 8_000 };
		const fallback = { backend: "pi" as const, model: "small", piProvider: "p", contextTokens: 16_000, maxOutputTokens: 1_000 };
		vi.mocked(loadAskConfig).mockReturnValue({ ...primary, retries: 0, fallback });
		vi.mocked(createAskModel).mockReturnValue({ turn: vi.fn().mockRejectedValue(new Error("invalid request")) });
		vi.mocked(createPiAskModel).mockReturnValue({ turn: vi.fn().mockResolvedValue({ text: "ok", toolCalls: [] }) });
		await createConfiguredAskModel().turn({ instructions: "i", messages: [], tools: [], maxOutputTokens: 1, timeoutMs: 100 });
		expect(createAskModel).toHaveBeenCalledWith(expect.objectContaining({ model: "large" }));
		expect(createPiAskModel).toHaveBeenCalledWith(expect.objectContaining({ model: "small", limits: expect.objectContaining({ contextTokens: 16_000, maxOutputTokens: 1_000 }) }));
	});
});
