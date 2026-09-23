/** Provider-neutral conversation; opaque state preserves native reasoning/tool signatures. */
export interface AskToolCall {
	id: string;
	name: string;
	arguments: unknown;
}

export interface AskTurn {
	text: string;
	toolCalls: AskToolCall[];
	state?: unknown;
	/** Adapter-generated diagnostics, never model-written prose. */
	notices?: string[];
}

export type AskMessage =
	| { role: "user"; text: string }
	| { role: "assistant"; turn: AskTurn }
	| { role: "tool"; id: string; name: string; text: string; isError: boolean };

export interface AskToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface AskModelRequest {
	instructions: string;
	messages: AskMessage[];
	tools: AskToolDefinition[];
	maxOutputTokens: number;
	timeoutMs: number;
}

export interface AskModel {
	turn(request: AskModelRequest): Promise<AskTurn>;
}
