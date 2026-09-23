import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AskModelRequest, AskToolCall, AskTurn } from "./model.js";
import { fitAskRequest, type AskModelLimits } from "./request-budget.js";

const PACKAGE = "@earendil-works/pi-coding-agent";

function packageEntry(directory: string): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		if (manifest.name !== PACKAGE) return undefined;
		const entry = manifest.exports?.["."]?.import ?? manifest.main;
		if (typeof entry !== "string") return undefined;
		const absolute = resolve(directory, entry);
		const rel = relative(directory, absolute);
		if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return undefined;
		accessSync(absolute, constants.R_OK);
		return absolute;
	} catch {
		return undefined;
	}
}

export function findPiEntry(searchPath = process.env.PATH ?? "", modulePaths = createRequire(__filename).resolve.paths(PACKAGE) ?? []): string {
	for (const directory of modulePaths) {
		const entry = packageEntry(join(directory, PACKAGE));
		if (entry) return entry;
	}
	for (const directory of searchPath.split(delimiter)) {
		if (!isAbsolute(directory)) continue;
		try {
			const executable = join(directory, process.platform === "win32" ? "pi.cmd" : "pi");
			accessSync(executable, constants.X_OK);
			const target = realpathSync(executable);
			for (let current = dirname(target); current !== dirname(current); current = dirname(current)) {
				const entry = packageEntry(current);
				if (entry) return entry;
			}
		} catch {
			// A broken candidate must not hide a later compatible installation.
		}
	}
	throw new Error("Compatible Pi SDK not found");
}

export interface PiRequest {
	provider: string;
	model: string;
	request: AskModelRequest;
	limits?: AskModelLimits;
}

interface PiResponse { stopReason: string; errorMessage?: string; content: unknown[] }
interface PiContext {
	systemPrompt: string;
	messages: unknown[];
	tools: AskModelRequest["tools"];
}
export interface PiRuntimeModule {
	ModelRuntime: {
		create(options: { allowModelNetwork: false; refreshOnCreate: true; signal: AbortSignal }): Promise<{
			getModel(provider: string, model: string): unknown;
			completeSimple(model: unknown, context: PiContext, options: { maxTokens: number; maxRetries: number; signal: AbortSignal }): Promise<PiResponse>;
		}>;
	};
}

function piFailure(message: string, retryable = false): Error & { retryable: boolean } {
	return Object.assign(new Error(message), { retryable });
}

function selectedLimits(model: unknown, overrides: AskModelLimits = {}): AskModelLimits {
	const catalog = model && typeof model === "object" ? model as Record<string, unknown> : {};
	const cap = (known: unknown, override: number | undefined): number | undefined => {
		if (typeof known !== "number" || !Number.isFinite(known) || known <= 0) return override;
		return override === undefined ? known : Math.min(known, override);
	};
	return { contextTokens: cap(catalog.contextWindow, overrides.contextTokens), maxOutputTokens: cap(catalog.maxTokens, overrides.maxOutputTokens) };
}

function nativeMessages(request: AskModelRequest): unknown[] {
	return request.messages.map(message => {
		if (message.role === "user") return { role: "user", content: message.text, timestamp: Date.now() };
		if (message.role === "tool") return {
			role: "toolResult", toolCallId: message.id, toolName: message.name,
			content: [{ type: "text", text: message.text }], isError: message.isError, timestamp: Date.now(),
		};
		if (!message.turn.state) throw piFailure("Invalid Pi native history");
		return message.turn.state;
	});
}

function parseResponse(response: PiResponse): AskTurn {
	if (response.errorMessage) {
		const transient = /429|rate.?limit|overloaded|temporar|timed? ?out|timeout|\b5\d\d\b|ECONNRESET|ETIMEDOUT/i.test(response.errorMessage);
		throw piFailure("Pi request failed", transient);
	}
	if (!["stop", "toolUse"].includes(response.stopReason) || !Array.isArray(response.content)) throw piFailure("Invalid Pi completion");
	if (Buffer.byteLength(JSON.stringify(response)) > 99_000) throw piFailure("Pi response too large");
	const text: string[] = [];
	const calls: AskToolCall[] = [];
	for (const item of response.content) {
		if (!item || typeof item !== "object") throw piFailure("Invalid Pi completion");
		const block = item as Record<string, unknown>;
		if (block.type === "thinking") continue;
		if (block.type === "text" && typeof block.text === "string") text.push(block.text);
		else if (block.type === "toolCall" && typeof block.id === "string" && block.id && typeof block.name === "string" && block.name
			&& block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)) {
			calls.push({ id: block.id, name: block.name, arguments: block.arguments });
		} else throw piFailure("Invalid Pi completion");
	}
	if (new Set(calls.map(call => call.id)).size !== calls.length) throw piFailure("Invalid Pi completion");
	if ((calls.length && response.stopReason !== "toolUse") || (!calls.length && response.stopReason !== "stop") || (!calls.length && !text.join(""))) throw piFailure("Invalid Pi completion");
	return { text: text.join(""), toolCalls: calls, state: response };
}

export async function completePiRequest(input: PiRequest, sdk: PiRuntimeModule): Promise<AskTurn> {
	const signal = AbortSignal.timeout(Math.max(1, Math.min(input.request.timeoutMs, 20_000)));
	const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: true, signal });
	const model = runtime.getModel(input.provider, input.model);
	if (!model) throw piFailure("Pi model unavailable");
	const fitted = fitAskRequest(input.request, selectedLimits(model, input.limits));
	const request = fitted.request;
	const context = { systemPrompt: request.instructions, messages: nativeMessages(request), tools: request.tools };
	let response: PiResponse;
	try {
		response = await runtime.completeSimple(model, context, { maxTokens: request.maxOutputTokens, maxRetries: 0, signal });
	} catch {
		throw piFailure("Pi request failed", true);
	}
	return { ...parseResponse(response), notices: fitted.notices };
}
