import fs from "node:fs";
import path from "node:path";
import { sanitizePathPatterns } from "../utils/path-patterns.js";

export interface IndexerConfig {
	version: string;
	embeddingProvider: string;
	embeddingModel: string;
	embeddingContextSize: number;
	vectorSize: number;
	ollamaBaseUrl: string;
	ollamaNumCtx: number;
	indexConcurrency: number;
	indexBatchSize: number;
	logLevel: string;
	indexIncludePaths: string[];
	visibilityExcludePaths: string[];
	searchMinScore: number;
}

export const DEFAULT_CONFIG: IndexerConfig = {
	version: "0.0.0",
	embeddingProvider: "ollama",
	embeddingModel: "jina-8k",
	embeddingContextSize: 8192,
	vectorSize: 768,
	ollamaBaseUrl: "http://127.0.0.1:11434",
	ollamaNumCtx: 512,
	indexConcurrency: 2,
	indexBatchSize: 8,
	logLevel: "error",
	indexIncludePaths: [],
	visibilityExcludePaths: ["fixtures/**", "**/fixtures/**", "vendor/**"],
	searchMinScore: 0.55,
};

type RawConfig = Partial<IndexerConfig>;

function loadPathPatterns(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (!value.every((item): item is string => typeof item === "string")) {
		return null;
	}
	return sanitizePathPatterns(value);
}

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
			const parsed = JSON.parse(raw) as RawConfig;

			if (typeof parsed.version === "string")
				this.config.version = parsed.version;
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
			const indexIncludePaths = loadPathPatterns(parsed.indexIncludePaths);
			if (indexIncludePaths) this.config.indexIncludePaths = indexIncludePaths;
			const visibilityExcludePaths = loadPathPatterns(
				parsed.visibilityExcludePaths,
			);
			if (visibilityExcludePaths) {
				this.config.visibilityExcludePaths = visibilityExcludePaths;
			}
			if (
				typeof parsed.searchMinScore === "number" &&
				parsed.searchMinScore >= 0 &&
				parsed.searchMinScore <= 1
			)
				this.config.searchMinScore = parsed.searchMinScore;
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
