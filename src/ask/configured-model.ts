import { loadAskConfig, type AskBackendConfig } from "./config.js";
import type { AskModel } from "./model.js";
import { createPiAskModel } from "./pi-provider.js";
import { createAskModel } from "./provider.js";
import { fitAskRequest } from "./request-budget.js";
import { createResilientAskModel } from "./resilient-model.js";
import { requestStructuredOutput } from "./structured-output.js";

export interface ConfiguredAskModel extends AskModel {
	json(instructions: string, input: unknown, name: string, schema: Record<string, unknown>): Promise<unknown>;
}

function backendModel(selection: AskBackendConfig): AskModel {
	if (selection.backend === "pi") {
		return createPiAskModel({ provider: selection.piProvider, model: selection.model, agentDir: selection.piAgentDir, limits: selection });
	}
	const backend = createAskModel({ apiKey: selection.apiKey, baseUrl: selection.baseUrl, model: selection.model });
	return {
		async turn(request) {
			const fitted = fitAskRequest(request, { ...selection, contextTokens: Math.min(selection.contextTokens ?? 16_000, 240_000) });
			const result = await backend.turn(fitted.request);
			return { ...result, notices: [...fitted.notices, ...(result.notices ?? [])] };
		},
	};
}

/** Resolve lazily so help and low-level commands never load inference configuration. */
export function createConfiguredAskModel(onNotice: (message: string) => void = () => {}): ConfiguredAskModel {
	let model: AskModel | undefined;
	const configured: ConfiguredAskModel = {
		async turn(request) {
			model ??= createResilientAskModel(loadAskConfig(), backendModel, notice => {
				onNotice(notice.type === "fallback"
					? `ASK fallback: switching to the explicitly configured ${notice.backend} fallback model.`
					: `ASK retry: repeating the failed ${notice.backend} inference request (retry ${notice.attempt}).`);
			});
			return model.turn(request);
		},
		json(instructions, input, name, schema) {
			return requestStructuredOutput(configured, instructions, input, name, schema);
		},
	};
	return configured;
}
