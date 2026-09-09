import fs from "node:fs";
import path from "node:path";
import { sanitizePathPatterns } from "../utils/path-patterns.js";

export interface IndexerConfig {
	version: string;
	skillTargets: Array<"claude" | "codex">;
	embeddingProvider: string;
	embeddingModel: string;
	knowledgeEmbeddingModel: string;
	knowledgeEmbeddingQueryPrefix: string;
	knowledgeEmbeddingDocumentPrefix: string;
	embeddingContextSize: number;
	vectorSize: number;
	ollamaBaseUrl: string;
	ollamaNumCtx: number;
	indexConcurrency: number;
	indexBatchSize: number;
	logLevel: string;
	indexIncludePaths: string[];
	indexExcludePaths: string[];
	visibilityExcludePaths: string[];
	documentExtensions: string[];
	documentIncludePaths: string[];
	documentExcludePaths: string[];
	documentMaxBytes: number;
	searchMinScore: number;
}

export const DEFAULT_CONFIG: IndexerConfig = {
	version: "0.0.0",
	skillTargets: [],
	embeddingProvider: "ollama",
	embeddingModel: "jina-8k",
	knowledgeEmbeddingModel: "nomic-embed-text-v2-moe",
	knowledgeEmbeddingQueryPrefix: "search_query: ",
	knowledgeEmbeddingDocumentPrefix: "search_document: ",
	embeddingContextSize: 8192,
	vectorSize: 768,
	ollamaBaseUrl: "http://127.0.0.1:11434",
	ollamaNumCtx: 512,
	indexConcurrency: 2,
	indexBatchSize: 8,
	logLevel: "error",
	indexIncludePaths: [],
	indexExcludePaths: [],
	visibilityExcludePaths: ["fixtures/**", "**/fixtures/**", "vendor/**"],
	documentExtensions: [".md", ".mdx", ".rst", ".adoc", ".txt"],
	documentIncludePaths: [],
	documentExcludePaths: [
		"evals/**",
		"**/evals/**",
		"fixtures/**",
		"**/fixtures/**",
		"testdata/**",
		"**/testdata/**",
		"examples/**",
		"**/examples/**",
		".claude/skills/**",
		".pi/skills/**",
		".agents/skills/**",
	],
	documentMaxBytes: 524_288,
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

function loadExtensions(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (!value.every((item): item is string => typeof item === "string")) {
		return null;
	}
	return Array.from(
		new Set(
			value
				.map((item) => item.trim().toLowerCase())
				.filter(Boolean)
				.map((item) => (item.startsWith(".") ? item : `.${item}`)),
		),
	).sort();
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
			if (Array.isArray(parsed.skillTargets)) {
				this.config.skillTargets = [
					...new Set(
						parsed.skillTargets.filter(
							(item): item is "claude" | "codex" =>
								item === "claude" || item === "codex",
						),
					),
				].sort() as Array<"claude" | "codex">;
			}
			if (typeof parsed.embeddingProvider === "string")
				this.config.embeddingProvider = parsed.embeddingProvider;
			if (typeof parsed.embeddingModel === "string")
				this.config.embeddingModel = parsed.embeddingModel;
			if (typeof parsed.knowledgeEmbeddingModel === "string")
				this.config.knowledgeEmbeddingModel = parsed.knowledgeEmbeddingModel;
			if (typeof parsed.knowledgeEmbeddingQueryPrefix === "string") {
				this.config.knowledgeEmbeddingQueryPrefix = parsed.knowledgeEmbeddingQueryPrefix;
			}
			if (typeof parsed.knowledgeEmbeddingDocumentPrefix === "string") {
				this.config.knowledgeEmbeddingDocumentPrefix =
					parsed.knowledgeEmbeddingDocumentPrefix;
			}
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
			const indexExcludePaths = loadPathPatterns(parsed.indexExcludePaths);
			if (indexExcludePaths) this.config.indexExcludePaths = indexExcludePaths;
			const visibilityExcludePaths = loadPathPatterns(
				parsed.visibilityExcludePaths,
			);
			if (visibilityExcludePaths) {
				this.config.visibilityExcludePaths = visibilityExcludePaths;
			}
			const documentExtensions = loadExtensions(parsed.documentExtensions);
			if (documentExtensions) this.config.documentExtensions = documentExtensions;
			const documentIncludePaths = loadPathPatterns(parsed.documentIncludePaths);
			if (documentIncludePaths) {
				this.config.documentIncludePaths = documentIncludePaths;
			}
			const documentExcludePaths = loadPathPatterns(parsed.documentExcludePaths);
			if (documentExcludePaths) {
				this.config.documentExcludePaths = documentExcludePaths;
			}
			if (
				typeof parsed.documentMaxBytes === "number" &&
				Number.isFinite(parsed.documentMaxBytes) &&
				parsed.documentMaxBytes > 0
			) {
				this.config.documentMaxBytes = Math.floor(parsed.documentMaxBytes);
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
