export interface IndexerConfig {
	embeddingProvider: string;
	embeddingModel: string;
	embeddingContextSize: number;
	vectorSize: number;
	ollamaBaseUrl: string;
	ollamaNumCtx: number;
	indexConcurrency: number;
	indexBatchSize: number;
	logLevel: string;
}

const DEFAULT_CONFIG: IndexerConfig = {
	embeddingProvider: "ollama",
	embeddingModel: "jina-8k",
	embeddingContextSize: 8192,
	vectorSize: 768,
	ollamaBaseUrl: "http://127.0.0.1:11434",
	ollamaNumCtx: 512,
	indexConcurrency: 1,
	indexBatchSize: 1,
	logLevel: "error",
};

export class ConfigManager {
	private config: IndexerConfig;

	constructor() {
		this.config = { ...DEFAULT_CONFIG };
		this.loadFromProcessEnv();
	}

	private loadFromProcessEnv(): void {
		const env = process.env as Record<string, string>;

		if (env.INDEXER_EMBEDDING_PROVIDER) {
			this.config.embeddingProvider =
				env.INDEXER_EMBEDDING_PROVIDER.toLowerCase();
		}
		if (env.INDEXER_EMBEDDING_MODEL) {
			this.config.embeddingModel = env.INDEXER_EMBEDDING_MODEL;
		}
		if (env.INDEXER_EMBEDDING_CONTEXT_SIZE) {
			const size = parseInt(env.INDEXER_EMBEDDING_CONTEXT_SIZE, 10);
			if (Number.isFinite(size) && size > 0)
				this.config.embeddingContextSize = size;
		}
		if (env.INDEXER_VECTOR_SIZE) {
			const size = parseInt(env.INDEXER_VECTOR_SIZE, 10);
			if (Number.isFinite(size) && size > 0) this.config.vectorSize = size;
		}
		if (env.INDEXER_OLLAMA_BASE_URL) {
			this.config.ollamaBaseUrl = env.INDEXER_OLLAMA_BASE_URL;
		}
		if (env.INDEXER_OLLAMA_NUM_CTX) {
			const numCtx = parseInt(env.INDEXER_OLLAMA_NUM_CTX, 10);
			if (Number.isFinite(numCtx) && numCtx > 0)
				this.config.ollamaNumCtx = numCtx;
		}
		const concurrencyRaw =
			env.INDEXER_INDEX_CONCURRENCY ?? env.INDEX_CONCURRENCY;
		if (concurrencyRaw) {
			const concurrency = parseInt(concurrencyRaw, 10);
			if (Number.isFinite(concurrency) && concurrency > 0)
				this.config.indexConcurrency = concurrency;
		}
		if (env.INDEX_BATCH_SIZE) {
			const size = parseInt(env.INDEX_BATCH_SIZE, 10);
			if (Number.isFinite(size) && size > 0) this.config.indexBatchSize = size;
		}
		if (env.LOG_LEVEL) {
			const level = env.LOG_LEVEL.toLowerCase();
			if (["trace", "debug", "info", "warn", "error"].includes(level)) {
				this.config.logLevel = level;
			}
		}
	}

	public get<K extends keyof IndexerConfig>(key: K): IndexerConfig[K] {
		return this.config[key];
	}

	public getAll(): Readonly<IndexerConfig> {
		return { ...this.config };
	}
}

export const config = new ConfigManager();
