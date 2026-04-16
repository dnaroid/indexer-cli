import {
	accessSync,
	chmodSync,
	constants as fsConstants,
	mkdirSync,
	realpathSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const NPX_SCRIPT_CONTENT = `#!/bin/sh
exec npm exec --yes --loglevel=silent --prefix "\${TMPDIR:-/tmp}" --package=indexer-cli@latest -- indexer-cli "$@"
`;

function thinWrapperContent(binaryPath: string): string {
	return `#!/bin/sh\nexec ${binaryPath} "$@"\n`;
}

export type EnsureIdxBinaryResult = {
	scriptStatus: "unchanged" | "installed" | "repaired";
	pathUpdated: boolean;
};

export function getNpmGlobalBinPath(): string | null {
	try {
		const prefix = execSync("npm config get prefix", {
			encoding: "utf8",
		}).trim();
		const binPath = path.join(prefix, "bin", "indexer-cli");
		const resolved = realpathSync(binPath);
		accessSync(resolved, fsConstants.F_OK | fsConstants.X_OK);
		return resolved;
	} catch {
		return null;
	}
}

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
	const globalPath = getNpmGlobalBinPath();
	const expectedContent = globalPath
		? thinWrapperContent(globalPath)
		: NPX_SCRIPT_CONTENT;
	let scriptStatus: EnsureIdxBinaryResult["scriptStatus"] = "installed";

	try {
		accessSync(scriptPath, fsConstants.F_OK);
		const existing = readFileSync(scriptPath, "utf8");
		if (existing === expectedContent) {
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
		writeFileSync(scriptPath, expectedContent, "utf8");
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

/** Install indexer-cli globally via npm. Returns true on success. */
export function installGlobal(): boolean {
	try {
		execSync("npm install -g indexer-cli@latest", {
			stdio: "pipe",
			encoding: "utf8",
		});
		return true;
	} catch {
		return false;
	}
}
