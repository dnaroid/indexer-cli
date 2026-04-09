import fs from "node:fs";
import path from "node:path";

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
	enrichModel: string;
	enrichConcurrency: number;
	excludePaths: string[];
}

const DEFAULT_CONFIG: IndexerConfig = {
	embeddingProvider: "ollama",
	embeddingModel: "jina-8k",
	embeddingContextSize: 8192,
	vectorSize: 768,
	ollamaBaseUrl: "http://127.0.0.1:11434",
	ollamaNumCtx: 512,
	indexConcurrency: 2,
	indexBatchSize: 8,
	logLevel: "error",
	enrichModel: "qwen2.5-coder:1.5b",
	enrichConcurrency: 1,
	excludePaths: ["fixtures/**", "vendor/**"],
};

export class ConfigManager {
	private config: IndexerConfig;

	constructor() {
		this.config = { ...DEFAULT_CONFIG };
	}

	load(dataDir: string): void {
		const configPath = path.join(dataDir, "config.json");
		if (!fs.existsSync(configPath)) return;

		try {
			const raw = fs.readFileSync(configPath, "utf-8");
			const parsed = JSON.parse(raw) as Partial<IndexerConfig>;

			if (typeof parsed.embeddingProvider === "string")
				this.config.embeddingProvider = parsed.embeddingProvider;
			if (typeof parsed.embeddingModel === "string")
				this.config.embeddingModel = parsed.embeddingModel;
			if (
				typeof parsed.embeddingContextSize === "number" &&
				parsed.embeddingContextSize > 0
			)
				this.config.embeddingContextSize = parsed.embeddingContextSize;
			if (typeof parsed.vectorSize === "number" && parsed.vectorSize > 0)
				this.config.vectorSize = parsed.vectorSize;
			if (typeof parsed.ollamaBaseUrl === "string")
				this.config.ollamaBaseUrl = parsed.ollamaBaseUrl;
			if (typeof parsed.ollamaNumCtx === "number" && parsed.ollamaNumCtx > 0)
				this.config.ollamaNumCtx = parsed.ollamaNumCtx;
			if (
				typeof parsed.indexConcurrency === "number" &&
				parsed.indexConcurrency > 0
			)
				this.config.indexConcurrency = parsed.indexConcurrency;
			if (
				typeof parsed.indexBatchSize === "number" &&
				parsed.indexBatchSize > 0
			)
				this.config.indexBatchSize = parsed.indexBatchSize;
			if (typeof parsed.logLevel === "string")
				this.config.logLevel = parsed.logLevel;
			if (typeof parsed.enrichModel === "string")
				this.config.enrichModel = parsed.enrichModel;
			if (
				typeof parsed.enrichConcurrency === "number" &&
				parsed.enrichConcurrency > 0
			)
				this.config.enrichConcurrency = parsed.enrichConcurrency;
			if (Array.isArray(parsed.excludePaths)) {
				const excludePaths = parsed.excludePaths
					.filter((value): value is string => typeof value === "string")
					.map((value) => value.trim())
					.filter((value) => value.length > 0);
				if (excludePaths.length === parsed.excludePaths.length) {
					this.config.excludePaths = excludePaths;
				}
			}
		} catch {
			// config unreadable — keep defaults
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
