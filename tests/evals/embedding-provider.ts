import { config } from "../../src/core/config.js";
import type { EmbeddingProvider } from "../../src/core/types.js";
import { createEmbeddingProvider } from "../../src/embedding/factory.js";
import {
	getEmbeddingPreset,
	type EmbeddingMode,
} from "../../src/embedding/presets.js";

export interface EvalEmbeddingProvider {
	embedder: EmbeddingProvider;
	mode: EmbeddingMode;
	vectorSize: number;
}

export function createEvalEmbeddingProvider(
	purpose: "code" | "knowledge",
): EvalEmbeddingProvider {
	const raw = process.env.IDX_EVAL_EMBEDDING?.trim() || "local";
	if (raw !== "local" && raw !== "openrouter") {
		throw new Error("IDX_EVAL_EMBEDDING must be local or openrouter");
	}
	const mode: EmbeddingMode = raw;
	config.apply(getEmbeddingPreset(mode));
	return {
		embedder: createEmbeddingProvider(purpose),
		mode,
		vectorSize: config.get("vectorSize"),
	};
}
