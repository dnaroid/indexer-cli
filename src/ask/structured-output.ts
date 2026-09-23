import type { AskModel } from "./model.js";

/** Retain the advisory document classifier's structured API without running ask tools. */
export async function requestStructuredOutput(
	model: AskModel,
	instructions: string,
	input: unknown,
	name: string,
	schema: Record<string, unknown>,
): Promise<unknown> {
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("Invalid structured output name");
	const result = await model.turn({
		instructions: `${instructions}\nReturn the structured result by calling ${name} exactly once. Do not call other tools.`,
		messages: [{ role: "user", text: JSON.stringify(input) }],
		tools: [{ name, description: "Return the requested structured result; this function executes no operation.", parameters: schema }],
		maxOutputTokens: 2000,
		timeoutMs: 5000,
	});
	if (result.toolCalls.length !== 1 || result.toolCalls[0].name !== name) {
		throw new Error("Invalid structured output");
	}
	return result.toolCalls[0].arguments;
}
