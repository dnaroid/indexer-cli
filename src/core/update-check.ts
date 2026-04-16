import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PACKAGE_VERSION } from "./version.js";

const CACHE_FILE = join(homedir(), ".indexer-cli", ".update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
	lastChecked: number;
	latestVersion: string;
}

async function fetchLatestVersion(): Promise<string> {
	const response = await fetch("https://registry.npmjs.org/indexer-cli/latest");
	const data = (await response.json()) as { version: string };
	return data.version;
}

function readCache(): UpdateCache | null {
	if (!existsSync(CACHE_FILE)) return null;
	try {
		return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
	} catch {
		return null;
	}
}

function writeCache(cache: UpdateCache): void {
	const dir = join(homedir(), ".indexer-cli");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

function isNewerVersion(current: string, latest: string): boolean {
	const c = current.split(".").map(Number);
	const l = latest.split(".").map(Number);
	return l[0] > c[0] || l[1] > c[1] || l[2] > c[2];
}

export type InstallMethod =
	| "npx"
	| "npm-global"
	| "pnpm-global"
	| "yarn-global"
	| "unknown";

export function detectInstallMethod(): InstallMethod {
	try {
		const execPath = process.argv[1];
		if (!execPath) return "unknown";
		const resolved = execPath;
		if (resolved.includes("/.npm/_npx")) return "npx";
		if (resolved.includes("/.pnpm/global")) return "pnpm-global";
		if (resolved.includes("/.yarn/global")) return "yarn-global";
		return "npm-global";
	} catch {
		return "unknown";
	}
}

function showUpdateNotification(
	current: string,
	latest: string,
	method: InstallMethod = "npm-global",
): void {
	const updateCommands: Record<InstallMethod, string> = {
		npx: "",
		"npm-global": "npm update -g indexer-cli",
		"pnpm-global": "pnpm add -g indexer-cli@latest",
		"yarn-global": "yarn global add indexer-cli",
		unknown: "npm update -g indexer-cli",
	};

	const cmd = updateCommands[method];
	console.error(
		`\n\u001b[33m\u26A0 Update available: ${current} \u2192 ${latest}\u001b[0m`,
	);
	console.error(`  Run: ${cmd}\n`);
}

export async function checkForUpdates(): Promise<void> {
	const method = detectInstallMethod();
	if (method === "npx") return;

	const cache = readCache();
	const now = Date.now();

	if (cache && now - cache.lastChecked < CHECK_INTERVAL_MS) {
		if (isNewerVersion(PACKAGE_VERSION, cache.latestVersion)) {
			showUpdateNotification(PACKAGE_VERSION, cache.latestVersion, method);
		}
		return;
	}

	try {
		const latest = await fetchLatestVersion();
		writeCache({ lastChecked: now, latestVersion: latest });

		if (isNewerVersion(PACKAGE_VERSION, latest)) {
			showUpdateNotification(PACKAGE_VERSION, latest, method);
		}
	} catch {
		// Network error — silent fail, not critical
	}
}
