import type { EmbeddingProvider } from '../core/types.js';
import { SystemLogger } from '../core/logger.js';
import axios from 'axios';

const logger = new SystemLogger('embeddings-ollama');

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  public readonly id = 'ollama';
  public readonly dimension = 768;

  private baseUrl: string;
  private model: string;
  private batchSize: number;
  private concurrency: number;
  private numCtx: number;
  private reconnectInFlight: Promise<void> | null = null;
  private readonly requestTimeoutMs = 15_000;

  constructor(baseUrl: string, model = 'jina-8k', batchSize = 1, concurrency = 1, numCtx = 512) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.batchSize = batchSize;
    this.concurrency = concurrency;
    this.numCtx = numCtx;
  }

  async initialize(): Promise<void> {
    await this.ensureOllamaAvailable('initialize');
  }

  async close(): Promise<void> {}

  getDimension(): number {
    return this.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const startTime = Date.now();
    const batches = this.createBatches(texts, this.batchSize);
    const results: number[][] = new Array(texts.length);

    const batchesWithIndices = batches.map((batch, index) => ({
      batch,
      startIdx: index * this.batchSize,
    }));

    const queue = [...batchesWithIndices];
    const workers = Array(Math.min(this.concurrency, batches.length))
      .fill(null)
      .map(async () => {
        while (queue.length > 0) {
          const current = queue.shift();
          if (!current) break;

          const { batch, startIdx } = current;

          const embeddings = await this.embedBatch(batch);
          embeddings.forEach((embedding, i) => {
            results[startIdx + i] = embedding;
          });
        }
      });

    await Promise.all(workers);

    void startTime;
    return results;
  }

  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      return await this.performEmbedRequest(texts);
    } catch (error: unknown) {
      if (this.isConnectionError(error)) {
        logger.warn('Ollama connection failed. Waiting for service readiness...');
        await this.ensureOllamaAvailable('embedBatch');
        return await this.performEmbedRequest(texts);
      }

      if (this.isNotFoundError(error)) {
        logger.info(`Model ${this.model} not found. Pulling...`);
        await this.pullModel();
        return await this.performEmbedRequest(texts);
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Ollama embedding failed: ${message}`);
    }
  }

  private isConnectionError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const code = (error as { code?: string }).code;
    const messageValue = (error as { message?: unknown }).message;
    const message = typeof messageValue === 'string' ? messageValue : '';

    if (
      code &&
      ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ECONNABORTED'].includes(code)
    ) {
      return true;
    }

    return (
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ECONNRESET') ||
      message.includes('EHOSTUNREACH') ||
      message.toLowerCase().includes('timeout')
    );
  }

  private isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const response = (error as { response?: { status?: unknown } }).response;
    return response?.status === 404;
  }

  private async performEmbedRequest(texts: string[]): Promise<number[][]> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/api/embed`,
        {
          model: this.model,
          input: texts,
          options: {
            num_ctx: this.numCtx,
          },
        },
        {
          timeout: this.requestTimeoutMs,
        }
      );

      if (response.data?.embeddings) {
        return response.data.embeddings;
      }
    } catch (error: unknown) {
      if (this.isNotFoundError(error)) {
        return await this.fallbackSequentialEmbed(texts);
      }
      throw error;
    }

    throw new Error('Invalid response from Ollama');
  }

  private async fallbackSequentialEmbed(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (const text of texts) {
      const response = await axios.post(
        `${this.baseUrl}/api/embeddings`,
        {
          model: this.model,
          prompt: text,
          options: {
            num_ctx: this.numCtx,
          },
        },
        {
          timeout: this.requestTimeoutMs,
        }
      );

      if (response.data?.embedding) {
        embeddings.push(response.data.embedding);
      } else {
        throw new Error('Invalid response from Ollama (fallback)');
      }
    }

    return embeddings;
  }

  private async pullModel(): Promise<void> {
    try {
      await axios.post(`${this.baseUrl}/api/pull`, {
        name: this.model,
        stream: false,
      });
      logger.info(`Model ${this.model} pulled successfully.`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to pull model ${this.model}: ${message}`);
    }
  }

  private async checkOllamaRunning(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/version`, {
        timeout: 2000,
      });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  private async waitForOllama(maxAttempts = 60, delayMs = 500): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      if (await this.checkOllamaRunning()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error(
      `Ollama did not become ready at ${this.baseUrl} within ${maxAttempts * delayMs}ms`
    );
  }

  private async ensureOllamaAvailable(context: string): Promise<void> {
    if (await this.checkOllamaRunning()) {
      return;
    }

    if (!this.reconnectInFlight) {
      this.reconnectInFlight = (async () => {
        logger.warn(`Ollama is unavailable during ${context}. Waiting for readiness...`);
        await this.waitForOllama();
      })();
    }

    try {
      await this.reconnectInFlight;
    } finally {
      this.reconnectInFlight = null;
    }
  }
}
