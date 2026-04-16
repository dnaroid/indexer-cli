import { constants as fsConstants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { performInit, refreshClaudeSkills } from "./init.js";
import { performUninstall } from "./uninstall.js";

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function registerReinitCommand(program: Command): void {
	program
		.command("reinit")
		.description(
			"Reinitialize indexer in all projects within a directory (uninstall + init)",
		)
		.argument("<dir>", "path to workspace directory containing projects")
		.option("--skills-only", "only refresh skills without full reinstall")
		.option("-f, --force", "skip confirmation prompt")
		.action(
			async (
				dir: string,
				options: {
					skillsOnly?: boolean;
					force?: boolean;
				},
			) => {
				const workspaceDir = path.resolve(dir);

				if (!(await pathExists(workspaceDir))) {
					console.error(`Directory not found: ${workspaceDir}`);
					process.exitCode = 1;
					return;
				}

				const projectPaths: string[] = [];

				try {
					const entries = await readdir(workspaceDir, {
						encoding: "utf8",
						withFileTypes: true,
					});

					for (const entry of entries) {
						if (!entry.isDirectory()) {
							continue;
						}

						const projectPath = path.join(workspaceDir, entry.name);
						const dataDir = path.join(projectPath, ".indexer-cli");

						if (await pathExists(dataDir)) {
							projectPaths.push(projectPath);
						}
					}
				} catch (error) {
					const code =
						typeof error === "object" && error !== null && "code" in error
							? Reflect.get(error, "code")
							: undefined;
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(
						code === "ENOTDIR"
							? `Not a directory: ${workspaceDir}`
							: `Failed to read directory ${workspaceDir}: ${message}`,
					);
					process.exitCode = 1;
					return;
				}

				if (projectPaths.length === 0) {
					console.log(`No indexed projects found in ${workspaceDir}`);
					return;
				}

				if (!options.force) {
					const action = options.skillsOnly
						? "have skills refreshed"
						: "be reinitialized";
					console.error(`The following projects will ${action}:`);
					for (const projectPath of projectPaths) {
						console.error(`- ${projectPath}`);
					}

					const rl = createInterface({ input, output });

					try {
						const answer = await rl.question("Proceed? [y/N] ");
						if (!/^y(es)?$/i.test(answer.trim())) {
							console.log("Cancelled.");
							return;
						}
					} finally {
						rl.close();
					}
				}

				let reinitializedCount = 0;

				for (const projectPath of projectPaths) {
					const projectName = path.basename(projectPath);
					console.log(
						`${options.skillsOnly ? "Refreshing skills" : "Reinitializing"}: ${projectName}`,
					);

					try {
						if (options.skillsOnly) {
							await refreshClaudeSkills(projectPath);
						} else {
							await performUninstall(projectPath);
							await performInit(projectPath);
						}
						console.log(`Done: ${projectName}`);
						reinitializedCount += 1;
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						console.error(
							`Failed to ${options.skillsOnly ? "refresh skills in" : "reinitialize"} ${projectName}: ${message}`,
						);
						process.exitCode = 1;
					}
				}

				console.log(
					options.skillsOnly
						? `Refreshed skills in ${reinitializedCount} of ${projectPaths.length} projects`
						: `Reinitialized ${reinitializedCount} of ${projectPaths.length} projects`,
				);
			},
		);
}
