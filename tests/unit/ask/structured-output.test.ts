import { describe, expect, it, vi } from "vitest";
import { requestStructuredOutput } from "../../../src/ask/structured-output.js";

describe("advisory structured output", () => {
	it("uses a result-only tool, without running the ask loop", async () => {
		const turn = vi.fn().mockResolvedValue({ text: "", toolCalls: [{ id: "1", name: "document_metadata", arguments: { kind: "spec" } }] });
		const schema = { type: "object" };
		expect(await requestStructuredOutput({ turn }, "Classify", { document: "untrusted" }, "document_metadata", schema)).toEqual({ kind: "spec" });
		expect(turn).toHaveBeenCalledOnce();
		expect(turn.mock.calls[0][0]).toMatchObject({ tools: [{ name: "document_metadata", parameters: schema }], timeoutMs: 5000 });
	});
	it("rejects unsolicited text and the wrong result tool", async () => {
		for (const toolCalls of [[], [{ id: "1", name: "shell", arguments: {} }]]) {
			await expect(requestStructuredOutput({ turn: async () => ({ text: "guess", toolCalls }) }, "Classify", {}, "document_metadata", {})).rejects.toThrow("Invalid structured output");
		}
	});
});
