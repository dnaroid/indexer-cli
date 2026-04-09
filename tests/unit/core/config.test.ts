import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager, config } from "../../../src/core/config.js";

const DEFAULT_CONFIG = {
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
};

describe("ConfigManager", () => {
	let tempDirs: string[] = [];
	let manager: ConfigManager;

	beforeEach(() => {
		tempDirs = [];
		manager = new ConfigManager();
	});

	afterEach(() => {
		for (const dir of tempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-config-test-"));
		tempDirs.push(dir);
		return dir;
	}

	function writeConfig(dir: string, value: unknown): void {
		fs.writeFileSync(
			path.join(dir, "config.json"),
			JSON.stringify(value),
			"utf-8",
		);
	}

	it("exposes the singleton config manager", () => {
		expect(config).toBeInstanceOf(ConfigManager);
	});

	it("has the expected default values", () => {
		expect(manager.getAll()).toEqual(DEFAULT_CONFIG);
	});

	it("get() returns default values before load()", () => {
		expect(manager.get("embeddingProvider")).toBe("ollama");
		expect(manager.get("embeddingModel")).toBe("jina-8k");
		expect(manager.get("embeddingContextSize")).toBe(8192);
		expect(manager.get("vectorSize")).toBe(768);
		expect(manager.get("ollamaBaseUrl")).toBe("http://127.0.0.1:11434");
		expect(manager.get("ollamaNumCtx")).toBe(512);
		expect(manager.get("indexConcurrency")).toBe(2);
		expect(manager.get("indexBatchSize")).toBe(8);
		expect(manager.get("logLevel")).toBe("error");
	});

	it("getAll() returns defaults before load()", () => {
		expect(manager.getAll()).toEqual(DEFAULT_CONFIG);
	});

	it("keeps defaults when loading from a non-existent directory", () => {
		const dir = makeTempDir();

		manager.load(path.join(dir, "missing-subdir"));

		expect(manager.getAll()).toEqual(DEFAULT_CONFIG);
	});

	it("overrides matching keys from a valid config.json", () => {
		const dir = makeTempDir();
		writeConfig(dir, {
			embeddingProvider: "custom-provider",
			embeddingModel: "custom-model",
			embeddingContextSize: 4096,
			vectorSize: 1536,
			ollamaBaseUrl: "http://localhost:9999",
			ollamaNumCtx: 1024,
			indexConcurrency: 4,
			indexBatchSize: 16,
			logLevel: "debug",
		});

		manager.load(dir);

		expect(manager.getAll()).toEqual({
			...DEFAULT_CONFIG,
			embeddingProvider: "custom-provider",
			embeddingModel: "custom-model",
			embeddingContextSize: 4096,
			vectorSize: 1536,
			ollamaBaseUrl: "http://localhost:9999",
			ollamaNumCtx: 1024,
			indexConcurrency: 4,
			indexBatchSize: 16,
			logLevel: "debug",
		});
	});

	it("keeps defaults when config.json contains invalid JSON", () => {
		const dir = makeTempDir();
		fs.writeFileSync(path.join(dir, "config.json"), "{ invalid json", "utf-8");

		manager.load(dir);

		expect(manager.getAll()).toEqual(DEFAULT_CONFIG);
	});

	it("overrides only provided keys for a partial config", () => {
		const dir = makeTempDir();
		writeConfig(dir, {
			embeddingModel: "nomic-embed-text",
			indexConcurrency: 6,
		});

		manager.load(dir);

		expect(manager.getAll()).toEqual({
			...DEFAULT_CONFIG,
			embeddingModel: "nomic-embed-text",
			indexConcurrency: 6,
		});
	});

	it("keeps defaults for keys with invalid types", () => {
		const dir = makeTempDir();
		writeConfig(dir, {
			embeddingProvider: 123,
			embeddingModel: false,
			embeddingContextSize: "4096",
			vectorSize: "1536",
			ollamaBaseUrl: 42,
			ollamaNumCtx: "1024",
			indexConcurrency: "4",
			indexBatchSize: null,
			logLevel: { level: "debug" },
		});

		manager.load(dir);

		expect(manager.getAll()).toEqual(DEFAULT_CONFIG);
	});

	it("keeps defaults for zero or negative numeric values", () => {
		const dir = makeTempDir();
		writeConfig(dir, {
			embeddingContextSize: 0,
			vectorSize: -1,
			ollamaNumCtx: 0,
			indexConcurrency: -5,
			indexBatchSize: 0,
		});

		manager.load(dir);

		expect(manager.getAll()).toEqual(DEFAULT_CONFIG);
	});
});
