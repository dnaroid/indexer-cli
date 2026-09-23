import { describe, expect, it, vi } from "vitest";
import { completePiRequest, type PiRuntimeModule } from "../../../src/ask/pi-runtime.js";

const request = { provider: "p", model: "m", request: { instructions: "rules", messages: [{ role: "user" as const, text: "hi" }], tools: [{ name: "search", description: "find", parameters: { type: "object" } }], maxOutputTokens: 12, timeoutMs: 1000 } };
function setup(response: unknown) { const model = {}; const completeSimple = vi.fn().mockResolvedValue(response); const getModel = vi.fn().mockReturnValue(model); const create = vi.fn().mockResolvedValue({ getModel, completeSimple }); return { sdk: { ModelRuntime: { create } } as unknown as PiRuntimeModule, create, getModel, completeSimple, model }; }
describe("completePiRequest native turns", () => {
	it("passes tools and full transcript; returns toolUse calls with retained assistant state", async () => {
		const response = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "id1", name: "search", arguments: { q: "a" } }] };
		const f = setup(response); const turn = await completePiRequest(request, f.sdk);
		expect(turn.toolCalls).toEqual([{ id: "id1", name: "search", arguments: { q: "a" } }]); expect(turn.state).toBe(response);
		const prior = { role: "assistant", turn }; const next = { ...request, request: { ...request.request, messages: [...request.request.messages, prior, { role: "tool" as const, id: "id1", name: "search", text: "result", isError: false }] } };
		await completePiRequest(next, f.sdk);
		const [model, context, options] = f.completeSimple.mock.calls[1];
		expect(model).toBe(f.model); expect(context.tools).toEqual([{ name: "search", description: "find", parameters: { type: "object" } }]); expect(context.messages).toEqual([expect.objectContaining({ role: "user", content: "hi" }), response, expect.objectContaining({ role: "toolResult", toolCallId: "id1" })]); expect(options).toMatchObject({ maxRetries: 0, maxTokens: 12 });
	});
	it("uses catalog limits and never lets configured limits raise them", async () => {
		const f = setup({ stopReason: "stop", content: [{ type: "text", text: "answer" }] });
		Object.assign(f.model, { contextWindow: 4096, maxTokens: 8 });
		await completePiRequest({ ...request, limits: { contextTokens: 100_000, maxOutputTokens: 100 } }, f.sdk);
		expect(f.completeSimple.mock.calls[0][2]).toMatchObject({ maxTokens: 8 });
		const context = f.completeSimple.mock.calls[0][1];
		expect(context.messages).toHaveLength(1);
	});
	it("honors smaller configured caps and uses safe defaults for unknown catalog limits", async () => {
		const f = setup({ stopReason: "stop", content: [{ type: "text", text: "answer" }] });
		Object.assign(f.model, { contextWindow: 8192, maxTokens: 100 });
		await completePiRequest({ ...request, limits: { contextTokens: 4096, maxOutputTokens: 6 } }, f.sdk);
		expect(f.completeSimple.mock.calls[0][2]).toMatchObject({ maxTokens: 6 });
		const unknown = setup({ stopReason: "stop", content: [{ type: "text", text: "answer" }] });
		await completePiRequest(request, unknown.sdk);
		expect(unknown.completeSimple.mock.calls[0][2]).toMatchObject({ maxTokens: 12 });
	});
	it("marks transient completion failures retryable without leaking provider details", async () => {
		const f = setup({ stopReason: "stop", errorMessage: "429 rate limit secret" });
		await expect(completePiRequest(request, f.sdk)).rejects.toMatchObject({ message: "Pi request failed", retryable: true });
	});
	it("accepts stop text; rejects refusal/error/malformed and tool calls without toolUse stop", async () => {
		await expect(completePiRequest(request, setup({ stopReason: "stop", content: [{ type: "text", text: "answer" }] }).sdk)).resolves.toMatchObject({ text: "answer", toolCalls: [] });
		for (const result of [{ stopReason: "length", content: [] }, { stopReason: "stop", content: [{ type: "toolCall", id: "x", name: "n" }] }, { stopReason: "stop", content: [{ type: "text", text: "" }] }]) await expect(completePiRequest(request, setup(result).sdk)).rejects.toThrow("Invalid Pi completion");
		await expect(completePiRequest(request, setup({ stopReason: "stop", errorMessage: "secret" }).sdk)).rejects.toMatchObject({ message: "Pi request failed", retryable: false });
	});
});
