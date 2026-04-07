import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { setLogLevel } from "../../core/logger.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { LanceDbVectorStore } from "../../storage/vectors.js";

type CliColors = {
	green(text: string): string;
	red(text: string): string;
	gray(text: string): string;
};

async function loadChalk(): Promise<CliColors> {
	return (await import("chalk")).default as unknown as CliColors;
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function ensureGitignoreEntry(projectRoot: string): Promise<void> {
	const gitignorePath = path.join(projectRoot, ".gitignore");
	const entry = ".indexer-cli/";

	if (!(await pathExists(gitignorePath))) {
		await writeFile(gitignorePath, `${entry}\n`, "utf8");
		return;
	}

	const current = await readFile(gitignorePath, "utf8");
	const lines = current.split(/\r?\n/).map((line) => line.trim());
	if (lines.includes(entry)) {
		return;
	}

	const nextContent = current.endsWith("\n")
		? `${current}${entry}\n`
		: `${current}\n${entry}\n`;
	await writeFile(gitignorePath, nextContent, "utf8");
}

export function registerInitCommand(program: Command): void {
	program
		.command("init")
		.description("Initialize indexer storage for a project")
		.action(async () => {
			const chalk = await loadChalk();
			const resolvedProjectPath = process.cwd();
			const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
			const dbPath = path.join(dataDir, "db.sqlite");
			const vectorsPath = path.join(dataDir, "vectors");
			const configPath = path.join(dataDir, "config.json");

			setLogLevel("error");

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
				await ensureGitignoreEntry(resolvedProjectPath);

				const existingProject = (await metadata.listProjects()).find(
					(project) =>
						path.resolve(project.workdir) === resolvedProjectPath ||
						path.resolve(project.repoRoot) === resolvedProjectPath,
				);

				const sourceType = (await pathExists(
					path.join(resolvedProjectPath, ".git"),
				))
					? "local"
					: "local-nogit";

				const project =
					existingProject ??
					(await metadata.createProject({
						name: path.basename(resolvedProjectPath),
						sourceType,
						repoRoot: resolvedProjectPath,
						workdir: resolvedProjectPath,
					}));

				console.log(
					chalk.green(`Initialized indexer-cli in ${resolvedProjectPath}`),
				);
				console.log(chalk.gray(`Project ID: ${project.id}`));
				console.log(chalk.gray(`SQLite: ${dbPath}`));
				console.log(chalk.gray(`Vectors: ${vectorsPath}`));
				console.log(chalk.gray(`Config: ${configPath}`));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Failed to initialize project: ${message}`));
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
