import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLI_ROOT = path.resolve(__dirname, "..", "..", "..");

type RunResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

function runCLI(args: string[]): RunResult {
	const distEntry = path.join(CLI_ROOT, "dist", "cli", "entry.js");
	const command = `node "${distEntry}" ${args.join(" ")}`;

	try {
		const stdout = execSync(command, {
			encoding: "utf-8",
			env: { ...process.env, FORCE_COLOR: "0" },
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 30_000,
		});
		return { exitCode: 0, stdout: stdout.trim(), stderr: "" };
	} catch (error: unknown) {
		const execError = error as {
			status?: number;
			stdout?: string | Buffer;
			stderr?: string | Buffer;
		};
		return {
			exitCode: execError.status ?? 1,
			stdout: normalizeOutput(execError.stdout),
			stderr: normalizeOutput(execError.stderr),
		};
	}
}

function normalizeOutput(output?: string | Buffer): string {
	if (!output) return "";
	if (Buffer.isBuffer(output)) return output.toString("utf-8").trim();
	return output.trim();
}

function hasStackTrace(output: string): boolean {
	return (
		output.includes("at Command._exit") ||
		output.includes("CommanderError:") ||
		output.includes("at Module._compile") ||
		output.includes("at node:")
	);
}

describe("CLI error output", () => {
	it("shows clean message for unknown short option -v with no stack trace", () => {
		const result = runCLI(["-v"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error: unknown option '-v'");
		expect(hasStackTrace(result.stderr)).toBe(false);
		expect(hasStackTrace(result.stdout)).toBe(false);
	});

	it("shows clean message for unknown long option --nonexistent with no stack trace", () => {
		const result = runCLI(["--nonexistent"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error: unknown option '--nonexistent'");
		expect(hasStackTrace(result.stderr)).toBe(false);
		expect(hasStackTrace(result.stdout)).toBe(false);
	});

	it("shows clean message for unknown option on subcommand with no stack trace", () => {
		const result = runCLI(["index", "--bogusflag"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error: unknown option '--bogusflag'");
		expect(hasStackTrace(result.stderr)).toBe(false);
		expect(hasStackTrace(result.stdout)).toBe(false);
	});

	it("shows clean message for unknown command with no stack trace", () => {
		const result = runCLI(["nonexistent-command"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"error: unknown command 'nonexistent-command'",
		);
		expect(hasStackTrace(result.stderr)).toBe(false);
		expect(hasStackTrace(result.stdout)).toBe(false);
	});

	it("produces only one-line error messages (no multi-line dumps)", () => {
		const result = runCLI(["--nonexistent"]);

		expect(result.exitCode).toBe(1);
		const errorLines = result.stderr.split("\n").filter((l) => l.trim());
		expect(errorLines).toHaveLength(1);
		expect(errorLines[0]).toMatch(/^error:/);
	});

	it("keeps --help and --version working with exit code 0", () => {
		const helpResult = runCLI(["--help"]);
		expect(helpResult.exitCode).toBe(0);
		expect(helpResult.stdout).toContain("Usage: idx");

		const versionResult = runCLI(["--version"]);
		expect(versionResult.exitCode).toBe(0);
		expect(versionResult.stdout).toMatch(/\d+\.\d+\.\d+/);
	});

	it("prints help on bare invocation without triggering auto-update", () => {
		const result = runCLI([]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage: idx");
		expect(result.stdout).not.toContain(
			"The new version will be used on the next run.",
		);
		expect(result.stdout).not.toContain("Updated indexer-cli");
		expect(result.stderr).toBe("");
	});
});
