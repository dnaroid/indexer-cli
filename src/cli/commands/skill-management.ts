import path from "node:path";
import type { Command } from "commander";
import { PACKAGE_VERSION } from "../../core/version.js";
import { SKILLS_VERSION } from "../../core/skills-version.js";
import { addProject } from "../../core/registry.js";
import { resolveInitializedProjectRoot } from "../project-root.js";
import {
	detectInstalledSkillTargets,
	getEnabledSkillTargets,
	installSkillTargets,
	refreshEnabledSkillTargets,
	type SkillTarget,
} from "./init.js";

function requestedTargets(options: {
	claude?: boolean;
	codex?: boolean;
}): SkillTarget[] {
	return [
		...(options.claude ? ["claude" as const] : []),
		...(options.codex ? ["codex" as const] : []),
	];
}

function reportFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Skills failed: ${message}`);
	process.exitCode = 1;
}

export function registerSkillsCommand(program: Command): void {
	const skills = program
		.command("skills")
		.description("Install, refresh, or inspect project-local coding-agent skills");

	skills
		.command("install")
		.description("Install/enable repo-discovery for selected coding agents")
		.option("--claude", "install/enable the Claude Code project skill")
		.option("--codex", "install/enable the OpenAI Codex project skill")
		.action(async (options: { claude?: boolean; codex?: boolean }) => {
			try {
				const { projectRoot, notice } = resolveInitializedProjectRoot();
				if (notice) console.log(notice);
				const enabled = await installSkillTargets(
					projectRoot,
					requestedTargets(options),
				);
				addProject({
					projectPath: projectRoot,
					cliVersion: PACKAGE_VERSION,
					skillsVersion: SKILLS_VERSION,
				});
				console.log(`Enabled skill targets: ${enabled.join(", ")}`);
				console.log("Restart the selected coding agent(s) to pick up skill changes.");
			} catch (error) {
				reportFailure(error);
			}
		});

	skills
		.command("refresh")
		.description("Refresh repo-discovery for already enabled coding-agent targets")
		.action(async () => {
			try {
				const { projectRoot, notice } = resolveInitializedProjectRoot();
				if (notice) console.log(notice);
				const enabled = await refreshEnabledSkillTargets(projectRoot);
				if (enabled.length === 0) {
					console.log("No coding-agent skill targets are enabled.");
					return;
				}
				addProject({
					projectPath: projectRoot,
					cliVersion: PACKAGE_VERSION,
					skillsVersion: SKILLS_VERSION,
				});
				console.log(`Refreshed skill targets: ${enabled.join(", ")}`);
			} catch (error) {
				reportFailure(error);
			}
		});

	skills
		.command("status")
		.description("Show enabled and currently installed coding-agent skill targets")
		.action(async () => {
			try {
				const { projectRoot, notice } = resolveInitializedProjectRoot();
				if (notice) console.log(notice);
				const [enabled, installed] = await Promise.all([
					getEnabledSkillTargets(projectRoot),
					detectInstalledSkillTargets(projectRoot),
				]);
				console.log(`Project: ${path.relative(process.cwd(), projectRoot) || "."}`);
				console.log(`Enabled: ${enabled.join(", ") || "none"}`);
				console.log(`Installed: ${installed.join(", ") || "none"}`);
			} catch (error) {
				reportFailure(error);
			}
		});
}
