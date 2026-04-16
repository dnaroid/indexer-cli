import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
	cpSync,
	readFileSync,
	rmSync,
	mkdirSync,
	constants as fsConstants,
	accessSync,
} from "node:fs";

const CLI_ROOT = path.resolve(__dirname, "..", "..");

export type CLIRunResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

function resolveCliEntry(): string {
	const distEntry = path.join(CLI_ROOT, "dist", "cli", "entry.js");
	try {
		accessSync(distEntry, fsConstants.F_OK);
		return distEntry;
	} catch {
		return path.join(CLI_ROOT, "src", "cli", "entry.ts");
	}
}

export function runCLI(
	args: string[],
	options?: { cwd: string; env?: Record<string, string> },
): CLIRunResult {
	const entry = resolveCliEntry();
	const isTs = entry.endsWith(".entry.ts");
	const command = isTs
		? `npx tsx "${entry}" ${args.join(" ")}`
		: `node "${entry}" ${args.join(" ")}`;

	try {
		const stdout = execSync(command, {
			cwd: options?.cwd,
			encoding: "utf-8",
			env: {
				...process.env,
				...options?.env,
				FORCE_COLOR: "0",
				INDEXER_CLI_HOME: path.join(os.tmpdir(), "indexer-cli-test-home"),
			},
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 120_000,
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

const FIXTURES_E2E_GODOT = path.resolve(
	__dirname,
	"..",
	"..",
	"fixtures",
	"projects",
	"e2e-godot",
);

export function createTempProject(tempDir: string): void {
	mkdirSync(tempDir, { recursive: true });
	cpSync(FIXTURES_E2E_GODOT, tempDir, { recursive: true });
}

export function removeTempProject(tempDir: string): void {
	rmSync(tempDir, { recursive: true, force: true });
}

export function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function readTextFile(filePath: string): string {
	return readFileSync(filePath, "utf-8");
}

export function gitInit(cwd: string): void {
	execSync("git init", { cwd, stdio: "pipe" });
	execSync("git add -A", { cwd, stdio: "pipe" });
	execSync('git commit -m "initial"', {
		cwd,
		stdio: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test.com",
		},
	});
}
