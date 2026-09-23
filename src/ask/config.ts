import fs from "node:fs";
import os from "node:os";
import { parseEnv as utilParseEnv } from "node:util";
import { askConfigPath } from "./setup-config.js";
import type { AskModelLimits } from "./request-budget.js";

export interface AskConfig extends AskModelLimits {
	backend: "openai" | "pi";
	apiKey?: string;
	baseUrl?: string;
	model?: string;
	piProvider?: string;
	piModel?: string;
	piAgentDir?: string;
	retries: number;
	fallback?: AskBackendConfig;
}

export interface AskBackendConfig extends AskModelLimits {
	backend: "openai" | "pi";
	model: string;
	apiKey?: string;
	baseUrl?: string;
	piProvider?: string;
	piAgentDir?: string;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const KEYS = {
	OPENAI_API_KEY: "apiKey",
	OPENAI_BASE_URL: "baseUrl",
	IDX_ASK_MODEL: "model",
	IDX_PI_PROVIDER: "piProvider",
	IDX_PI_MODEL: "piModel",
	PI_CODING_AGENT_DIR: "piAgentDir",
} as const;

export function loadAskConfig(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): AskConfig {
	const filePath = askConfigPath(env, home);
	let fileValues: NodeJS.ProcessEnv = {};
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) throw new Error("Invalid ask configuration file");
		if (stat.size > MAX_CONFIG_BYTES) throw new Error("Ask configuration file too large");
		const content = fs.readFileSync(filePath, "utf8");
		if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) throw new Error("Ask configuration file too large");
		fileValues = parseEnv(content);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return configFrom({}, env);
		if (error instanceof Error && ["Invalid ask configuration file", "Ask configuration file too large", "Invalid ask configuration file format"].includes(error.message)) throw error;
		throw new Error("Unable to read ask configuration file");
	}
	return configFrom(fileValues, env);
}

function parseEnv(source: string): NodeJS.ProcessEnv {
	try {
		return utilParseEnv(source);
	} catch {
		throw new Error("Invalid ask configuration file format");
	}
}

function configFrom(file: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): AskConfig {
	const get = (key: string): string | undefined => env[key] !== undefined ? env[key] : file[key];
	const rawBackend = get("IDX_ASK_BACKEND");
	if (rawBackend !== undefined && rawBackend !== "openai" && rawBackend !== "pi") throw new Error("Invalid IDX_ASK_BACKEND (expected openai or pi)");
	const result: AskConfig = { backend: rawBackend ?? "openai", retries: 2 };
	for (const [key, property] of Object.entries(KEYS)) {
		const value = get(key);
		if (value !== undefined) result[property] = value;
	}
	const rawRetries = get("IDX_ASK_RETRIES");
	if (rawRetries !== undefined) {
		if (!/^(0|[1-5])$/.test(rawRetries)) throw new Error("Invalid IDX_ASK_RETRIES (expected integer 0 through 5)");
		result.retries = Number(rawRetries);
	}
	Object.assign(result, modelLimits(get, "IDX_ASK_"));
	const fallbackModel = get("IDX_ASK_FALLBACK_MODEL");
	if (fallbackModel !== undefined && fallbackModel !== "") {
		const rawFallbackBackend = get("IDX_ASK_FALLBACK_BACKEND");
		const fallbackBackend = rawFallbackBackend ?? result.backend;
		if (fallbackBackend !== "openai" && fallbackBackend !== "pi") throw new Error("Invalid IDX_ASK_FALLBACK_BACKEND (expected openai or pi)");
		const fallback: AskBackendConfig = { backend: fallbackBackend, model: fallbackModel, ...modelLimits(get, "IDX_ASK_FALLBACK_") };
		if (fallbackBackend === "pi") {
			fallback.piProvider = get("IDX_ASK_FALLBACK_PROVIDER") ?? (fallbackBackend === result.backend ? result.piProvider : undefined);
			fallback.piAgentDir = result.piAgentDir;
			if (!fallback.piProvider) throw new Error("IDX_ASK_FALLBACK_PROVIDER is required for Pi fallback");
		} else {
			fallback.apiKey = get("IDX_ASK_FALLBACK_API_KEY") ?? result.apiKey;
			fallback.baseUrl = get("IDX_ASK_FALLBACK_BASE_URL") ?? result.baseUrl;
		}
		result.fallback = fallback;
	} else if (["IDX_ASK_FALLBACK_BACKEND", "IDX_ASK_FALLBACK_PROVIDER", "IDX_ASK_FALLBACK_API_KEY", "IDX_ASK_FALLBACK_BASE_URL", "IDX_ASK_FALLBACK_CONTEXT_TOKENS", "IDX_ASK_FALLBACK_MAX_OUTPUT_TOKENS"].some((key) => get(key) !== undefined)) {
		throw new Error("IDX_ASK_FALLBACK_MODEL is required to configure fallback settings");
	}
	return result;
}

function modelLimits(get: (key: string) => string | undefined, prefix: string): AskModelLimits {
	const limits: AskModelLimits = {};
	for (const [key, property, min, max] of [
		["CONTEXT_TOKENS", "contextTokens", 2048, 2_000_000],
		["MAX_OUTPUT_TOKENS", "maxOutputTokens", 1, 200_000],
	] as const) {
		const value = get(prefix + key);
		if (value === undefined) continue;
		const parsed = Number(value);
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
			throw new Error(`Invalid ${prefix}${key} (expected integer ${min} through ${max})`);
		}
		limits[property] = parsed;
	}
	return limits;
}
