import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDocumentClassifierConfig } from "../../../src/knowledge/document-classifier-config.js";

const roots: string[] = [];
function temp(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "idx-jev-config-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("loadDocumentClassifierConfig", () => {
	it("uses Jev/OpenRouter defaults without credentials", () => {
		const config = loadDocumentClassifierConfig({}, temp());
		expect(config).toEqual({
			apiKey: undefined,
			model: "~typesafe/jev-latest",
			url: "https://openrouter.ai/api/alpha/decisions",
			timeoutMs: 5000,
			kindMinConfidence: 0.9,
			statusMinConfidence: 0.65,
		});
	});

	it("reads classifier settings from the global idx env and lets exported env win", () => {
		const home = temp();
		const directory = path.join(home, ".config", "idx");
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, ".env"), [
			"OPENROUTER_API_KEY=file-key",
			"IDX_JEV_MODEL=typesafe/jev-file",
			"IDX_JEV_URL=https://example.test/file-decisions",
			"IDX_JEV_TIMEOUT_MS=9000",
			"IDX_JEV_KIND_MIN_CONFIDENCE=0.8",
			"IDX_JEV_STATUS_MIN_CONFIDENCE=0.7",
		].join("\n"));
		const config = loadDocumentClassifierConfig({ IDX_JEV_MODEL: "typesafe/jev-env", OPENROUTER_API_KEY: "env-key" }, home);
		expect(config).toEqual({
			apiKey: "env-key",
			model: "typesafe/jev-env",
			url: "https://example.test/file-decisions",
			timeoutMs: 9000,
			kindMinConfidence: 0.8,
			statusMinConfidence: 0.7,
		});
	});

	it("rejects an invalid timeout", () => {
		expect(() => loadDocumentClassifierConfig({ IDX_JEV_TIMEOUT_MS: "10" }, temp())).toThrow("Invalid IDX_JEV_TIMEOUT_MS");
	});

	it("rejects invalid confidence thresholds", () => {
		expect(() => loadDocumentClassifierConfig({ IDX_JEV_KIND_MIN_CONFIDENCE: "1.1" }, temp())).toThrow("Invalid IDX_JEV_KIND_MIN_CONFIDENCE");
		expect(() => loadDocumentClassifierConfig({ IDX_JEV_STATUS_MIN_CONFIDENCE: "nope" }, temp())).toThrow("Invalid IDX_JEV_STATUS_MIN_CONFIDENCE");
	});
});
