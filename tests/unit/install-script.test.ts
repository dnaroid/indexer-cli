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
		const aptOutput = runShell(
			`source "${scriptPath}"; detect_node_install_strategy Linux 0 1`,
		);
		const unsupportedOutput = runShell(
			`source "${scriptPath}"; detect_node_install_strategy FreeBSD 0 0`,
		);

		expect(brewOutput.trim()).toBe("brew");
		expect(aptOutput.trim()).toBe("apt");
		expect(unsupportedOutput.trim()).toBe("unsupported");
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
});
