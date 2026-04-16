import { execFileSync } from "node:child_process";
import {
	readFileSync,
	existsSync,
	writeFileSync,
	mkdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { PACKAGE_VERSION } from "./version.js";

const CACHE_FILE = join(homedir(), ".indexer-cli", ".update-check.json");
const CACHE_DIR = join(homedir(), ".indexer-cli");
const UPDATE_LOCK_DIR = join(CACHE_DIR, ".update-lock");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STALE_LOCK_MS = 5 * 60 * 1000;

export const AUTO_UPDATE_RESTART_CODE = 42 as const;

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
	if (!existsSync(CACHE_DIR)) {
		mkdirSync(CACHE_DIR, { recursive: true });
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

export function shouldSkipAutoUpdate(): boolean {
	if (process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED === "1") return true;
	if (detectInstallMethod() !== "npm-global") return true;
	if (!process.stdout.isTTY) return true;
	if (process.env.CI === "true" || process.env.CI === "1") return true;
	if (process.argv.includes("--no-auto-update")) return true;
	return false;
}

function readInstalledPackageVersion(): string {
	// After `npm install -g`, the files on disk are replaced but require.resolve
	// may still point at the cached (old) module location. Use process.argv[1]
	// (the bin path) to locate the newly installed package.json instead.
	const execPath = process.argv[1];
	if (!execPath) {
		throw new Error("Cannot determine install location");
	}
	const binDir = dirname(execPath);
	const packageJsonPath = join(
		binDir,
		"..",
		"lib",
		"node_modules",
		"indexer-cli",
		"package.json",
	);
	if (!existsSync(packageJsonPath)) {
		throw new Error("Cannot locate installed package.json");
	}
	const data = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
		version?: string;
	};
	if (!data.version) {
		throw new Error("Installed package version could not be determined");
	}
	return data.version;
}

function releaseUpdateLock(lockHeld: boolean): void {
	if (!lockHeld) return;
	rmSync(UPDATE_LOCK_DIR, { recursive: true, force: true });
}

export async function performAutoUpdate(): Promise<void> {
	if (shouldSkipAutoUpdate()) return;

	let lockHeld = false;

	try {
		const now = Date.now();
		const cache = readCache();

		if (cache && !isNewerVersion(PACKAGE_VERSION, cache.latestVersion)) {
			return;
		}

		let latest = cache?.latestVersion;
		if (!cache || now - cache.lastChecked >= CHECK_INTERVAL_MS) {
			latest = await fetchLatestVersion();
			writeCache({ lastChecked: now, latestVersion: latest });
		}

		if (!latest || !isNewerVersion(PACKAGE_VERSION, latest)) {
			return;
		}

		if (!existsSync(CACHE_DIR)) {
			mkdirSync(CACHE_DIR, { recursive: true });
		}

		if (existsSync(UPDATE_LOCK_DIR)) {
			const lockStat = statSync(UPDATE_LOCK_DIR);
			if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
				rmSync(UPDATE_LOCK_DIR, { recursive: true, force: true });
			}
		}

		try {
			mkdirSync(UPDATE_LOCK_DIR, { recursive: false });
			lockHeld = true;
		} catch {
			return;
		}

		writeFileSync(
			join(UPDATE_LOCK_DIR, "owner.json"),
			JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
		);

		console.log(`Updating indexer-cli ${PACKAGE_VERSION} → ${latest}...`);
		execFileSync("npm", ["install", "-g", "indexer-cli@latest"], {
			stdio: "inherit",
		});

		const installedVersion = readInstalledPackageVersion();
		if (installedVersion === PACKAGE_VERSION) {
			console.error(
				"Auto-update warning: indexer-cli version did not change after install.",
			);
			releaseUpdateLock(lockHeld);
			lockHeld = false;
			return;
		}

		releaseUpdateLock(lockHeld);
		lockHeld = false;
		console.log("Restarting with updated version...");
		process.exit(AUTO_UPDATE_RESTART_CODE);
	} catch {
		console.error(
			"Auto-update warning: failed to update indexer-cli automatically.",
		);
		releaseUpdateLock(lockHeld);
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
