import { constants as fsConstants } from "node:fs";
import {
	access,
	chmod,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { PACKAGE_VERSION } from "../../core/version.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { SqliteVecVectorStore } from "../../storage/vectors.js";
import { ensureIndexed } from "./ensure-indexed.js";
import { GENERATED_SKILL_DIRECTORIES, GENERATED_SKILLS } from "./skills.js";
import { SKILLS_VERSION } from "../../core/skills-version.js";
import { installSpecTemplate } from "../spec-template.js";
import { addProject } from "../../core/registry.js";
import { resolveInitProjectRoot } from "../project-root.js";

const HOOK_MARKER_START = "# >>> indexer-cli >>>";
const HOOK_MARKER_END = "# <<< indexer-cli <<<";
const HOOK_BLOCK = `\n${HOOK_MARKER_START}\nnohup sh -c 'idx index --skip-if-locked > /dev/null 2>&1' &\n${HOOK_MARKER_END}\n`;

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

const DEFAULT_DEPRECATED_SKILL_DIRECTORIES = [
	"context-pack",
	"semantic-search",
	"repo-structure",
	"repo-architecture",
	"symbol-explain",
	"dependency-trace",
];

export type SkillTarget = "claude" | "codex";

const SKILL_TARGET_ROOTS: Record<SkillTarget, string[]> = {
	claude: [".claude", "skills"],
	codex: [".agents", "skills"],
};

function normalizeSkillTargets(targets: readonly SkillTarget[]): SkillTarget[] {
	return [...new Set(targets)].sort() as SkillTarget[];
}

function skillRoot(projectRoot: string, target: SkillTarget): string {
	return path.join(projectRoot, ...SKILL_TARGET_ROOTS[target]);
}

function skillIgnoreEntries(target: SkillTarget): string[] {
	const skillRootPath = SKILL_TARGET_ROOTS[target].join("/");
	return GENERATED_SKILL_DIRECTORIES.map(
		(directory) => `${skillRootPath}/${directory}/`,
	);
}

function normalizeRootIgnoreEntry(entry: string): string {
	const trimmed = entry.trim();
	return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

function configuredTargetsFromValue(value: unknown): SkillTarget[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return normalizeSkillTargets(
		value.filter(
			(item): item is SkillTarget => item === "claude" || item === "codex",
		),
	);
}

export async function detectInstalledSkillTargets(
	projectRoot: string,
): Promise<SkillTarget[]> {
	const targets: SkillTarget[] = [];
	for (const target of ["claude", "codex"] as const) {
		const generatedSkillPath = path.join(
			skillRoot(projectRoot, target),
			"repo-discovery",
			"SKILL.md",
		);
		if (await pathExists(generatedSkillPath)) targets.push(target);
	}
	return targets;
}

export async function getEnabledSkillTargets(
	projectRoot: string,
): Promise<SkillTarget[]> {
	const configPath = path.join(projectRoot, ".indexer-cli", "config.json");
	if (!(await pathExists(configPath))) return [];

	try {
		const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<
			string,
			unknown
		>;
		return configuredTargetsFromValue(parsed.skillTargets)
			?? await detectInstalledSkillTargets(projectRoot);
	} catch {
		return await detectInstalledSkillTargets(projectRoot);
	}
}

async function writeSkillsForTarget(
	projectRoot: string,
	target: SkillTarget,
	skills = GENERATED_SKILLS,
	options: { silent?: boolean } = {},
): Promise<void> {
	for (const skill of skills) {
		const skillDir = path.join(
			skillRoot(projectRoot, target),
			skill.directory,
		);
		await mkdir(skillDir, { recursive: true });
		const skillPath = path.join(skillDir, "SKILL.md");
		await writeFile(skillPath, skill.content, "utf8");
		if (!options.silent) {
			console.log(`  Skill: ${path.relative(projectRoot, skillPath)}`);
		}
	}
}

export async function refreshSkillsForTarget(
	projectRoot: string,
	target: SkillTarget,
	skillDirectories = GENERATED_SKILL_DIRECTORIES,
	skills = GENERATED_SKILLS,
	deprecatedSkillDirectories = target === "claude"
		? DEFAULT_DEPRECATED_SKILL_DIRECTORIES
		: [],
	options: { silent?: boolean } = {},
): Promise<void> {
	for (const skillDirectory of [
		...skillDirectories,
		...deprecatedSkillDirectories,
	]) {
		const skillDir = path.join(
			skillRoot(projectRoot, target),
			skillDirectory,
		);
		if (await pathExists(skillDir)) {
			await rm(skillDir, { recursive: true, force: true });
			if (!options.silent) {
				console.log(
					`  Removed stale skill: ${path.relative(projectRoot, skillDir)}`,
				);
			}
		}
	}

	await writeSkillsForTarget(projectRoot, target, skills, options);
}

export async function refreshSkillTargets(
	projectRoot: string,
	targets: readonly SkillTarget[],
	options: { silent?: boolean } = {},
): Promise<void> {
	for (const target of normalizeSkillTargets(targets)) {
		await refreshSkillsForTarget(
			projectRoot,
			target,
			GENERATED_SKILL_DIRECTORIES,
			GENERATED_SKILLS,
			undefined,
			options,
		);
	}
}

async function ensureGitignoreEntries(
	projectRoot: string,
	entries: string[],
): Promise<void> {
	const gitignorePath = path.join(projectRoot, ".gitignore");

	const missing = [...new Set(entries)];

	if (await pathExists(gitignorePath)) {
		const current = await readFile(gitignorePath, "utf8");
		const lines = new Set(
			current
				.split(/\r?\n/)
				.map((line) => normalizeRootIgnoreEntry(line)),
		);
		for (const entry of entries) {
			if (lines.has(normalizeRootIgnoreEntry(entry))) {
				const index = missing.indexOf(entry);
				if (index >= 0) missing.splice(index, 1);
			}
		}
		if (missing.length === 0) {
			return;
		}
		const nextContent = current.endsWith("\n")
			? `${current}${missing.join("\n")}\n`
			: `${current}\n${missing.join("\n")}\n`;
		await writeFile(gitignorePath, nextContent, "utf8");
		return;
	}

	await writeFile(gitignorePath, `${missing.join("\n")}\n`, "utf8");
}

async function persistSkillTargets(
	projectRoot: string,
	targets: readonly SkillTarget[],
): Promise<void> {
	const configPath = path.join(projectRoot, ".indexer-cli", "config.json");
	if (!(await pathExists(configPath))) {
		throw new Error(`Project is not initialized: ${projectRoot}`);
	}
	const parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<
		string,
		unknown
	>;
	parsed.skillTargets = normalizeSkillTargets(targets);
	parsed.skillsVersion = SKILLS_VERSION;
	await writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

export async function installSkillTargets(
	projectRoot: string,
	requestedTargets: readonly SkillTarget[],
	options: { silent?: boolean } = {},
): Promise<SkillTarget[]> {
	const requested = normalizeSkillTargets(requestedTargets);
	if (requested.length === 0) {
		throw new Error("Select at least one skill target: --claude and/or --codex.");
	}
	const enabled = normalizeSkillTargets([
		...(await getEnabledSkillTargets(projectRoot)),
		...requested,
	]);
	await ensureGitignoreEntries(
		projectRoot,
		[".indexer-cli/", ...requested.flatMap(skillIgnoreEntries)],
	);
	await refreshSkillTargets(projectRoot, requested, options);
	await persistSkillTargets(projectRoot, enabled);
	return enabled;
}

export async function refreshEnabledSkillTargets(
	projectRoot: string,
	options: { silent?: boolean } = {},
): Promise<SkillTarget[]> {
	const enabled = await getEnabledSkillTargets(projectRoot);
	await ensureGitignoreEntries(projectRoot, [
		".indexer-cli/",
		...enabled.flatMap(skillIgnoreEntries),
	]);
	await refreshSkillTargets(projectRoot, enabled, options);
	await persistSkillTargets(projectRoot, enabled);
	return enabled;
}

async function ensurePostCommitHook(projectRoot: string): Promise<void> {
	const gitDir = path.join(projectRoot, ".git");
	if (!(await pathExists(gitDir))) return;

	const hookPath = path.join(gitDir, "hooks", "post-commit");
	await mkdir(path.dirname(hookPath), { recursive: true });

	if (await pathExists(hookPath)) {
		const current = await readFile(hookPath, "utf8");
		if (current.includes(HOOK_MARKER_START)) return;
		const nextContent = current.endsWith("\n")
			? `${current}${HOOK_BLOCK}`
			: `${current}\n${HOOK_BLOCK}`;
		await writeFile(hookPath, nextContent, "utf8");
	} else {
		await writeFile(hookPath, `#!/bin/sh${HOOK_BLOCK}`, "utf8");
		await chmod(hookPath, 0o755);
	}

	console.log(`  Hook: ${path.relative(projectRoot, hookPath)}`);
}

export async function performInit(
	projectRoot: string,
	options?: {
		refreshSkills?: boolean;
		skipIndexing?: boolean;
		skillTargets?: SkillTarget[];
	},
): Promise<void> {
	const dataDir = path.join(projectRoot, ".indexer-cli");
	const dbPath = path.join(dataDir, "db.sqlite");
	const configPath = path.join(dataDir, "config.json");

	initLogger(dataDir);
	config.load(dataDir);

	let metadata: SqliteMetadataStore | null = null;
	let vectors: SqliteVecVectorStore | null = null;

	try {
		await mkdir(dataDir, { recursive: true });

		metadata = new SqliteMetadataStore(dbPath);
		await metadata.initialize();

		vectors = new SqliteVecVectorStore({
			dbPath,
			vectorSize: config.get("vectorSize"),
		});
		await vectors.initialize();

		let existingConfig: Record<string, unknown> = {};
		if (await pathExists(configPath)) {
			try {
				existingConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
			} catch {
				existingConfig = {};
			}
		}
		const configuredTargets = Array.isArray(existingConfig.skillTargets)
			? existingConfig.skillTargets.filter(
					(value): value is SkillTarget => value === "claude" || value === "codex",
				)
			: await detectInstalledSkillTargets(projectRoot);
		const requestedTargets = normalizeSkillTargets(options?.skillTargets ?? []);
		const enabledTargets = normalizeSkillTargets([
			...configuredTargets,
			...requestedTargets,
		]);

		await writeFile(
			configPath,
			`${JSON.stringify({
				...config.getAll(),
				version: PACKAGE_VERSION,
				skillsVersion: SKILLS_VERSION,
				skillTargets: enabledTargets,
			}, null, 2)}\n`,
			"utf8",
		);
		const gitignoreTargets = options?.refreshSkills
			? enabledTargets
			: requestedTargets;
		await ensureGitignoreEntries(projectRoot, [
			".indexer-cli/",
			...gitignoreTargets.flatMap(skillIgnoreEntries),
		]);
		await ensurePostCommitHook(projectRoot);
		const specTemplatePath = await installSpecTemplate(dataDir);

		const displayRoot = path.relative(process.cwd(), projectRoot) || ".";
		console.log(`Initialized indexer-cli in ${displayRoot}`);
		const targetsToWrite = options?.refreshSkills
			? enabledTargets
			: requestedTargets;
		if (targetsToWrite.length > 0) {
			await refreshSkillTargets(projectRoot, targetsToWrite);
			console.log(
				"  Restart the selected coding agent(s) to pick up skill changes.",
			);
		}
		console.log(`  SQLite: ${path.relative(projectRoot, dbPath)}`);
		console.log(`  Config: ${path.relative(projectRoot, configPath)}`);
		console.log(`  Spec template: ${path.relative(projectRoot, specTemplatePath)} (copy to any document directory)`);

		if (!options?.skipIndexing) {
			console.log(
				"Starting initial index. This may start Ollama and download/create the jina-8k embedding model on first run.",
			);
			console.log(
				"Tip: run `idx --no-auto-update doctor <projectPath>` if you need to verify dependencies separately.",
			);
			const indexResult = await ensureIndexed(metadata, projectRoot);
			if (indexResult.status === "failed") {
				throw new Error(`Initial indexing failed: ${indexResult.message}`);
			}
		}
	} finally {
		if (metadata) {
			await metadata.close().catch(() => undefined);
		}
		if (vectors) {
			await vectors.close().catch(() => undefined);
		}
	}
}

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize indexer storage for a project")
		.option("--claude", "install/enable the repo-discovery skill for Claude Code")
		.option("--codex", "install/enable the repo-discovery skill for OpenAI Codex")
		.option(
			"--refresh-skills",
			"refresh already enabled skills (plus any --claude/--codex targets supplied now)",
		)
		.action(async (options?: { refreshSkills?: boolean; claude?: boolean; codex?: boolean }) => {
			try {
				const { projectRoot, notice } = resolveInitProjectRoot();
				if (notice) {
					console.log(notice);
				}

				await performInit(projectRoot, {
					refreshSkills: options?.refreshSkills,
					skillTargets: [
						...(options?.claude ? ["claude" as const] : []),
						...(options?.codex ? ["codex" as const] : []),
					],
				});
				addProject({
					projectPath: projectRoot,
					cliVersion: PACKAGE_VERSION,
					skillsVersion: SKILLS_VERSION,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Failed to initialize project: ${message}`);
				console.error(
					"Initialization may need Ollama, the jina-8k model, or a longer first-run setup. Try `idx --no-auto-update doctor .` for a guided dependency check.",
				);
				process.exitCode = 1;
			}
		});
}
