import {
	accessSync,
	chmodSync,
	constants as fsConstants,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT_CONTENT =
	'#!/bin/sh\nexec npm_config_loglevel=silent npx -y indexer-cli@latest "$@"\n';

/**
 * Ensure ~/.local/bin/idx exists and is executable.
 * Adds ~/.local/bin to PATH via shell profile if missing.
 *
 * Safe to call repeatedly — skips work when already installed.
 */
export function ensureIdxBinary(): void {
	const homeDir = os.homedir();
	const localBinDir = path.join(homeDir, ".local", "bin");
	const scriptPath = path.join(localBinDir, "idx");

	try {
		accessSync(scriptPath, fsConstants.F_OK);
		const existing = readFileSync(scriptPath, "utf8");
		if (existing === SCRIPT_CONTENT) {
			return;
		}
	} catch {
		// not installed
	}

	mkdirSync(localBinDir, { recursive: true });
	writeFileSync(scriptPath, SCRIPT_CONTENT, "utf8");
	chmodSync(scriptPath, 0o755);

	const pathEntries = (process.env.PATH ?? "").split(":");
	if (pathEntries.includes(localBinDir)) {
		return;
	}

	const candidates =
		os.platform() === "darwin"
			? [path.join(homeDir, ".zshrc"), path.join(homeDir, ".bashrc")]
			: [path.join(homeDir, ".bashrc"), path.join(homeDir, ".zshrc")];

	let profile = candidates[0];
	for (const candidate of candidates) {
		try {
			accessSync(candidate, fsConstants.F_OK);
			profile = candidate;
			break;
		} catch {
			// skip missing profile
		}
	}

	const exportLine = 'export PATH="$HOME/.local/bin:$PATH"';
	const existing = (() => {
		try {
			return readFileSync(profile, "utf8");
		} catch {
			return "";
		}
	})();

	if (!existing.includes(exportLine)) {
		const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
		writeFileSync(profile, `${existing}${prefix}${exportLine}\n`, "utf8");
	}
}
