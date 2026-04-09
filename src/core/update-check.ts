import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "../cli/version.js";

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

function showUpdateNotification(current: string, latest: string): void {
	console.error(
		`\n\u001b[33m\u26A0 Update available: ${current} \u2192 ${latest}\u001b[0m`,
	);
	console.error(`  Run: npm update -g indexer-cli\n`);
}

export async function checkForUpdates(): Promise<void> {
	const cache = readCache();
	const now = Date.now();

	if (cache && now - cache.lastChecked < CHECK_INTERVAL_MS) {
		if (isNewerVersion(VERSION, cache.latestVersion)) {
			showUpdateNotification(VERSION, cache.latestVersion);
		}
		return;
	}

	try {
		const latest = await fetchLatestVersion();
		writeCache({ lastChecked: now, latestVersion: latest });

		if (isNewerVersion(VERSION, latest)) {
			showUpdateNotification(VERSION, latest);
		}
	} catch {
		// Network error — silent fail, not critical
	}
}
