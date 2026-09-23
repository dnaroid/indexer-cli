import type { AskModel, AskModelRequest, AskTurn } from "./model.js";
export type { AskMessage, AskModel, AskModelRequest, AskToolCall, AskToolDefinition, AskTurn } from "./model.js";

const MAX_RESPONSE_BYTES = 100_000;
const MAX_REQUEST_BYTES = 256_000;
const TIMEOUT_CAP_MS = 20_000;
type RetryableError = Error & { retryable: boolean };

function fail(message: string, retryable = false): RetryableError {
	return Object.assign(new Error(message), { retryable });
}

function endpoint(baseUrl: string): string {
	let url: URL;
	try { url = new URL(baseUrl); } catch { throw fail("Invalid OpenAI base URL"); }
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) throw fail("Invalid OpenAI base URL");
	return `${url.toString().replace(/\/$/, "")}/responses`;
}

function serializeRequest(request: AskModelRequest, model: string): string {
	const input: unknown[] = [];
	for (const message of request.messages) {
		if (message.role === "user") input.push({ role: "user", content: message.text });
		else if (message.role === "tool") input.push({ type: "function_call_output", call_id: message.id, output: message.text });
		else if (Array.isArray(message.turn.state)) input.push(...message.turn.state);
		else {
			if (message.turn.text) input.push({ role: "assistant", content: message.turn.text });
			for (const call of message.turn.toolCalls) input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
		}
	}
	const body = {
		model, store: false, instructions: request.instructions, input,
		include: ["reasoning.encrypted_content"],
		reasoning: { effort: "none" },
		max_output_tokens: request.maxOutputTokens,
		tools: request.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: true })),
	};
	const serialized = JSON.stringify(body);
	if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) throw fail("OpenAI request too large");
	return serialized;
}

function parseResponse(data: unknown): AskTurn {
	if (!data || typeof data !== "object") throw fail("Invalid OpenAI response");
	const result = data as Record<string, unknown>;
	if (result.status === "incomplete") throw fail("OpenAI response incomplete");
	if (result.status !== "completed" || !Array.isArray(result.output)) throw fail("Invalid OpenAI response");
	const calls: AskTurn["toolCalls"] = [];
	let text = "";
	const ids = new Set<string>();
	for (const item of result.output) {
		if (!item || typeof item !== "object") throw fail("Invalid OpenAI response");
		const block = item as Record<string, unknown>;
		if (block.type === "function_call") {
			let args: unknown;
			try { if (typeof block.arguments !== "string") throw new Error(); args = JSON.parse(block.arguments); } catch { throw fail("Invalid OpenAI response"); }
			if (typeof block.call_id !== "string" || !block.call_id || ids.has(block.call_id) || typeof block.name !== "string" || !block.name) throw fail("Invalid OpenAI response");
			ids.add(block.call_id);
			calls.push({ id: block.call_id, name: block.name, arguments: args });
		} else if (block.type === "message") {
			if (block.status !== "completed" || !Array.isArray(block.content)) throw fail("Invalid OpenAI response");
			for (const value of block.content) {
				if (!value || typeof value !== "object") throw fail("Invalid OpenAI response");
				const part = value as Record<string, unknown>;
				if (part.type === "refusal") throw fail("OpenAI refused the request");
				if (part.type === "output_text") {
					if (typeof part.text !== "string") throw fail("Invalid OpenAI response");
					text += part.text;
				} else throw fail("Invalid OpenAI response");
			}
		} else if (block.type === "reasoning") {
			if (typeof block.id !== "string" || typeof block.encrypted_content !== "string") throw fail("Invalid OpenAI response");
		} else throw fail("Invalid OpenAI response");
	}
	if (Buffer.byteLength(JSON.stringify(result.output)) > MAX_RESPONSE_BYTES) throw fail("OpenAI response too large");
	if (!text && !calls.length) throw fail("Invalid OpenAI response");
	return { text, toolCalls: calls, state: result.output };
}

export function createAskModel(options: { apiKey?: string; baseUrl?: string; model?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch } = {}): AskModel {
	const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
	const url = endpoint(options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1");
	const model = options.model ?? process.env.IDX_ASK_MODEL ?? "gpt-6-luna";
	const fetcher = options.fetch ?? globalThis.fetch;
	return { async turn(request: AskModelRequest): Promise<AskTurn> {
		if (!apiKey) throw fail("OpenAI API key is not configured");
		const body = serializeRequest(request, model);
		const controller = new AbortController();
		const timeout = Math.min(request.timeoutMs, options.timeoutMs ?? TIMEOUT_CAP_MS, TIMEOUT_CAP_MS);
		const timer = setTimeout(() => controller.abort(), timeout);
		try {
			const response = await fetcher(url, { method: "POST", redirect: "error", signal: controller.signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body });
			if (!response.ok) {
				if (response.status === 429 || response.status >= 500) throw fail("OpenAI request failed", true);
				throw fail("OpenAI request failed");
			}
			const reader = response.body?.getReader();
			if (!reader) throw fail("Invalid OpenAI response");
			const chunks: Uint8Array[] = [];
			let size = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw fail("OpenAI response too large"); }
				chunks.push(value);
			}
			let parsed: unknown;
			try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail("Invalid OpenAI response"); }
			return parseResponse(parsed);
		} catch (error) {
			if (error instanceof Error && "retryable" in error) throw error;
			if (controller.signal.aborted) throw fail("OpenAI request timed out", true);
			throw fail("OpenAI request failed", true);
		} finally { clearTimeout(timer); }
	} };
}
