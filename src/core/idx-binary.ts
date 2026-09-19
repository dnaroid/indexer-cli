import {
	accessSync,
	chmodSync,
	constants as fsConstants,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withMacPathAliases(value: string): string[] {
	if (value.startsWith("/private/")) {
		return [value, value.slice("/private".length)];
	}
	if (value.startsWith("/var/")) {
		return [value, `/private${value}`];
	}
	return [value];
}

function isSelfRecursiveShellLauncher(
	content: string,
	binaryPaths: string[],
): boolean {
	const candidates = [...new Set(binaryPaths.flatMap(withMacPathAliases))];

	return candidates.some((candidate) => {
		const escapedPath = escapeRegExp(candidate);
		const recursiveExec = new RegExp(
			`^\\s*exec\\s+(?:${escapedPath}|'${escapedPath}'|"${escapedPath}")(?:\\s+"\\$@")?\\s*$`,
			"m",
		);
		return recursiveExec.test(content);
	});
}

function idxWrapperContent(): string {
	return `#!/bin/sh
for system_idx in /opt/homebrew/bin/idx /usr/local/bin/idx; do
	if [ -x "$system_idx" ]; then
		exec "$system_idx" "$@"
	fi
done
if command -v npm >/dev/null 2>&1; then
	prefix="$(npm config get prefix 2>/dev/null)"
	if [ -n "$prefix" ]; then
		global_idx="$prefix/bin/idx"
		global_legacy_bin="$prefix/bin/indexer-cli"
		if [ -x "$global_idx" ]; then
			exec "$global_idx" "$@"
		fi
		if [ -x "$global_legacy_bin" ]; then
			exec "$global_legacy_bin" "$@"
		fi
	fi
	if [ "$1" = "setup" ]; then
		shift
		exec npm exec --yes --package=indexer-cli@latest -- indexer-cli setup "$@"
	fi
fi
echo "idx: global indexer-cli installation was not found or is not executable." >&2
echo "Run: idx setup" >&2
echo "Or: npm install -g indexer-cli" >&2
exit 1
`;
}

function systemPrefixesOnPath(): string[] {
	const pathEntries = new Set((process.env.PATH ?? "").split(":"));
	const candidates =
		os.platform() === "darwin"
			? ["/opt/homebrew", "/usr/local"]
			: os.platform() === "linux"
				? ["/usr/local", "/usr"]
				: [];
	return candidates.filter((prefix) => pathEntries.has(path.join(prefix, "bin")));
}

function resolveExistingGlobalBin(prefix: string): string | null {
	for (const binaryName of ["idx", "indexer-cli"]) {
		const binPath = path.join(prefix, "bin", binaryName);
		try {
			accessSync(binPath, fsConstants.F_OK | fsConstants.X_OK);
			const realBinPath = realpathSync(binPath);
			const launcherContent = readFileSync(binPath, "utf8");
			if (
				isSelfRecursiveShellLauncher(launcherContent, [binPath, realBinPath])
			) {
				continue;
			}
			return binPath;
		} catch {
			// try next candidate
		}
	}

	return null;
}

export type EnsureIdxBinaryResult = {
	scriptStatus: "unchanged" | "installed" | "repaired";
	pathUpdated: boolean;
	launchMode: "global-wrapper" | "repair-wrapper";
	targetPath: string | null;
};

export function getNpmGlobalBinPath(): string | null {
	for (const prefix of systemPrefixesOnPath()) {
		const systemBin = resolveExistingGlobalBin(prefix);
		if (systemBin) return systemBin;
	}

	try {
		const prefix = execSync("npm config get prefix", {
			encoding: "utf8",
		}).trim();
		return resolveExistingGlobalBin(prefix);
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

	return path.join(homeDir, ".profile");
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
	const expectedContent = idxWrapperContent();

	let scriptStatus: EnsureIdxBinaryResult["scriptStatus"] = "installed";

	try {
		accessSync(scriptPath, fsConstants.F_OK);
		const scriptMeta = lstatSync(scriptPath);
		if (scriptMeta.isSymbolicLink()) {
			scriptStatus = "repaired";
		}
		const existing = readFileSync(scriptPath, "utf8");
		if (scriptStatus !== "repaired" && existing === expectedContent) {
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
		try {
			if (lstatSync(scriptPath).isSymbolicLink()) {
				rmSync(scriptPath, { force: true });
			}
		} catch {}
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
		const systemPrefix = systemPrefixesOnPath().find((prefix) => {
			try {
				accessSync(path.join(prefix, "bin", "npm"), fsConstants.X_OK);
				accessSync(path.join(prefix, "bin", "node"), fsConstants.X_OK);
				return true;
			} catch {
				return false;
			}
		});
		const npmCommand = systemPrefix
			? `"${path.join(systemPrefix, "bin", "npm")}"`
			: "npm";
		const env = systemPrefix
			? {
					...process.env,
					PATH: `${path.join(systemPrefix, "bin")}:${process.env.PATH ?? ""}`,
			  }
			: process.env;
		execSync(`${npmCommand} install -g indexer-cli@latest`, {
			stdio: "pipe",
			encoding: "utf8",
			env,
		});
		return true;
	} catch {
		return false;
	}
}
