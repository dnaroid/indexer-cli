import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_VERSION } from "./version.js";
import { performUninstall } from "../cli/commands/uninstall.js";
import { performInit } from "../cli/commands/init.js";
import { SKILLS_VERSION } from "./skills-version.js";
import { refreshClaudeSkills } from "../cli/commands/init.js";
import { ensureIdxBinary } from "./idx-binary.js";

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
	const projectRoot = process.cwd();
	const configPath = path.join(projectRoot, ".indexer-cli", "config.json");

	if (!existsSync(configPath)) {
		return false;
	}

	let configVersion: string;
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
		await performUninstall(projectRoot);

		console.log("  Re-initializing...");
		await performInit(projectRoot, { skipIndexing: false });

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

export async function checkAndRefreshSkills(): Promise<boolean> {
	const projectRoot = process.cwd();
	const configPath = path.join(projectRoot, ".indexer-cli", "config.json");

	if (!existsSync(configPath)) {
		return false;
	}

	let storedSkillsVersion: number | undefined;
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
	} catch {
		return false;
	}

	if (storedSkillsVersion === SKILLS_VERSION) {
		return false;
	}

	console.error(
		`indexer-cli: skills updated (version ${storedSkillsVersion ?? "none"} → ${SKILLS_VERSION}). Refreshing .claude/skills/...`,
	);

	await refreshClaudeSkills(projectRoot);
	ensureIdxBinary();

	const raw = readFileSync(configPath, "utf8");
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	parsed.skillsVersion = SKILLS_VERSION;
	writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

	return true;
}
