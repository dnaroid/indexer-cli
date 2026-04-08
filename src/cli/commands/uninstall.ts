import { constants as fsConstants } from "node:fs";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function removeClaudeSkill(projectRoot: string): Promise<void> {
	const skillDir = path.join(
		projectRoot,
		".claude",
		"skills",
		"repo-discovery",
	);
	if (await pathExists(skillDir)) {
		await rm(skillDir, { recursive: true, force: true });
		console.log(`Removed ${skillDir}`);
	}
}

export function registerUninstallCommand(program: Command): void {
	program
		.command("uninstall")
		.description("Remove indexer data for a project")
		.option("-f, --force", "Skip confirmation prompt")
		.action(async (options: { force?: boolean }) => {
			const resolvedProjectPath = process.cwd();
			const dataDir = path.join(resolvedProjectPath, ".indexer-cli");

			try {
				if (!(await pathExists(dataDir))) {
					console.log(`Nothing to remove at ${dataDir}`);
					return;
				}

				if (!options.force) {
					const rl = createInterface({ input, output });

					try {
						const answer = await rl.question(`Delete ${dataDir}? [y/N] `);
						if (!/^y(es)?$/i.test(answer.trim())) {
							console.log("Uninstall cancelled.");
							return;
						}
					} finally {
						rl.close();
					}
				}

				await rm(dataDir, { recursive: true, force: true });
				console.log(`Removed ${dataDir}`);
				await removeClaudeSkill(resolvedProjectPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Uninstall failed: ${message}`);
				process.exitCode = 1;
			}
		});
}
