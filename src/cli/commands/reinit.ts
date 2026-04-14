import { constants as fsConstants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { performInit } from "./init.js";
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
		.option("--refresh-skills", "recreate .claude/skills during reinit")
		.option("-f, --force", "skip confirmation prompt")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.action(
			async (
				dir: string,
				options: { refreshSkills?: boolean; force?: boolean },
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
					console.error("The following projects will be reinitialized:");
					for (const projectPath of projectPaths) {
						console.error(`- ${projectPath}`);
					}

					const rl = createInterface({ input, output });

					try {
						const answer = await rl.question("Proceed with reinit? [y/N] ");
						if (!/^y(es)?$/i.test(answer.trim())) {
							console.log("Reinit cancelled.");
							return;
						}
					} finally {
						rl.close();
					}
				}

				let reinitializedCount = 0;

				for (const projectPath of projectPaths) {
					const projectName = path.basename(projectPath);
					console.log(`Reinitializing: ${projectName}`);

					try {
						await performUninstall(projectPath);
						await performInit(projectPath, {
							refreshSkills: options?.refreshSkills,
						});
						console.log(`Done: ${projectName}`);
						reinitializedCount += 1;
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						console.error(`Failed to reinitialize ${projectName}: ${message}`);
						process.exitCode = 1;
					}
				}

				console.log(
					`Reinitialized ${reinitializedCount} of ${projectPaths.length} projects`,
				);
			},
		);
}
