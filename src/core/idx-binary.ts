import {
	accessSync,
	chmodSync,
	constants as fsConstants,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function thinWrapperContent(binaryPath: string): string {
	return `#!/bin/sh\nexec ${shellQuote(binaryPath)} "$@"\n`;
}

function repairWrapperContent(): string {
	return `#!/bin/sh
echo "idx: global indexer-cli installation was not found or is not executable." >&2
echo "Run: idx setup" >&2
echo "Or:  npm install -g indexer-cli" >&2
exit 1
`;
}

export type EnsureIdxBinaryResult = {
	scriptStatus: "unchanged" | "installed" | "repaired";
	pathUpdated: boolean;
	launchMode: "global-wrapper" | "repair-wrapper";
	targetPath: string | null;
};

export function getNpmGlobalBinPath(): string | null {
	try {
		const prefix = execSync("npm config get prefix", {
			encoding: "utf8",
		}).trim();
		const binPath = path.join(prefix, "bin", "indexer-cli");
		accessSync(binPath, fsConstants.F_OK | fsConstants.X_OK);
		// Return the symlink, not its realpath — realpath may point into an
		// ephemeral temp dir (/var/folders/…/T/) that macOS periodically cleans.
		return binPath;
	} catch {
		return null;
	}
}

/**
 * Resolve the shell profile file to write PATH exports into.
 * Prefers the profile matching $SHELL, falls back to platform defaults.
 */
function resolveProfileForPathExport(homeDir: string): string {
	const shell = process.env.SHELL ?? "";
	if (shell.includes("zsh")) {
		return path.join(homeDir, ".zshrc");
	}
	if (shell.includes("bash")) {
		return path.join(homeDir, ".bashrc");
	}

	const candidates =
		os.platform() === "darwin"
			? [path.join(homeDir, ".zshrc"), path.join(homeDir, ".bashrc")]
			: [path.join(homeDir, ".bashrc"), path.join(homeDir, ".zshrc")];

	for (const candidate of candidates) {
		try {
			accessSync(candidate, fsConstants.F_OK);
			return candidate;
		} catch {
			// skip missing profile
		}
	}

	return candidates[0];
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

	const launchMode = globalPath ? "global-wrapper" : "repair-wrapper";
	const expectedContent = globalPath
		? thinWrapperContent(globalPath)
		: repairWrapperContent();

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
		return { scriptStatus, pathUpdated, launchMode, targetPath: globalPath };
	}

	const profile = resolveProfileForPathExport(homeDir);

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

	return { scriptStatus, pathUpdated, launchMode, targetPath: globalPath };
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
