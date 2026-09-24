import fs from "node:fs";
import os from "node:os";
import { parseEnv } from "node:util";
import { config } from "../core/config.js";
import { globalConfigPath } from "../core/global-config.js";
import type { EmbeddingProvider } from "../core/types.js";
import { OllamaEmbeddingProvider } from "./ollama.js";
import { OpenRouterEmbeddingProvider } from "./openrouter.js";

export type EmbeddingPurpose = "code" | "knowledge";

export function loadOpenRouterApiKey(
	_env: NodeJS.ProcessEnv = process.env,
	home = os.homedir(),
): string | undefined {
	const direct = _env.OPENROUTER_API_KEY?.trim();
	if (direct) return direct;
	const filePath = globalConfigPath(_env, home);
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
		const values = parseEnv(fs.readFileSync(filePath, "utf8"));
		return values.OPENROUTER_API_KEY?.trim() || undefined;
	} catch {
		return undefined;
	}
}

export function createEmbeddingProvider(
	purpose: EmbeddingPurpose,
	options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): EmbeddingProvider {
	const model = purpose === "code"
		? config.get("embeddingModel")
		: config.get("knowledgeEmbeddingModel");
	const provider = config.get("embeddingProvider");
	if (provider === "ollama") {
		return new OllamaEmbeddingProvider(
			config.get("ollamaBaseUrl"),
			model,
			config.get("indexBatchSize"),
			config.get("indexConcurrency"),
			config.get("ollamaNumCtx"),
		);
	}
	if (provider === "openrouter") {
		return new OpenRouterEmbeddingProvider(
			loadOpenRouterApiKey(options.env ?? process.env, options.home ?? os.homedir()),
			model,
			config.get("vectorSize"),
		);
	}
	throw new Error(`Unsupported embedding provider: ${provider}`);
}
