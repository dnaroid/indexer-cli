import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { PACKAGE_VERSION } from "../../core/version.js";
import { SKILLS_VERSION } from "../../core/skills-version.js";
import { performInit } from "./init.js";
import { performUninstall } from "./uninstall.js";
import { performSetup } from "./setup.js";
import { installSpecTemplate } from "../spec-template.js";
import {
	addProject,
	getRegisteredProjects,
	cleanStaleEntries,
} from "../../core/registry.js";
import {
	forceRefreshProjectSkills,
	refreshRegisteredProjectSkillsIfNeeded,
} from "../../core/version-check.js";

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function scanDirectoryForProjects(dir: string): Promise<string[]> {
	const entries = await readdir(dir, {
		encoding: "utf8",
		withFileTypes: true,
	});

	const projectPaths: string[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const projectPath = path.join(dir, entry.name);
		const dataDir = path.join(projectPath, ".indexer-cli");

		if (await pathExists(dataDir)) {
			projectPaths.push(projectPath);
		}
	}

	return projectPaths;
}

async function readExistingTemplate(dataDir: string): Promise<Buffer | undefined> {
	try {
		return await readFile(path.join(dataDir, "spec-template.md"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function reinitializePreservingTemplate(projectPath: string): Promise<void> {
	const dataDir = path.join(projectPath, ".indexer-cli");
	const original = await readExistingTemplate(dataDir);
	try {
		await performUninstall(projectPath);
		await performInit(projectPath, { skipIndexing: false });
	} finally {
		if (original !== undefined) {
			// Uninstall removes the data directory, including user edits to the template.
			// Restore even if initialization failed after the removal.
			await mkdir(dataDir, { recursive: true });
			const target = path.join(dataDir, "spec-template.md");
			await rm(target, { force: true });
			await writeFile(target, original, { flag: "wx" });
		}
	}
}

export function registerDoctorCommand(program: Command): void {
	program
		.command("doctor")
		.description("Health-check and repair registered indexer projects")
		.argument("[dir]", "scan a workspace directory for indexed projects")
		.option(
			"--check-skills-only",
			"only refresh registered project skills when their stored skills version is stale",
		)
		.option("--skills-only", "only refresh skills without full reinstall")
		.option("-f, --force", "skip confirmation prompt")
		.action(
			async (
				dir: string | undefined,
				options: {
					checkSkillsOnly?: boolean;
					skillsOnly?: boolean;
					force?: boolean;
				},
			) => {
				console.log("\nRegistered projects:");
				const allRegistered = getRegisteredProjects();
				if (allRegistered.length === 0) {
					console.log("  (none)");
				} else {
					for (const entry of allRegistered) {
						console.log(`  - ${entry.projectPath}`);
					}
				}
				console.log("");

				performSetup();

				if (dir === undefined && !options.skillsOnly) {
					const refreshResult = await refreshRegisteredProjectSkillsIfNeeded();
					if (refreshResult.refreshed > 0 || refreshResult.stale > 0) {
						console.log(
							`Skills check: refreshed ${refreshResult.refreshed} of ${refreshResult.checked} registered projects${
								refreshResult.stale > 0
									? `, removed ${refreshResult.stale} stale entries`
									: ""
							}`,
						);
					}
				}

				if (options.checkSkillsOnly) {
					// A current skills version does not imply the template is present.
					for (const entry of getRegisteredProjects()) {
						const projectPath = path.resolve(entry.projectPath);
						if (!(await pathExists(path.join(projectPath, ".indexer-cli", "config.json")))) continue;
						try {
							await installSpecTemplate(path.join(projectPath, ".indexer-cli"));
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							console.error(`Failed to repair spec template in ${projectPath}: ${message}`);
							process.exitCode = 1;
						}
					}
					return;
				}

				let projectPaths: string[] = [];

				if (dir === undefined) {
					const staleEntries = cleanStaleEntries();
					for (const entry of staleEntries) {
						console.log(
							`Removed stale entry: ${entry.projectPath} (project no longer has .indexer-cli)`,
						);
					}

					projectPaths = getRegisteredProjects().map((entry) =>
						path.resolve(entry.projectPath),
					);

					if (projectPaths.length === 0) {
						console.log("No registered projects found.");
						return;
					}
				} else {
					const workspaceDir = path.resolve(dir);

					if (!(await pathExists(workspaceDir))) {
						console.error(`Directory not found: ${workspaceDir}`);
						process.exitCode = 1;
						return;
					}

					try {
						projectPaths = await scanDirectoryForProjects(workspaceDir);
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

					for (const projectPath of projectPaths) {
						addProject({
							projectPath,
							cliVersion: PACKAGE_VERSION,
							skillsVersion: SKILLS_VERSION,
						});
					}
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

				let successCount = 0;

				for (const projectPath of projectPaths) {
					const projectName = path.basename(projectPath);

					console.log(
						`${options.skillsOnly ? "Refreshing skills" : "Reinitializing"}: ${projectName}`,
					);

					try {
						if (options.skillsOnly) {
							await installSpecTemplate(path.join(projectPath, ".indexer-cli"));
							await forceRefreshProjectSkills(projectPath);
						} else {
							await reinitializePreservingTemplate(projectPath);
							await installSpecTemplate(path.join(projectPath, ".indexer-cli"));
							addProject({
								projectPath,
								cliVersion: PACKAGE_VERSION,
								skillsVersion: SKILLS_VERSION,
							});
						}
						console.log(`Done: ${projectName}`);
						successCount += 1;
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
						? `Refreshed skills in ${successCount} of ${projectPaths.length} projects`
						: `Reinitialized ${successCount} of ${projectPaths.length} projects`,
				);
			},
		);
}
