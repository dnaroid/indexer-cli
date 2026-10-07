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
import { CLASSIFICATION_STATUS_FILE } from "../../knowledge/document-indexer.js";
import {
	embeddingModeForProvider,
	parseEmbeddingMode,
	type EmbeddingMode,
} from "../../embedding/presets.js";
import { loadOpenRouterApiKey } from "../../embedding/factory.js";

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function reportClassificationStatus(projectPath: string): Promise<void> {
	const target = path.join(projectPath, ".indexer-cli", CLASSIFICATION_STATUS_FILE);
	try {
		const value = JSON.parse(await readFile(target, "utf8")) as {
			status?: string;
			attempted?: number;
			degraded?: number;
			reasons?: Record<string, number>;
			humanActionRequired?: boolean;
			pending?: number;
		};
		if (value.status !== "degraded" || (!value.degraded && !value.pending)) return;
		if (value.degraded) {
			const reasons = Object.entries(value.reasons ?? {}).map(([reason, count]) => `${reason}=${count}`).join(", ");
			console.warn(`Classification degraded in ${projectPath}: ${value.degraded}/${value.attempted ?? 0} (${reasons}). Knowledge retrieval remains safe.`);
		}
		if (value.pending) console.warn(`  ${value.pending} document(s) still await classification; \`idx index\` retries them once the classifier is available.`);
		if (value.humanActionRequired) console.warn("  Human action required: restore OpenRouter credentials/credits or service availability, then run `idx index`.");
	} catch { /* Missing/invalid derived classifier status is not a project health failure. */ }
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

async function readExistingEmbeddingMode(
	dataDir: string,
): Promise<EmbeddingMode | undefined> {
	try {
		const value = JSON.parse(
			await readFile(path.join(dataDir, "config.json"), "utf8"),
		) as { embeddingProvider?: unknown };
		if (value.embeddingProvider === undefined) return "local";
		if (typeof value.embeddingProvider !== "string") return undefined;
		return embeddingModeForProvider(value.embeddingProvider) ?? undefined;
	} catch {
		return undefined;
	}
}

async function reinitializePreservingTemplate(
	projectPath: string,
	embeddingOverride?: EmbeddingMode,
): Promise<void> {
	const dataDir = path.join(projectPath, ".indexer-cli");
	const [original, existingEmbedding] = await Promise.all([
		readExistingTemplate(dataDir),
		readExistingEmbeddingMode(dataDir),
	]);
	const embedding = embeddingOverride ?? existingEmbedding;
	if ((embedding ?? "openrouter") === "openrouter" && !loadOpenRouterApiKey()) {
		throw new Error("OpenRouter embedding mode requires OPENROUTER_API_KEY in the environment or ~/.config/idx/.env.");
	}
	try {
		await performUninstall(projectPath);
		await performInit(projectPath, { skipIndexing: false, embedding });
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
		.option(
			"--embedding <mode>",
			"embedding mode to use when reinitializing: local or openrouter",
		)
		.option("-f, --force", "skip confirmation prompt")
		.action(
			async (
				dir: string | undefined,
				options: {
					checkSkillsOnly?: boolean;
					skillsOnly?: boolean;
					embedding?: string;
					force?: boolean;
				},
			) => {
				const embedding = parseEmbeddingMode(options.embedding);
				let selectedProjects = getRegisteredProjects().map((entry) => path.resolve(entry.projectPath));
				if (dir !== undefined) {
					const workspaceDir = path.resolve(dir);
					try {
						selectedProjects = await scanDirectoryForProjects(workspaceDir);
					} catch (error) {
						console.error(`Failed to read directory ${workspaceDir}: ${error instanceof Error ? error.message : String(error)}`);
						process.exitCode = 1;
						return;
					}
				} else {
					// Stale registry entries must not introduce phantom provider requirements.
					const present = await Promise.all(selectedProjects.map(async (project) =>
						await pathExists(path.join(project, ".indexer-cli")) ? project : undefined,
					));
					selectedProjects = present.filter((project): project is string => project !== undefined);
				}
				const modes = embedding ? [embedding] : await Promise.all(selectedProjects.map(async (project) =>
					await readExistingEmbeddingMode(path.join(project, ".indexer-cli")) ?? "openrouter",
				));
				const embeddingModes = [...new Set<EmbeddingMode>(modes.length ? modes : ["openrouter"])];
				if (embeddingModes.includes("openrouter") && !loadOpenRouterApiKey()) {
					console.error(
						"OpenRouter embedding mode requires OPENROUTER_API_KEY in the environment or ~/.config/idx/.env.",
					);
					process.exitCode = 1;
					return;
				}
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

				if (performSetup({ embeddingModes }) === false) return;

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

					projectPaths = selectedProjects;

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
				for (const projectPath of projectPaths) await reportClassificationStatus(projectPath);

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
							await reinitializePreservingTemplate(projectPath, embedding);
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
