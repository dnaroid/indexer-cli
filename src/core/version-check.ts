import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_VERSION } from "./version.js";
import { performUninstall } from "../cli/commands/uninstall.js";
import {
	detectInstalledSkillTargets,
	performInit,
	refreshSkillTargets,
	type SkillTarget,
} from "../cli/commands/init.js";
import { SKILLS_VERSION } from "./skills-version.js";
import { ensureIdxBinary } from "./idx-binary.js";
import { resolveInitializedProjectRoot } from "../cli/project-root.js";
import { addProject, cleanStaleEntries, getRegisteredProjects } from "./registry.js";

export interface RefreshSkillsResult {
	checked: number;
	refreshed: number;
	failed: number;
	stale: number;
}

function parseSkillTargets(value: unknown): SkillTarget[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return [...new Set(value.filter(
		(item): item is SkillTarget => item === "claude" || item === "codex",
	))].sort() as SkillTarget[];
}

async function configuredSkillTargets(
	projectRoot: string,
	parsedConfig: Record<string, unknown>,
): Promise<SkillTarget[]> {
	return parseSkillTargets(parsedConfig.skillTargets)
		?? await detectInstalledSkillTargets(projectRoot);
}

/**
 * Parse a version string into [major, minor, patch].
 * Returns null if the string is not a valid semver-like version.
 */
export function parseSemver(version: string): [number, number, number] | null {
	const parts = version.split(".");
	if (parts.length !== 3) return null;
	const [major, minor, patch] = parts.map(Number);
	if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
		return null;
	}
	return [major, minor, patch];
}

/**
 * Compare CLI version with config version.
 * If major version differs, run uninstall + init to re-sync.
 * Minor and patch changes do not trigger migration.
 *
 * @returns true if migration was performed, false otherwise
 */
export async function checkAndMigrateIfNeeded(): Promise<boolean> {
	let projectRoot: string;
	try {
		projectRoot = resolveInitializedProjectRoot().projectRoot;
	} catch {
		return false;
	}
	const configPath = path.join(projectRoot, ".indexer-cli", "config.json");

	if (!existsSync(configPath)) {
		return false;
	}

	let configVersion: string;
	let parsedConfig: Record<string, unknown>;
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("version" in parsed) ||
			typeof (parsed as { version: unknown }).version !== "string"
		) {
			return false;
		}
		configVersion = (parsed as { version: string }).version;
		parsedConfig = parsed as Record<string, unknown>;
	} catch {
		return false;
	}

	const current = parseSemver(PACKAGE_VERSION);
	const stored = parseSemver(configVersion);

	if (!current || !stored) return false;

	// Compare major version only. Minor and patch changes do not trigger migration.
	if (current[0] === stored[0]) {
		return false;
	}

	console.log(
		`indexer-cli: version changed (${configVersion} → ${PACKAGE_VERSION}). Re-initializing project data...`,
	);
	console.log("  Removing .indexer-cli/...");

	try {
		const skillTargets = await configuredSkillTargets(projectRoot, parsedConfig);
		await performUninstall(projectRoot);

		console.log("  Re-initializing...");
		await performInit(projectRoot, {
			skipIndexing: false,
			skillTargets,
		});

		console.log("indexer-cli: migration complete.");
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`indexer-cli: migration failed: ${message}`);
		console.error(
			"  Run manually: indexer-cli uninstall -f && indexer-cli init",
		);
		process.exitCode = 1;
		return false;
	}
}

async function refreshSkillsIfNeededForProject(
	projectRoot: string,
	options: { announce?: boolean; silent?: boolean } = {},
): Promise<"none" | "version-only" | "refreshed"> {
	const configPath = path.join(projectRoot, ".indexer-cli", "config.json");

	if (!existsSync(configPath)) {
		return "none";
	}

	let storedSkillsVersion: number | undefined;
	let parsedConfig: Record<string, unknown>;
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"skillsVersion" in parsed &&
			typeof (parsed as { skillsVersion: unknown }).skillsVersion === "number"
		) {
			storedSkillsVersion = (parsed as { skillsVersion: number }).skillsVersion;
		}
		parsedConfig = parsed as Record<string, unknown>;
	} catch {
		return "none";
	}

	if (storedSkillsVersion === SKILLS_VERSION) {
		return "none";
	}

	const targets = await configuredSkillTargets(projectRoot, parsedConfig);
	if (options.announce !== false && targets.length > 0) {
		console.error(
			`indexer-cli: skills updated (version ${storedSkillsVersion ?? "none"} → ${SKILLS_VERSION}). Refreshing ${targets.join(", ")} skill target(s)...`,
		);
	}

	const originalConsoleLog = console.log;
	try {
		if (options.silent !== false) {
			console.log = () => undefined;
		}
		await refreshSkillTargets(projectRoot, targets, { silent: true });
	} finally {
		console.log = originalConsoleLog;
	}
	ensureIdxBinary();

	parsedConfig.skillsVersion = SKILLS_VERSION;
	parsedConfig.skillTargets = targets;
	writeFileSync(
		configPath,
		`${JSON.stringify(parsedConfig, null, 2)}\n`,
		"utf8",
	);

	return targets.length > 0 ? "refreshed" : "version-only";
}

export async function forceRefreshProjectSkills(
	projectRoot: string,
	options: { silent?: boolean } = {},
): Promise<void> {
	const configPath = path.join(projectRoot, ".indexer-cli", "config.json");

	if (!existsSync(configPath)) {
		return;
	}
	const raw = readFileSync(configPath, "utf8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const targets = await configuredSkillTargets(projectRoot, parsed);

	const originalConsoleLog = console.log;
	try {
		if (options.silent) {
			console.log = () => undefined;
		}
		await refreshSkillTargets(projectRoot, targets, { silent: options.silent });
	} finally {
		console.log = originalConsoleLog;
	}
	ensureIdxBinary();

	parsed.skillsVersion = SKILLS_VERSION;
	parsed.skillTargets = targets;
	writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

	addProject({
		projectPath: projectRoot,
		cliVersion: PACKAGE_VERSION,
		skillsVersion: SKILLS_VERSION,
	});
}

export async function checkAndRefreshSkills(): Promise<boolean> {
	let projectRoot: string;
	try {
		projectRoot = resolveInitializedProjectRoot().projectRoot;
	} catch {
		return false;
	}

	return (await refreshSkillsIfNeededForProject(projectRoot)) === "refreshed";
}

export async function refreshRegisteredProjectSkillsIfNeeded(
	options: { silent?: boolean } = {},
): Promise<RefreshSkillsResult> {
	const staleEntries = cleanStaleEntries();
	const projects = getRegisteredProjects();
	const result: RefreshSkillsResult = {
		checked: projects.length,
		refreshed: 0,
		failed: 0,
		stale: staleEntries.length,
	};

	for (const entry of projects) {
		const projectRoot = path.resolve(entry.projectPath);
		try {
			const refreshState = await refreshSkillsIfNeededForProject(projectRoot, {
				announce: !options.silent,
				silent: true,
			});
			if (refreshState !== "none") {
				if (refreshState === "refreshed") result.refreshed += 1;
				addProject({
					projectPath: projectRoot,
					cliVersion: PACKAGE_VERSION,
					skillsVersion: SKILLS_VERSION,
				});
			}
		} catch (error) {
			result.failed += 1;
			if (!options.silent) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Failed to refresh skills in ${projectRoot}: ${message}`);
			}
		}
	}

	if (result.failed > 0) {
		process.exitCode = 1;
	}

	return result;
}
