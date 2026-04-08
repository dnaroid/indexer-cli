import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { LanceDbVectorStore } from "../../storage/vectors.js";
import { ensureIndexed } from "./ensure-indexed.js";
import { CLAUDE_MD, SKILL_MD } from "./skill-template.js";

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
		"semantic-search",
	);
	await mkdir(skillDir, { recursive: true });
	const skillPath = path.join(skillDir, "SKILL.md");
	await writeFile(skillPath, SKILL_MD, "utf8");
	console.log(`  Skill: ${skillPath}`);
}

async function ensureClaudeGuide(projectRoot: string): Promise<void> {
	const claudePath = path.join(projectRoot, "CLAUDE.md");
	if (await pathExists(claudePath)) {
		console.log(`  CLAUDE guide: kept existing ${claudePath}`);
		return;
	}

	await writeFile(claudePath, CLAUDE_MD, "utf8");
	console.log(`  CLAUDE guide: ${claudePath}`);
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

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize indexer storage for a project")
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

				console.log(`Initialized indexer-cli in ${resolvedProjectPath}`);
				await writeClaudeSkill(resolvedProjectPath);
				await ensureClaudeGuide(resolvedProjectPath);
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
