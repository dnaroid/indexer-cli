import fs from "node:fs";
import os from "node:os";
import { parseEnv as utilParseEnv } from "node:util";
import { globalConfigPath } from "../core/global-config.js";

export interface DocumentClassifierConfig {
	apiKey?: string;
	model: string;
	url: string;
	timeoutMs: number;
	kindMinConfidence: number;
	statusMinConfidence: number;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const DEFAULT_MODEL = "~typesafe/jev-latest";
const DEFAULT_URL = "https://openrouter.ai/api/alpha/decisions";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_KIND_MIN_CONFIDENCE = 0.90;
const DEFAULT_STATUS_MIN_CONFIDENCE = 0.65;

function confidence(value: string | undefined, name: string, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`Invalid ${name} (expected number 0 through 1)`);
	return parsed;
}

export function loadDocumentClassifierConfig(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): DocumentClassifierConfig {
	const filePath = globalConfigPath(env, home);
	let fileValues: NodeJS.ProcessEnv = {};
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) throw new Error("Invalid idx configuration file");
		if (stat.size > MAX_CONFIG_BYTES) throw new Error("Idx configuration file too large");
		const content = fs.readFileSync(filePath, "utf8");
		if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) throw new Error("Idx configuration file too large");
		try { fileValues = utilParseEnv(content); }
		catch { throw new Error("Invalid idx configuration file format"); }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const get = (key: string): string | undefined => env[key] !== undefined ? env[key] : fileValues[key];
	const rawTimeout = get("IDX_JEV_TIMEOUT_MS");
	if (rawTimeout !== undefined && (!/^\d+$/.test(rawTimeout) || Number(rawTimeout) < 100 || Number(rawTimeout) > 60_000)) {
		throw new Error("Invalid IDX_JEV_TIMEOUT_MS (expected integer 100 through 60000)");
	}
	return {
		apiKey: get("OPENROUTER_API_KEY")?.trim() || undefined,
		model: get("IDX_JEV_MODEL")?.trim() || DEFAULT_MODEL,
		url: get("IDX_JEV_URL")?.trim() || DEFAULT_URL,
		timeoutMs: rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout),
		kindMinConfidence: confidence(get("IDX_JEV_KIND_MIN_CONFIDENCE"), "IDX_JEV_KIND_MIN_CONFIDENCE", DEFAULT_KIND_MIN_CONFIDENCE),
		statusMinConfidence: confidence(get("IDX_JEV_STATUS_MIN_CONFIDENCE"), "IDX_JEV_STATUS_MIN_CONFIDENCE", DEFAULT_STATUS_MIN_CONFIDENCE),
	};
}
