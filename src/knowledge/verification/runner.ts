import { createHash } from "node:crypto";
import type { KnowledgeVerificationRunnerCheck, LocalVerificationRunnerChecks } from "../../core/types.js";

export type VerificationCommandExecutor = (command: string) => Promise<{ exitCode: number; output: string }>;
const locallyExecutedChecks = new WeakSet<object>();

/** True only for the exact array returned by this process's runner. */
export function isTrustedLocalRunnerChecks(value: unknown): value is LocalVerificationRunnerChecks {
	return typeof value === "object" && value !== null && locallyExecutedChecks.has(value);
}

/** Explicit opt-in runner: it executes only through a caller supplied executor. */
export async function runVerificationChecks(commands: readonly string[], execute: VerificationCommandExecutor): Promise<LocalVerificationRunnerChecks> {
	if (commands.length === 0) throw new Error("Verification runner requires at least one command.");
	const checks = await Promise.all(commands.map(async (command) => {
		if (!command.trim()) throw new Error("Verification command must not be empty.");
		const result = await execute(command);
		if (!Number.isInteger(result.exitCode) || typeof result.output !== "string") throw new Error("Verification executor returned an invalid result.");
		const digest = (value: string) => createHash("sha256").update(value).digest("hex");
		return Object.freeze({ command, exitCode: result.exitCode, complete: true as const, recordedBy: "local-runner" as const, resultHash: digest(`${result.exitCode}\n${result.output}`), logHash: digest(result.output) });
	}));
	const trusted = Object.freeze(checks);
	locallyExecutedChecks.add(trusted);
	return trusted;
}
