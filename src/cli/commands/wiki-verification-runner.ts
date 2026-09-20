import { exec } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { LocalVerificationRunnerChecks } from "../../core/types.js";
import { runVerificationChecks } from "../../knowledge/verification/runner.js";

const execute = promisify(exec);

/** Only explicit --check arguments reach the shell; receipt text is never executed. */
export async function runWikiVerificationChecks(
	commands: string[],
	projectRoot: string,
): Promise<LocalVerificationRunnerChecks> {
	const logDirectory = await mkdtemp(path.join(os.tmpdir(), "idx-wiki-checks-"));
	let nextLog = 0;
	return runVerificationChecks(commands, async (command) => {
		const logPath = path.join(logDirectory, `${++nextLog}.log`);
		let output = "";
		let exitCode = 0;
		let incomplete = false;
		try {
			const result = await execute(command, { cwd: projectRoot, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
			output = `${result.stdout}${result.stderr}`;
		} catch (error) {
			const result = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; message?: string };
			output = `${result.stdout ?? ""}${result.stderr ?? ""}\n${result.message ?? "Execution failed"}\n`;
			exitCode = typeof result.code === "number" ? result.code : 1;
			incomplete = result.killed === true || typeof result.code !== "number";
		}
		await writeFile(logPath, output);
		console.error(`CHECK_RESULT=${incomplete ? "incomplete" : exitCode === 0 ? "passed" : "failed"} command=${JSON.stringify(command)} exit_code=${exitCode} log=${logPath}`);
		if (incomplete) throw new Error(`Verification check was incomplete; baseline not accepted. Log: ${logPath}`);
		return { exitCode, output };
	});
}
