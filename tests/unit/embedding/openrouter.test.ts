import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../../src/core/config.js";
import {
	createEmbeddingProvider,
	loadOpenRouterApiKey,
} from "../../../src/embedding/factory.js";
import { OpenRouterEmbeddingProvider } from "../../../src/embedding/openrouter.js";
import { getEmbeddingPreset } from "../../../src/embedding/presets.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	config.apply(getEmbeddingPreset("local"));
});

describe("OpenRouterEmbeddingProvider", () => {
	it("requires an API key before semantic work starts", async () => {
		const provider = new OpenRouterEmbeddingProvider(undefined, "model", 3);

		await expect(provider.initialize()).rejects.toThrow("OPENROUTER_API_KEY");
		await expect(provider.embed(["hello"])).rejects.toThrow("OPENROUTER_API_KEY");
	});

	it("batches requests, preserves input order, and validates dimensions", async () => {
		const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
			const data = body.input
				.map((text, index) => ({ index, embedding: [text.length, index, 1] }))
				.reverse();
			return new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const provider = new OpenRouterEmbeddingProvider(
			"secret",
			"perplexity/pplx-embed-v1-0.6b",
			3,
			2,
			1,
			"https://example.test/api/v1/",
		);

		const result = await provider.embed(["a", "bbbb", "cc"]);

		expect(result).toEqual([
			[1, 0, 1],
			[4, 1, 1],
			[2, 0, 1],
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.test/api/v1/embeddings");
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
			Authorization: "Bearer secret",
			"Content-Type": "application/json",
		});
	});

	it("retries a rate-limited batch", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: { message: "slow down" } }), {
					status: 429,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);
		const provider = new OpenRouterEmbeddingProvider("secret", "model", 3);

		await expect(provider.embed(["retry"])).resolves.toEqual([[1, 2, 3]]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("loads the OpenRouter key from the shared idx config when env is empty", () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "idx-openrouter-key-"));
		try {
			const configDir = path.join(home, ".config", "idx");
			fs.mkdirSync(configDir, { recursive: true });
			fs.writeFileSync(path.join(configDir, ".env"), "OPENROUTER_API_KEY=file-key\n", "utf8");

			expect(loadOpenRouterApiKey({}, home)).toBe("file-key");
			expect(loadOpenRouterApiKey({ OPENROUTER_API_KEY: "env-key" }, home)).toBe("env-key");
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	it("factory uses the OpenRouter preset for both code and knowledge", () => {
		config.apply(getEmbeddingPreset("openrouter"));

		const code = createEmbeddingProvider("code", {
			env: { OPENROUTER_API_KEY: "test-key" },
		});
		const knowledge = createEmbeddingProvider("knowledge", {
			env: { OPENROUTER_API_KEY: "test-key" },
		});

		expect(code.id).toBe("openrouter");
		expect(knowledge.id).toBe("openrouter");
		expect(code.getDimension()).toBe(1024);
		expect(knowledge.getDimension()).toBe(1024);
	});
});
