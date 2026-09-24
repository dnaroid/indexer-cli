import type { IndexerConfig } from "../core/config.js";

export type EmbeddingMode = "local" | "openrouter";

export const OPENROUTER_EMBEDDING_MODEL = "perplexity/pplx-embed-v1-0.6b";
export const OPENROUTER_EMBEDDING_DIMENSION = 1024;

type EmbeddingPreset = Pick<
	IndexerConfig,
	| "embeddingProvider"
	| "embeddingModel"
	| "knowledgeEmbeddingModel"
	| "knowledgeEmbeddingQueryPrefix"
	| "knowledgeEmbeddingDocumentPrefix"
	| "embeddingContextSize"
	| "vectorSize"
>;

const PRESETS: Record<EmbeddingMode, EmbeddingPreset> = {
	local: {
		embeddingProvider: "ollama",
		embeddingModel: "jina-8k",
		knowledgeEmbeddingModel: "nomic-embed-text-v2-moe",
		knowledgeEmbeddingQueryPrefix: "search_query: ",
		knowledgeEmbeddingDocumentPrefix: "search_document: ",
		embeddingContextSize: 8192,
		vectorSize: 768,
	},
	openrouter: {
		embeddingProvider: "openrouter",
		embeddingModel: OPENROUTER_EMBEDDING_MODEL,
		knowledgeEmbeddingModel: OPENROUTER_EMBEDDING_MODEL,
		knowledgeEmbeddingQueryPrefix: "",
		knowledgeEmbeddingDocumentPrefix: "",
		embeddingContextSize: 32768,
		vectorSize: OPENROUTER_EMBEDDING_DIMENSION,
	},
};

export function getEmbeddingPreset(mode: EmbeddingMode): EmbeddingPreset {
	return { ...PRESETS[mode] };
}

export function parseEmbeddingMode(value: string | undefined): EmbeddingMode | undefined {
	if (value === undefined) return undefined;
	if (value === "local" || value === "openrouter") return value;
	throw new Error("--embedding must be local or openrouter.");
}

export function embeddingModeForProvider(provider: string): EmbeddingMode | null {
	if (provider === "ollama") return "local";
	if (provider === "openrouter") return "openrouter";
	return null;
}

export function embeddingIdentity(config: Pick<
	IndexerConfig,
	| "embeddingProvider"
	| "embeddingModel"
	| "knowledgeEmbeddingModel"
	| "knowledgeEmbeddingQueryPrefix"
	| "knowledgeEmbeddingDocumentPrefix"
	| "vectorSize"
>): string {
	return JSON.stringify({
		provider: config.embeddingProvider,
		codeModel: config.embeddingModel,
		knowledgeModel: config.knowledgeEmbeddingModel,
		queryPrefix: config.knowledgeEmbeddingQueryPrefix,
		documentPrefix: config.knowledgeEmbeddingDocumentPrefix,
		vectorSize: config.vectorSize,
	});
}
