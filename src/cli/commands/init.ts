import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { LanceDbVectorStore } from "../../storage/vectors.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { ensureIndexed } from "./ensure-indexed.js";
import { SKILL_MD } from "./skill-template.js";

const HOOK_MARKER_START = "# >>> indexer-cli >>>";
const HOOK_MARKER_END = "# <<< indexer-cli <<<";
const HOOK_BLOCK = `\n${HOOK_MARKER_START}\nnohup npx indexer-cli index > /dev/null 2>&1 &\n${HOOK_MARKER_END}\n`;

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function writeClaudeSkill(projectRoot: string): Promise<void> {
	const skillDir = path.join(
		projectRoot,
		".claude",
		"skills",
		"repo-discovery",
	);
	await mkdir(skillDir, { recursive: true });
	const skillPath = path.join(skillDir, "SKILL.md");
	await writeFile(skillPath, SKILL_MD, "utf8");
	console.log(`  Skill: ${skillPath}`);
}

async function ensureGitignoreEntries(
	projectRoot: string,
	entries: string[],
): Promise<void> {
	const gitignorePath = path.join(projectRoot, ".gitignore");

	const missing = [...entries];

	if (await pathExists(gitignorePath)) {
		const current = await readFile(gitignorePath, "utf8");
		const lines = current.split(/\r?\n/).map((line) => line.trim());
		for (const entry of entries) {
			if (lines.includes(entry)) {
				missing.splice(missing.indexOf(entry), 1);
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

	console.log(`  Hook: ${hookPath}`);
}

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize indexer storage for a project")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.action(async () => {
			const resolvedProjectPath = process.cwd();
			const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
			const dbPath = path.join(dataDir, "db.sqlite");
			const vectorsPath = path.join(dataDir, "vectors");
			const configPath = path.join(dataDir, "config.json");

			initLogger(dataDir);
			config.load(dataDir);

			let metadata: SqliteMetadataStore | null = null;
			let vectors: LanceDbVectorStore | null = null;

			try {
				await mkdir(dataDir, { recursive: true });
				await mkdir(vectorsPath, { recursive: true });

				metadata = new SqliteMetadataStore(dbPath);
				await metadata.initialize();

				vectors = new LanceDbVectorStore({
					dbPath: vectorsPath,
					vectorSize: config.get("vectorSize"),
				});
				await vectors.initialize();

				await writeFile(
					configPath,
					`${JSON.stringify(config.getAll(), null, 2)}\n`,
					"utf8",
				);
				await ensureGitignoreEntries(resolvedProjectPath, [
					".indexer-cli/",
					".claude/",
				]);
				await ensurePostCommitHook(resolvedProjectPath);

				console.log(`Initialized indexer-cli in ${resolvedProjectPath}`);
				await writeClaudeSkill(resolvedProjectPath);
				console.log(`  SQLite: ${dbPath}`);
				console.log(`  Vectors: ${vectorsPath}`);
				console.log(`  Config: ${configPath}`);

				await ensureIndexed(metadata, resolvedProjectPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Failed to initialize project: ${message}`);
				process.exitCode = 1;
			} finally {
				if (metadata) {
					await metadata.close().catch(() => undefined);
				}
				if (vectors) {
					await vectors.close().catch(() => undefined);
				}
			}
		});
}
