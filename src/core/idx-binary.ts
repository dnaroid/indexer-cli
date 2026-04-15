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

const SCRIPT_CONTENT = `#!/bin/sh
exec npm exec --yes --prefix "\${TMPDIR:-/tmp}" --package=indexer-cli@latest -- indexer-cli "$@"
`;

export type EnsureIdxBinaryResult = {
	scriptStatus: "unchanged" | "installed" | "repaired";
	pathUpdated: boolean;
};

/**
 * Ensure ~/.local/bin/idx exists and is executable.
 * Adds ~/.local/bin to PATH via shell profile if missing.
 *
 * Safe to call repeatedly — skips work when already installed.
 */
export function ensureIdxBinary(): EnsureIdxBinaryResult {
	const homeDir = os.homedir();
	const localBinDir = path.join(homeDir, ".local", "bin");
	const scriptPath = path.join(localBinDir, "idx");
	let scriptStatus: EnsureIdxBinaryResult["scriptStatus"] = "installed";

	try {
		accessSync(scriptPath, fsConstants.F_OK);
		const existing = readFileSync(scriptPath, "utf8");
		if (existing === SCRIPT_CONTENT) {
			try {
				accessSync(scriptPath, fsConstants.X_OK);
				scriptStatus = "unchanged";
			} catch {
				scriptStatus = "repaired";
			}
		} else {
			scriptStatus = "repaired";
		}
	} catch {
		// not installed
	}

	if (scriptStatus !== "unchanged") {
		mkdirSync(localBinDir, { recursive: true });
		writeFileSync(scriptPath, SCRIPT_CONTENT, "utf8");
		chmodSync(scriptPath, 0o755);
	}

	const pathEntries = (process.env.PATH ?? "").split(":");
	let pathUpdated = false;
	if (pathEntries.includes(localBinDir)) {
		return { scriptStatus, pathUpdated };
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
		pathUpdated = true;
	}

	return { scriptStatus, pathUpdated };
}
