import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Command } from "commander";
import { performManualUpdate } from "../../core/update-check.js";
import { PACKAGE_VERSION } from "../../core/version.js";
import { refreshRegisteredProjectSkillsIfNeeded } from "../../core/version-check.js";

function resolveUpdatedCliInvocation(): { command: string; args: string[] } {
	const argvEntry = process.argv[1];
	if (argvEntry && existsSync(argvEntry)) {
		return {
			command: process.execPath,
			args: [argvEntry],
		};
	}

	return {
		command: "indexer-cli",
		args: [],
	};
}

function runFreshSkillsRefresh(): void {
	try {
		const invocation = resolveUpdatedCliInvocation();
		console.log(
			"Update installed. Refreshing registered project skills with the updated CLI...",
		);
		execFileSync(invocation.command, [
			...invocation.args,
			"--no-auto-update",
			"doctor",
			"--check-skills-only",
			"--force",
		], {
			stdio: "inherit",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`Failed to refresh registered project skills with the updated CLI: ${message}`,
		);
		console.error(
			"Run `idx --no-auto-update doctor --check-skills-only --force` after confirming the updated binary is on PATH.",
		);
		process.exitCode = 1;
	}
}

async function refreshSkillsWithCurrentCli(): Promise<void> {
	const result = await refreshRegisteredProjectSkillsIfNeeded();
	if (result.refreshed > 0 || result.stale > 0) {
		console.log(
			`Skills check: refreshed ${result.refreshed} of ${result.checked} registered projects${
				result.stale > 0 ? `, removed ${result.stale} stale entries` : ""
			}`,
		);
	}
}

function describeSkipReason(reason: string): string {
	switch (reason) {
		case "unsupported-install-method":
			return "auto-update is only supported for global npm installs. Run: npm install -g indexer-cli@latest";
		case "ci":
			return "auto-update is disabled in CI. Run locally: npm install -g indexer-cli@latest";
		case "flag-disabled":
			return "auto-update was disabled with --no-auto-update.";
		case "update-lock-held":
			return "another indexer-cli update is already running.";
		case "non-tty":
			return "auto-update requires an interactive terminal.";
		default:
			return reason;
	}
}

export function registerUpdateCommand(program: Command): void {
	program
		.command("update")
		.description("Check npm and update the global indexer-cli install now")
		.action(async () => {
			const result = await performManualUpdate();

			switch (result.kind) {
				case "no-update":
					console.log(`indexer-cli is already up to date (${PACKAGE_VERSION}).`);
					await refreshSkillsWithCurrentCli();
					return;
				case "updated":
					runFreshSkillsRefresh();
					return;
				case "skipped":
					console.error(`Update skipped: ${describeSkipReason(result.reason)}`);
					process.exitCode = 1;
					return;
				case "failed":
					console.error(`Update failed: ${result.message}`);
					process.exitCode = 1;
					return;
			}
		});
}
