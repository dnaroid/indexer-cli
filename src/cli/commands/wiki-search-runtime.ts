import path from "node:path";
import { config } from "../../core/config.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { OllamaEmbeddingProvider } from "../../embedding/ollama.js";
import { KnowledgeSearchEngine, type KnowledgeSearchOptions } from "../../knowledge/search.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import type { WikiRuntime } from "./wiki-runtime.js";

export type WikiSearchMode = NonNullable<KnowledgeSearchOptions["mode"]>;

export function parseWikiSearchMode(value = "hybrid"): WikiSearchMode {
	if (value !== "hybrid" && value !== "lexical" && value !== "semantic") {
		throw new Error("--mode must be hybrid, lexical, or semantic.");
	}
	return value;
}

/** Initialize semantic resources only on demand; lexical mode is network-free. */
export async function withWikiSearch<T>(
	runtime: WikiRuntime,
	mode: WikiSearchMode,
	action: (engine: KnowledgeSearchEngine, initializationWarning?: string) => Promise<T>,
): Promise<T> {
	let vectors: SqliteVecVectorStore | null = null;
	let embedder: OllamaEmbeddingProvider | null = null;
	let semanticReady = false;
	let initializationWarning: string | undefined;
	try {
		if (mode !== "lexical") {
			try {
				vectors = new SqliteVecVectorStore({
					dbPath: path.join(runtime.projectRoot, ".indexer-cli", "db.sqlite"),
					vectorSize: config.get("vectorSize"),
				});
				embedder = new OllamaEmbeddingProvider(
					config.get("ollamaBaseUrl"), config.get("knowledgeEmbeddingModel"),
					config.get("indexBatchSize"), config.get("indexConcurrency"), config.get("ollamaNumCtx"),
				);
				await vectors.initialize();
				await embedder.initialize();
				semanticReady = true;
			} catch (error) {
				initializationWarning = error instanceof Error ? error.message : String(error);
				if (mode === "semantic") throw new Error(`Semantic knowledge search unavailable: ${initializationWarning}`);
			}
		}
		const engine = new KnowledgeSearchEngine(
			DEFAULT_PROJECT_ID, runtime.snapshotId, runtime.metadata, runtime.metadata,
			vectors, semanticReady ? embedder : null, runtime.service,
		);
		return await action(engine, initializationWarning);
	} finally {
		await Promise.allSettled([vectors?.close(), embedder?.close()]);
	}
}
