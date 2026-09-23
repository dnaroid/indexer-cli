import { describe, expect, it, vi } from "vitest";
import { createAskModel } from "../../../src/ask/provider.js";

const req = { instructions: "rules", messages: [{ role: "user" as const, text: "hi" }], tools: [{ name: "search", description: "find", parameters: { type: "object", additionalProperties: false } }], maxOutputTokens: 40, timeoutMs: 1000 };
const reply = (output: unknown[], status = "completed") => new Response(JSON.stringify({ status, output }));
describe("Responses native turns", () => {
	it("sends strict native tools, preserves assistant native state and outputs", async () => {
		const fetch = vi.fn().mockResolvedValueOnce(reply([{ type: "reasoning", id: "r", encrypted_content: "sealed" }, { type: "function_call", call_id: "c", name: "search", arguments: '{"q":"x"}' }])).mockResolvedValueOnce(reply([{ type: "message", status: "completed", content: [{ type: "output_text", text: "done" }] }]));
		const model = createAskModel({ apiKey: "secret", fetch });
		const turn = await model.turn(req);
		expect(turn.toolCalls).toEqual([{ id: "c", name: "search", arguments: { q: "x" } }]);
		await model.turn({ ...req, messages: [...req.messages, { role: "assistant", turn }, { role: "tool", id: "c", name: "search", text: "found", isError: false }] });
		const body = JSON.parse(fetch.mock.calls[1][1].body);
		expect(body).toMatchObject({ store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "none" }, tools: [{ type: "function", strict: true, name: "search" }] });
		expect(body.input).toEqual([{ role: "user", content: "hi" }, { type: "reasoning", id: "r", encrypted_content: "sealed" }, { type: "function_call", call_id: "c", name: "search", arguments: '{"q":"x"}' }, { type: "function_call_output", call_id: "c", output: "found" }]);
	});
	it("accepts text and calls; rejects refusals, incomplete and malformed output safely", async () => {
		const outputs = [reply([{ type: "message", status: "completed", content: [{ type: "output_text", text: "ok" }] }]), reply([{ type: "message", status: "completed", content: [{ type: "refusal" }] }]), reply([], "incomplete"), reply([{ type: "function_call", call_id: "c", name: "x", arguments: "{" }])];
		const model = createAskModel({ apiKey: "secret", fetch: vi.fn().mockImplementation(() => Promise.resolve(outputs.shift()!)) });
		expect((await model.turn(req)).text).toBe("ok");
		await expect(model.turn(req)).rejects.toThrow("refused"); await expect(model.turn(req)).rejects.toThrow("incomplete"); await expect(model.turn(req)).rejects.toThrow("Invalid OpenAI response");
	});
	it("rejects malformed blocks and distinguishes retryable HTTP failures", async () => {
		for (const output of [[{ type: "message", status: "in_progress", content: [] }], [{ type: "future" }], [{ type: "message", status: "completed", content: [{ type: "output_text", text: 2 }] }], [{ type: "reasoning", id: "r" }]]) {
			const model = createAskModel({ apiKey: "secret", fetch: vi.fn().mockResolvedValue(reply(output)) });
			await expect(model.turn(req)).rejects.toMatchObject({ message: "Invalid OpenAI response", retryable: false });
		}
		for (const [status, retryable] of [[401, false], [429, true], [503, true]] as const) {
			const model = createAskModel({ apiKey: "secret", fetch: vi.fn().mockResolvedValue(new Response("", { status })) });
			await expect(model.turn(req)).rejects.toMatchObject({ message: "OpenAI request failed", retryable });
		}
	});
});
