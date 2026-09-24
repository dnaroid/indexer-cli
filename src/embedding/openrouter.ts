import type { EmbeddingProvider } from "../core/types.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 4;

type OpenRouterEmbeddingItem = {
	index?: number;
	embedding?: unknown;
};

type OpenRouterEmbeddingResponse = {
	data?: OpenRouterEmbeddingItem[];
	error?: { message?: unknown };
};

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
	public readonly id = "openrouter";

	constructor(
		private readonly apiKey: string | undefined,
		private readonly model: string,
		public readonly dimension: number,
		private readonly batchSize = DEFAULT_BATCH_SIZE,
		private readonly concurrency = DEFAULT_CONCURRENCY,
		private readonly baseUrl = DEFAULT_BASE_URL,
	) {}

	async initialize(): Promise<void> {
		this.requireApiKey();
	}

	async close(): Promise<void> {}

	getDimension(): number {
		return this.dimension;
	}

	async embed(texts: string[]): Promise<number[][]> {
		this.requireApiKey();
		if (texts.length === 0) return [];

		const batches = this.createBatches(texts);
		const results: number[][] = new Array(texts.length);
		const queue = [...batches];
		const workers = Array.from(
			{ length: Math.min(Math.max(1, this.concurrency), queue.length) },
			async () => {
				while (queue.length > 0) {
					const item = queue.shift();
					if (!item) return;
					const embeddings = await this.embedBatchWithRetry(item.texts);
					for (let i = 0; i < embeddings.length; i += 1) {
						results[item.startIndex + i] = embeddings[i];
					}
				}
			},
		);
		await Promise.all(workers);
		return results;
	}

	private requireApiKey(): string {
		const key = this.apiKey?.trim();
		if (!key) {
			throw new Error(
				"OpenRouter embeddings require OPENROUTER_API_KEY in the environment or ~/.config/idx/.env.",
			);
		}
		return key;
	}

	private createBatches(texts: string[]): Array<{ startIndex: number; texts: string[] }> {
		const size = Math.max(1, this.batchSize);
		const batches: Array<{ startIndex: number; texts: string[] }> = [];
		for (let startIndex = 0; startIndex < texts.length; startIndex += size) {
			batches.push({ startIndex, texts: texts.slice(startIndex, startIndex + size) });
		}
		return batches;
	}

	private async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt += 1) {
			try {
				return await this.embedBatch(texts);
			} catch (error) {
				lastError = error;
				if (!this.isRetryable(error) || attempt === DEFAULT_MAX_ATTEMPTS) break;
				await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
			}
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}

	private async embedBatch(texts: string[]): Promise<number[][]> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		try {
			const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.requireApiKey()}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ model: this.model, input: texts }),
				signal: controller.signal,
			});
			const body = (await response.json().catch(() => ({}))) as OpenRouterEmbeddingResponse;
			if (!response.ok) {
				const detail = typeof body.error?.message === "string"
					? `: ${body.error.message}`
					: "";
				const error = new Error(`OpenRouter embedding request failed (${response.status})${detail}`) as Error & { status?: number };
				error.status = response.status;
				throw error;
			}

			const items = Array.isArray(body.data)
				? [...body.data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
				: [];
			if (items.length !== texts.length) {
				throw new Error(
					`OpenRouter returned ${items.length} embeddings for ${texts.length} inputs.`,
				);
			}
			return items.map((item, index) => this.validateEmbedding(item.embedding, index));
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`OpenRouter embedding request timed out after ${DEFAULT_TIMEOUT_MS}ms.`);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private validateEmbedding(value: unknown, index: number): number[] {
		if (
			!Array.isArray(value) ||
			value.length !== this.dimension ||
			value.some((item) => typeof item !== "number" || !Number.isFinite(item))
		) {
			throw new Error(
				`OpenRouter returned an invalid embedding at index ${index}; expected ${this.dimension} finite numbers.`,
			);
		}
		return value as number[];
	}

	private isRetryable(error: unknown): boolean {
		if (error instanceof TypeError) return true;
		if (error instanceof Error && error.message.toLowerCase().includes("timed out")) {
			return true;
		}
		if (!error || typeof error !== "object") return false;
		const status = Reflect.get(error, "status");
		return typeof status === "number" && (status === 408 || status === 409 || status === 429 || status >= 500);
	}
}
