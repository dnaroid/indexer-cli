import type { Command } from "commander";
import { performManualUpdate } from "../../core/update-check.js";
import { PACKAGE_VERSION } from "../../core/version.js";

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
					return;
				case "updated":
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