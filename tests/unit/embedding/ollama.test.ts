import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaEmbeddingProvider } from "../../../src/embedding/ollama.js";

const DIM = 768;
const mockEmbedding = (seed: number): number[] =>
	Array.from({ length: DIM }, (_, i) => seed + i * 0.001);

describe("OllamaEmbeddingProvider", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("strips a trailing slash in the constructor and reports dimension 768", () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434/");

		expect((provider as any).baseUrl).toBe("http://localhost:11434");
		expect((provider as any).model).toBe("jina-8k");
		expect((provider as any).batchSize).toBe(1);
		expect((provider as any).concurrency).toBe(1);
		expect((provider as any).numCtx).toBe(512);
		expect(provider.getDimension()).toBe(768);
	});

	it("stores constructor options for model, batch size, concurrency, and context", () => {
		const provider = new OllamaEmbeddingProvider(
			"http://localhost:11434/",
			"custom-model",
			4,
			3,
			4096,
		);

		expect((provider as any).baseUrl).toBe("http://localhost:11434");
		expect((provider as any).model).toBe("custom-model");
		expect((provider as any).batchSize).toBe(4);
		expect((provider as any).concurrency).toBe(3);
		expect((provider as any).numCtx).toBe(4096);
	});

	it("embeds a single text through /api/embed", async () => {
		const emb = mockEmbedding(0.1);
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ embeddings: [emb] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const provider = new OllamaEmbeddingProvider(
			"http://localhost:11434",
			"jina-8k",
			4,
			1,
			1024,
		);
		const result = await provider.embed(["hello"]);

		expect(result).toEqual([emb]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://localhost:11434/api/embed",
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			model: "jina-8k",
			input: ["hello"],
			options: { num_ctx: 1024 },
		});
	});

	it("embeds multiple texts in batches and preserves result order", async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			return new Response(
				JSON.stringify({
					embeddings: body.input.map((_text, i) => mockEmbedding(i)),
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const provider = new OllamaEmbeddingProvider(
			"http://localhost:11434",
			"jina-8k",
			2,
			2,
		);
		const result = await provider.embed(["a", "bbbb", "cc"]);

		expect(result).toEqual([
			mockEmbedding(0),
			mockEmbedding(1),
			mockEmbedding(0),
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(
			JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).input,
		).toEqual(["a", "bbbb"]);
		expect(
			JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).input,
		).toEqual(["cc"]);
	});

	it("returns an empty result without calling fetch when embed receives no texts", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		const result = await provider.embed([]);

		expect(result).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("detects common connection errors", () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");

		expect((provider as any).isConnectionError({ code: "ECONNREFUSED" })).toBe(
			true,
		);
		expect(
			(provider as any).isConnectionError({
				message: "request timeout while connecting",
			}),
		).toBe(true);
		expect(
			(provider as any).isConnectionError({
				cause: { code: "ETIMEDOUT" },
			}),
		).toBe(true);
		expect(
			(provider as any).isConnectionError(new Error("different failure")),
		).toBe(false);
	});

	it("falls back to sequential /api/embeddings requests when /api/embed returns 404", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ embedding: mockEmbedding(1) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ embedding: mockEmbedding(3) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		const provider = new OllamaEmbeddingProvider(
			"http://localhost:11434",
			"missing-model",
			2,
			1,
			2048,
		);
		const result = await provider.embed(["first", "second"]);

		expect(result).toEqual([mockEmbedding(1), mockEmbedding(3)]);
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
			"http://localhost:11434/api/embed",
			"http://localhost:11434/api/embeddings",
			"http://localhost:11434/api/embeddings",
		]);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
			model: "missing-model",
			prompt: "first",
			options: { num_ctx: 2048 },
		});
	});

	it("creates batches using the configured batch size", () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");

		expect((provider as any).createBatches([1, 2, 3, 4, 5], 2)).toEqual([
			[1, 2],
			[3, 4],
			[5],
		]);
	});

	it("creates no batches for an empty array", () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");

		expect((provider as any).createBatches([], 3)).toEqual([]);
	});

	it("detects not found errors from both responses and plain objects", () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");

		expect(
			(provider as any).isNotFoundError(new Response(null, { status: 404 })),
		).toBe(true);
		expect((provider as any).isNotFoundError({ status: 404 })).toBe(true);
		expect((provider as any).isNotFoundError({ status: 500 })).toBe(false);
		expect((provider as any).isNotFoundError("404")).toBe(false);
	});

	it("retries embedBatch after a connection error once Ollama becomes available", async () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		const performEmbedRequest = vi
			.spyOn(provider as any, "performEmbedRequest")
			.mockRejectedValueOnce({ code: "ECONNREFUSED" })
			.mockResolvedValueOnce([mockEmbedding(1)]);
		const ensureOllamaAvailable = vi
			.spyOn(provider as any, "ensureOllamaAvailable")
			.mockResolvedValue(undefined);

		const result = await (provider as any).embedBatch(["retry me"]);

		expect(result).toEqual([mockEmbedding(1)]);
		expect(ensureOllamaAvailable).toHaveBeenCalledWith("embedBatch");
		expect(performEmbedRequest).toHaveBeenCalledTimes(2);
	});

	it("pulls the model and retries embedBatch when a not found error is raised", async () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		const performEmbedRequest = vi
			.spyOn(provider as any, "performEmbedRequest")
			.mockRejectedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce([mockEmbedding(4)]);
		const pullModel = vi
			.spyOn(provider as any, "pullModel")
			.mockResolvedValue(undefined);

		const result = await (provider as any).embedBatch(["missing model"]);

		expect(result).toEqual([mockEmbedding(4)]);
		expect(pullModel).toHaveBeenCalledTimes(1);
		expect(performEmbedRequest).toHaveBeenCalledTimes(2);
	});

	it("wraps unexpected embedBatch failures with an Ollama-specific message", async () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		vi.spyOn(provider as any, "performEmbedRequest").mockRejectedValueOnce(
			new Error("boom"),
		);

		await expect((provider as any).embedBatch(["fail"])).rejects.toThrow(
			"Ollama embedding failed: boom",
		);
	});

	it("falls back to sequential embedding when embed requests reject with a 404-shaped error", async () => {
		const fetchWithTimeout = vi
			.fn()
			.mockRejectedValueOnce({ status: 404 })
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ embedding: mockEmbedding(10) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ embedding: mockEmbedding(20) }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		vi.spyOn(provider as any, "fetchWithTimeout").mockImplementation(
			fetchWithTimeout,
		);

		const result = await (provider as any).performEmbedRequest([
			"first",
			"second",
		]);

		expect(result).toEqual([mockEmbedding(10), mockEmbedding(20)]);
		expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
	});

	it("throws when the fallback sequential endpoint returns a non-ok response", async () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		vi.spyOn(provider as any, "fetchWithTimeout").mockResolvedValueOnce(
			new Response(null, { status: 500 }),
		);

		await expect(
			(provider as any).fallbackSequentialEmbed(["bad fallback"]),
		).rejects.toThrow("Ollama responded with status 500 (fallback)");
	});

	it("throws when the fallback sequential endpoint returns a payload without embedding", async () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		vi.spyOn(provider as any, "fetchWithTimeout").mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(
			(provider as any).fallbackSequentialEmbed(["bad payload"]),
		).rejects.toThrow("Invalid response from Ollama (fallback)");
	});

	it("throws when /api/embed returns a successful response without embeddings", async () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		vi.spyOn(provider as any, "fetchWithTimeout").mockResolvedValueOnce(
			new Response(JSON.stringify({ nope: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(
			(provider as any).performEmbedRequest(["invalid"]),
		).rejects.toThrow("Invalid response from Ollama");
	});

	it("pulls the configured model via /api/pull", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ status: "success" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const provider = new OllamaEmbeddingProvider(
			"http://localhost:11434",
			"pull-me",
		);
		await (provider as any).pullModel();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://localhost:11434/api/pull",
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			name: "pull-me",
			stream: false,
		});
	});

	it("wraps pullModel failures with the model name", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
		vi.stubGlobal("fetch", fetchMock);

		const provider = new OllamaEmbeddingProvider(
			"http://localhost:11434",
			"pull-me",
		);

		await expect((provider as any).pullModel()).rejects.toThrow(
			"Failed to pull model pull-me: network down",
		);
	});

	it("reports Ollama as running only when the version endpoint returns 200", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockRejectedValueOnce(new Error("offline"));
		vi.stubGlobal("fetch", fetchMock);

		const provider = new OllamaEmbeddingProvider("http://localhost:11434");

		await expect((provider as any).checkOllamaRunning()).resolves.toBe(true);
		await expect((provider as any).checkOllamaRunning()).resolves.toBe(false);
		await expect((provider as any).checkOllamaRunning()).resolves.toBe(false);
	});

	it("waits for Ollama readiness across retry attempts and then succeeds", async () => {
		vi.useFakeTimers();
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		const checkOllamaRunning = vi
			.spyOn(provider as any, "checkOllamaRunning")
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);

		const pending = (provider as any).waitForOllama(5, 20);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(20);
		await vi.advanceTimersByTimeAsync(20);

		await expect(pending).resolves.toBeUndefined();
		expect(checkOllamaRunning).toHaveBeenCalledTimes(3);
	});

	it("throws when Ollama never becomes ready within the retry window", async () => {
		vi.useFakeTimers();
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		const checkOllamaRunning = vi
			.spyOn(provider as any, "checkOllamaRunning")
			.mockResolvedValue(false);

		const pending = (provider as any).waitForOllama(3, 10);
		const rejection = expect(pending).rejects.toThrow(
			"Ollama did not become ready at http://localhost:11434 within 30ms",
		);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(30);

		await rejection;
		expect(checkOllamaRunning).toHaveBeenCalledTimes(3);
	});

	it("returns early from ensureOllamaAvailable when Ollama is already running", async () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		const checkOllamaRunning = vi
			.spyOn(provider as any, "checkOllamaRunning")
			.mockResolvedValue(true);
		const startOllama = vi.spyOn(provider as any, "startOllama");
		const waitForOllama = vi.spyOn(provider as any, "waitForOllama");

		await (provider as any).ensureOllamaAvailable("initialize");

		expect(checkOllamaRunning).toHaveBeenCalledTimes(1);
		expect(startOllama).not.toHaveBeenCalled();
		expect(waitForOllama).not.toHaveBeenCalled();
	});

	it("reuses the same reconnect promise for concurrent ensureOllamaAvailable calls", async () => {
		let resolveWait: (() => void) | undefined;
		const waitPromise = new Promise<void>((resolve) => {
			resolveWait = resolve;
		});

		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		vi.spyOn(provider as any, "checkOllamaRunning").mockResolvedValue(false);
		const startOllama = vi
			.spyOn(provider as any, "startOllama")
			.mockImplementation(() => undefined);
		const waitForOllama = vi
			.spyOn(provider as any, "waitForOllama")
			.mockImplementation(() => waitPromise);

		const first = (provider as any).ensureOllamaAvailable("embedBatch");
		const second = (provider as any).ensureOllamaAvailable("initialize");
		await Promise.resolve();

		expect(startOllama).toHaveBeenCalledTimes(1);
		expect(waitForOllama).toHaveBeenCalledTimes(1);
		expect((provider as any).reconnectInFlight).toBeTruthy();

		resolveWait?.();
		await Promise.all([first, second]);

		expect((provider as any).reconnectInFlight).toBeNull();
	});

	it("starts Ollama in the background when the spawn command succeeds", () => {
		vi.resetModules();
		const execSyncMock = vi.fn().mockReturnValue(Buffer.from(""));
		vi.doMock("node:child_process", async (importOriginal) => {
			const actual =
				await importOriginal<typeof import("node:child_process")>();
			return { ...actual, execSync: execSyncMock };
		});

		return import("../../../src/embedding/ollama.js").then(
			({ OllamaEmbeddingProvider }) => {
				const provider = new OllamaEmbeddingProvider("http://localhost:11434");

				expect(() => (provider as any).startOllama()).not.toThrow();
				expect(execSyncMock).toHaveBeenCalledWith(
					"ollama serve > /dev/null 2>&1 &",
					{
						stdio: "pipe",
						timeout: 3000,
					},
				);

				vi.doUnmock("node:child_process");
				vi.resetModules();
			},
		);
	});

	it("initialize delegates to ensureOllamaAvailable", async () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		const ensureOllamaAvailable = vi
			.spyOn(provider as any, "ensureOllamaAvailable")
			.mockResolvedValue(undefined);

		await provider.initialize();

		expect(ensureOllamaAvailable).toHaveBeenCalledWith("initialize");
	});

	it("close resolves without side effects", async () => {
		const provider = new OllamaEmbeddingProvider("http://localhost:11434");

		await expect(provider.close()).resolves.toBeUndefined();
	});

	it("aborts fetchWithTimeout when the timeout expires", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new Error("aborted"));
					});
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const provider = new OllamaEmbeddingProvider("http://localhost:11434");
		const pending = (provider as any).fetchWithTimeout(
			"http://localhost:11434/api/embed",
			{ method: "POST" },
			25,
		);
		pending.catch(() => undefined);

		await vi.advanceTimersByTimeAsync(25);

		await expect(pending).rejects.toThrow("aborted");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});
});
