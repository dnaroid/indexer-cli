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

interface UpdateCache {
	lastChecked: number;
	latestVersion: string;
}

export type SkipAutoUpdateReason =
	| "unsupported-install-method"
	| "non-tty"
	| "ci"
	| "flag-disabled"
	| "update-lock-held"
	| null;

export type AutoUpdateResult =
	| { kind: "skipped"; reason: Exclude<SkipAutoUpdateReason, null> }
	| { kind: "no-update" }
	| {
			kind: "updated";
			previousVersion: string;
			installedVersion: string;
	  }
	| { kind: "failed"; message: string };

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
	for (let i = 0; i < 3; i++) {
		if (l[i] > c[i]) return true;
		if (l[i] < c[i]) return false;
	}
	return false;
}

export type InstallMethod =
	| "npx"
	| "npm-global"
	| "pnpm-global"
	| "yarn-global"
	| "unknown";

function tryGetNpmGlobalPrefix(): string | null {
	try {
		const prefix = execFileSync("npm", ["config", "get", "prefix"], {
			encoding: "utf8",
		}).trim();
		if (prefix) return prefix;
		return null;
	} catch {
		return null;
	}
}

function tryGetNpmGlobalRoot(): string | null {
	try {
		const root = execFileSync("npm", ["root", "-g"], {
			encoding: "utf8",
		}).trim();
		if (root) return root;
		return null;
	} catch {
		return null;
	}
}

export function detectInstallMethod(): InstallMethod {
	try {
		const execPath = process.argv[1];
		if (!execPath) return "unknown";
		const resolved = execPath;
		if (resolved.includes("/.npm/_npx")) return "npx";
		if (resolved.includes("/.pnpm/global")) return "pnpm-global";
		if (resolved.includes("/.yarn/global")) return "yarn-global";

		const npmPrefix = tryGetNpmGlobalPrefix();
		if (npmPrefix) {
			const expectedBinPath = join(npmPrefix, "bin");
			if (resolved.startsWith(expectedBinPath)) return "npm-global";
			return "unknown";
		}

		return "unknown";
	} catch {
		return "unknown";
	}
}

export function getAutoUpdateSkipReason(): SkipAutoUpdateReason {
	if (detectInstallMethod() !== "npm-global")
		return "unsupported-install-method";
	if (!process.stdout.isTTY) return "non-tty";
	if (process.env.CI === "true" || process.env.CI === "1") return "ci";
	if (process.argv.includes("--no-auto-update")) return "flag-disabled";
	return null;
}

export function shouldSkipAutoUpdate(): boolean {
	return getAutoUpdateSkipReason() !== null;
}

function readInstalledPackageVersion(): string {
	const npmRoot = tryGetNpmGlobalRoot();
	if (npmRoot) {
		const candidate = join(npmRoot, "indexer-cli", "package.json");
		if (existsSync(candidate)) {
			const data = JSON.parse(readFileSync(candidate, "utf-8")) as {
				version?: string;
			};
			if (data.version) return data.version;
		}
	}

	const execPath = process.argv[1];
	if (execPath) {
		const binDir = dirname(execPath);
		const legacyCandidate = join(
			binDir,
			"..",
			"lib",
			"node_modules",
			"indexer-cli",
			"package.json",
		);
		if (existsSync(legacyCandidate)) {
			const data = JSON.parse(readFileSync(legacyCandidate, "utf-8")) as {
				version?: string;
			};
			if (data.version) return data.version;
		}
	}

	throw new Error("Cannot locate installed package.json");
}

function releaseUpdateLock(lockHeld: boolean): void {
	if (!lockHeld) return;
	rmSync(UPDATE_LOCK_DIR, { recursive: true, force: true });
}

export async function performAutoUpdateAfterCommand(): Promise<AutoUpdateResult> {
	const skipReason = getAutoUpdateSkipReason();
	if (skipReason !== null) {
		return { kind: "skipped", reason: skipReason };
	}

	let lockHeld = false;

	try {
		const now = Date.now();
		const cache = readCache();

		if (cache && !isNewerVersion(PACKAGE_VERSION, cache.latestVersion)) {
			return { kind: "no-update" };
		}

		let latest = cache?.latestVersion;
		if (!cache || now - cache.lastChecked >= CHECK_INTERVAL_MS) {
			latest = await fetchLatestVersion();
			writeCache({ lastChecked: now, latestVersion: latest });
		}

		if (!latest || !isNewerVersion(PACKAGE_VERSION, latest)) {
			return { kind: "no-update" };
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
			return { kind: "skipped", reason: "update-lock-held" };
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
			const message =
				"Auto-update warning: indexer-cli version did not change after install.";
			console.error(message);
			releaseUpdateLock(lockHeld);
			lockHeld = false;
			return { kind: "failed", message };
		}

		releaseUpdateLock(lockHeld);
		lockHeld = false;
		console.log(
			`Updated indexer-cli ${PACKAGE_VERSION} → ${installedVersion}.`,
		);
		console.log("The new version will be used on the next run.");
		return {
			kind: "updated",
			previousVersion: PACKAGE_VERSION,
			installedVersion,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`Auto-update warning: failed to update indexer-cli automatically: ${message}`,
		);
		releaseUpdateLock(lockHeld);
		return { kind: "failed", message };
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
