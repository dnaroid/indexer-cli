import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../");
const scriptPath = path.join(repoRoot, "install.sh");

function runShell(snippet: string): string {
	return execFileSync("bash", ["-lc", snippet], {
		cwd: repoRoot,
		encoding: "utf8",
	});
}

describe("install.sh helpers", () => {
	it("passes bash syntax check", () => {
		expect(() =>
			execFileSync("bash", ["-n", scriptPath], {
				cwd: repoRoot,
				encoding: "utf8",
			}),
		).not.toThrow();
	});

	it("parses node major versions", () => {
		const output = runShell(
			`source "${scriptPath}"; parse_node_major "v20.18.1"`,
		);
		expect(output.trim()).toBe("20");
	});

	it("detects the supported bootstrap strategy", () => {
		const brewOutput = runShell(
			`source "${scriptPath}"; detect_node_install_strategy Darwin 1 0`,
		);
		const pkgOutput = runShell(
			`source "${scriptPath}"; detect_node_install_strategy Darwin 0 0`,
		);
		const aptOutput = runShell(
			`source "${scriptPath}"; detect_node_install_strategy Linux 0 1`,
		);
		const unsupportedOutput = runShell(
			`source "${scriptPath}"; detect_node_install_strategy FreeBSD 0 0`,
		);

		expect(brewOutput.trim()).toBe("brew");
		expect(pkgOutput.trim()).toBe("pkg");
		expect(aptOutput.trim()).toBe("apt");
		expect(unsupportedOutput.trim()).toBe("unsupported");
	});

	it("extracts the latest macOS package name from the Node.js shasums manifest", () => {
		const output = runShell(`
			source "${scriptPath}"
			resolve_latest_node_pkg_name $'aaaa  node-v20.19.5.pkg\nzzzz  node-v20.19.5.tar.xz\n'
		`);

		expect(output.trim()).toBe("node-v20.19.5.pkg");
	});

	it("treats stdin-style bash execution as direct execution without unbound variables", () => {
		const directOutput = runShell(
			`source "${scriptPath}"; is_direct_execution bash bash && printf 'direct\n'`,
		);
		const sourcedOutput = runShell(
			`source "${scriptPath}"; if is_direct_execution "${scriptPath}" bash; then printf 'direct\n'; else printf 'sourced\n'; fi`,
		);

		expect(directOutput.trim()).toBe("direct");
		expect(sourcedOutput.trim()).toBe("sourced");
	});

	it("chooses automatic bootstrap when runtime verification initially fails", () => {
		const output = runShell(`
			source "${scriptPath}"
			install_invocations=0
			verify_calls=0
			verify_node_runtime() {
				verify_calls=$((verify_calls + 1))
				[ "$verify_calls" -ge 2 ]
			}
			command_exists() { return 1; }
			detect_node_install_strategy() { printf 'brew\n'; }
			install_node_with_brew() { install_invocations=$((install_invocations + 1)); }
			install_node_with_apt() { printf 'unexpected apt\n' >&2; return 1; }
			msg() { :; }
			ensure_supported_node
			printf '%s\n' "$install_invocations"
		`);

		expect(output.trim()).toBe("1");
	});

	it("detects npm ci lockfile sync errors for fallback", () => {
		const matchOutput = runShell(`
			source "${scriptPath}"
			if is_npm_ci_lockfile_sync_error $'npm error code EUSAGE\nMissing: @esbuild/darwin-x64@0.27.7 from lock file'; then
				printf 'fallback\n'
			else
				printf 'fail\n'
			fi
		`);
		const nonMatchOutput = runShell(`
			source "${scriptPath}"
			if is_npm_ci_lockfile_sync_error 'network timeout'; then
				printf 'fallback\n'
			else
				printf 'fail\n'
			fi
		`);

		expect(matchOutput.trim()).toBe("fallback");
		expect(nonMatchOutput.trim()).toBe("fail");
	});

	it("installs a user-local launcher without requiring npm link", () => {
		const output = runShell(`
			set -euo pipefail
			source "${scriptPath}"
			tmp_dir=$(mktemp -d)
			INSTALL_DIR="$tmp_dir/install"
			BIN_DIR="$tmp_dir/bin"
			mkdir -p "$INSTALL_DIR/bin"
			touch "$INSTALL_DIR/bin/indexer-cli.js"
			msg() { :; }
			install_user_launcher
			launcher_path="$BIN_DIR/indexer-cli"
			printf '%s\n' "$(test -x "$launcher_path" && printf executable)"
			printf '%s\n' "$(cat "$launcher_path")"
		`);

		expect(output).toContain("executable");
		expect(output).toContain("exec node ");
		expect(output).toContain("/install/bin/indexer-cli.js");
	});

	it("detects whether a directory is already on PATH", () => {
		const output = runShell(`
			source "${scriptPath}"
			PATH='/usr/local/bin:/tmp/example/bin:/usr/bin'
			if path_contains_dir '/tmp/example/bin'; then
				printf 'present\n'
			else
				printf 'missing\n'
			fi
			if path_contains_dir '/tmp/other/bin'; then
				printf 'present\n'
			else
				printf 'missing\n'
			fi
		`);

		expect(output.trim().split("\n")).toEqual(["present", "missing"]);
	});
});
