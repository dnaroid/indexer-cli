import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AskModel, AskTurn } from "./model.js";
import { fitAskRequest, type AskModelLimits } from "./request-budget.js";

const MAX_BYTES = 100_000;

export interface PiAskOptions {
	provider?: string;
	model?: string;
	agentDir?: string;
	timeoutMs?: number;
	limits?: AskModelLimits;
}

export function createPiAskModel(options: PiAskOptions = {}): AskModel {
	const { provider, model, agentDir } = options;
	if (!provider?.trim() || !model?.trim()) throw new Error("Configure IDX_PI_PROVIDER and IDX_PI_MODEL to use Pi ask");
	const worker = join(__dirname, existsSync(join(__dirname, "pi-worker.js")) ? "pi-worker.js" : "pi-worker.ts");
	return {
		async turn(request) {
			// Fit the transport before the child can resolve the actual Pi model limits.
			const fitted = fitAskRequest(request, { contextTokens: 240_000, maxOutputTokens: request.maxOutputTokens });
			const payload = JSON.stringify({ provider, model, request: fitted.request, limits: options.limits });
			if (Buffer.byteLength(payload) > 256_000) throw new Error("Pi request too large");
			const env = { ...process.env };
			if (agentDir !== undefined) env.PI_CODING_AGENT_DIR = agentDir;
			return new Promise((resolve, reject) => {
				let child: ChildProcessWithoutNullStreams;
				try {
					child = spawn(process.execPath, [...process.execArgv, worker], { env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
				} catch {
					reject(new Error("Pi request failed"));
					return;
				}
				const stdout: Buffer[] = [];
				let outBytes = 0;
				let errBytes = 0;
				let settled = false;
				const finish = (error?: Error, value?: unknown): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (error) {
						child.kill("SIGKILL");
						reject(error);
					} else {
						const turn = value as AskTurn;
						resolve({ ...turn, notices: [...fitted.notices, ...(turn.notices ?? [])] });
					}
				};
				const timer = setTimeout(() => finish(new Error("Pi request timed out")), Math.max(1, Math.min(request.timeoutMs, options.timeoutMs ?? 20_000, 20_000)));
				child.stdout.on("data", (chunk: Buffer) => {
					if (settled) return;
					outBytes += chunk.length;
					if (outBytes > MAX_BYTES) return finish(new Error("Pi response too large"));
					stdout.push(chunk);
				});
				child.stderr.on("data", (chunk: Buffer) => {
					errBytes += chunk.length;
					if (errBytes > MAX_BYTES) finish(new Error("Pi request failed"));
				});
				child.on("error", () => finish(new Error("Pi request failed")));
				child.stdin.on("error", () => finish(new Error("Pi request failed")));
				child.on("close", (code) => {
					if (settled) return;
					if (code !== 0) return finish(new Error("Pi request failed"));
					try {
						const result: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
						if (!result || typeof result !== "object") throw new Error();
						const envelope = result as { value?: AskTurn; error?: unknown; retryable?: unknown };
						if (envelope.error === "Pi request failed" && typeof envelope.retryable === "boolean") {
							const error = Object.assign(new Error("Pi request failed"), { retryable: envelope.retryable });
							return finish(error);
						}
						if (!envelope.value || typeof envelope.value.text !== "string" || !Array.isArray(envelope.value.toolCalls)) throw new Error();
						finish(undefined, envelope.value);
					} catch { finish(new Error("Invalid JSON from Pi")); }
				});
				child.stdin.end(payload);
			});
		},
	};
}
