import { describe, expect, it, vi } from "vitest";
import { createResilientAskModel } from "../../../src/ask/resilient-model.js";
import type { AskConfig } from "../../../src/ask/config.js";
import type { AskModel, AskModelRequest } from "../../../src/ask/model.js";

const req: AskModelRequest = { instructions: "i", messages: [{ role: "user", text: "question" }], tools: [], maxOutputTokens: 10, timeoutMs: 5000 };
const ok = { text: "ok", toolCalls: [] };
const config: AskConfig = { backend: "openai", retries: 1, fallback: { backend: "pi", model: "safe-model", piProvider: "known" } };
const model = (turn: AskModel["turn"]): AskModel => ({ turn });

describe("createResilientAskModel", () => {
	it("retries transient inference only then switches and emits safe notices", async () => {
		const primary = vi.fn().mockRejectedValueOnce(new Error("network password=secret")).mockRejectedValue(new Error("unavailable"));
		const fallback = vi.fn().mockResolvedValue(ok); const notice = vi.fn();
		const wrapper = createResilientAskModel(config, ({ backend }) => model(backend === "pi" ? fallback : primary), notice);
		expect(await wrapper.turn(req)).toEqual(ok);
		expect(primary).toHaveBeenCalledTimes(2); expect(fallback).toHaveBeenCalledTimes(1);
		expect(notice.mock.calls.map(([n]) => n.type)).toEqual(["retry", "fallback"]);
		expect(JSON.stringify(notice.mock.calls)).not.toContain("secret");
	});
	it("does not retry deterministic failures or anything when retry/fallback disabled", async () => {
		const turn = vi.fn().mockRejectedValue(new Error("invalid response"));
		await expect(createResilientAskModel({ backend: "openai", retries: 4 }, () => model(turn)).turn(req)).rejects.toThrow("invalid response");
		expect(turn).toHaveBeenCalledTimes(1);
	});
	it("switches on builder/key failure, collapses native history and remains sticky", async () => {
		const fallback = vi.fn().mockResolvedValue(ok); const build = vi.fn(({ backend }) => { if (backend === "openai") throw new Error("missing key"); return model(fallback); });
		const wrapper = createResilientAskModel(config, build);
		const initial = { ...req, messages: [...req.messages, { role: "assistant" as const, turn: { text: "previous primary text", toolCalls: [], state: { signature: "primary-signature" } } }] };
		await wrapper.turn(initial);
		expect(JSON.stringify(fallback.mock.calls[0][0].messages)).not.toContain("primary-signature");
		const later = { ...req, messages: [...initial.messages, { role: "assistant" as const, turn: { text: "fallback text", toolCalls: [], state: { signature: "fallback-signature" } } }, { role: "user" as const, text: "second" }] };
		await wrapper.turn(later);
		expect(build).toHaveBeenCalledTimes(2);
		expect(fallback.mock.calls[1][0].messages[0]).toEqual({ role: "user", text: "question" });
		expect(JSON.stringify(fallback.mock.calls[1][0].messages)).toContain("fallback-signature");
		expect(fallback.mock.calls[1][0].messages.at(-1)).toEqual({ role: "user", text: "second" });
	});
});
