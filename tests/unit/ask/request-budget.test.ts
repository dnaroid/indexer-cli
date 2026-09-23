import { describe, expect, it } from "vitest";
import { fitAskRequest } from "../../../src/ask/request-budget.js";
import type { AskModelRequest } from "../../../src/ask/model.js";

const base: AskModelRequest = {
	instructions: "Follow the system policy.",
	messages: [{ role: "user", text: "Original question exactly?" }],
	tools: [{ name: "search", description: "Search", parameters: { type: "object" } }],
	maxOutputTokens: 500,
	timeoutMs: 1000,
};

describe("fitAskRequest", () => {
	it("preserves full request and native transcript identity when it fits", () => {
		const original = { ...base, messages: [...base.messages, { role: "assistant" as const, turn: { text: "", toolCalls: [], state: { signature: "native" } } }] };
		expect(fitAskRequest(original, { contextTokens: 10_000, maxOutputTokens: 600 })).toEqual({ request: original, notices: [] });
	});

	it("clamps output and compacts with original question, evidence IDs, and no assistant calls", () => {
		const request = { ...base, maxOutputTokens: 900, messages: [...base.messages, { role: "assistant" as const, turn: { text: "call", toolCalls: [{ id: "call-1", name: "search", arguments: {} }] } }, { role: "tool" as const, id: "evidence-42", name: "search", text: "latest observation ".repeat(100), isError: false }] };
		const result = fitAskRequest(request, { contextTokens: 1_500, maxOutputTokens: 300 });
		expect(result.request.maxOutputTokens).toBeGreaterThan(0);
		expect(result.request.maxOutputTokens).toBeLessThanOrEqual(300);
		expect(result.request.messages[0]).toEqual(base.messages[0]);
		expect(result.request.messages.some(m => m.role === "user" && m.text.includes("Untrusted observation"))).toBe(true);
		expect(result.request.messages.some(m => m.role === "user" && m.text.includes("evidence-42"))).toBe(true);
		expect(result.request.messages.some(m => m.role === "assistant")).toBe(false);
		expect(result.notices.length).toBeGreaterThan(0);
	});

	it("uses byte estimates for multibyte text and rejects an impossible fixed prompt deterministically", () => {
		expect(() => fitAskRequest({ ...base, instructions: "界".repeat(1000) }, { contextTokens: 800, maxOutputTokens: 100 })).toThrow("Ask request exceeds model context limit");
	});

	it("honors effective model metadata caps and clamps oversized observations", () => {
		const result = fitAskRequest({ ...base, messages: [...base.messages, { role: "tool", id: "src-1", name: "tool", text: "é".repeat(5000), isError: false }] }, { contextTokens: 1_100, maxOutputTokens: 120 });
		expect(result.request.maxOutputTokens).toBeGreaterThan(0);
		expect(result.request.maxOutputTokens).toBeLessThanOrEqual(120);
		expect(Buffer.byteLength(JSON.stringify(result.request))).toBeLessThan(1_100 - result.request.maxOutputTokens - 512);
		expect(result.request.messages[0]).toEqual(base.messages[0]);
	});

	it("budgets escaped serialized observations and preserves only one copy of the question", () => {
		const question = 'Question \\"quoted\\"\ncontrol\t界?';
		const request = { ...base, messages: [{ role: "user" as const, text: question }, { role: "tool" as const, id: "obs-1", name: "tool", text: '\\"\n\t界'.repeat(500), isError: false }] };
		const result = fitAskRequest(request, { contextTokens: 1_300, maxOutputTokens: 150 });
		const serialized = Buffer.byteLength(JSON.stringify(result.request), "utf8") + 64 + 512 + result.request.maxOutputTokens;
		expect(serialized).toBeLessThanOrEqual(1_300);
		expect(result.request.messages.filter(m => m.role === "user" && m.text === question)).toHaveLength(1);
		expect(result.request.messages.some(m => m.role === "user" && m.text.includes("obs-1"))).toBe(true);
	});

	it("reduces requested output to available context and drops orphan protocol", () => {
		const request = { ...base, maxOutputTokens: 10_000, messages: [...base.messages, { role: "assistant" as const, turn: { text: "", toolCalls: [{ id: "orphan", name: "search", arguments: {} }] } }, { role: "tool" as const, id: "old", name: "search", text: "old" , isError: false }, { role: "tool" as const, id: "new", name: "search", text: "new".repeat(400), isError: false }] };
		const result = fitAskRequest(request, { contextTokens: 2_000, maxOutputTokens: 20_000 });
		expect(result.request.maxOutputTokens).toBeLessThan(20_000);
		expect(result.request.messages.some(m => m.role === "assistant")).toBe(false);
		expect(result.request.messages.filter(m => m.role === "user" && m.text === "Original question exactly?")).toHaveLength(1);
		expect(result.request.messages.some(m => m.role === "user" && m.text.includes("new"))).toBe(true);
		expect(result.notices.some(n => n.includes("output limit reduced"))).toBe(true);
		expect(Buffer.byteLength(JSON.stringify(result.request), "utf8") + 64 + 512 + result.request.maxOutputTokens).toBeLessThanOrEqual(2_000);
	});
});
