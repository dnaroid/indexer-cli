import { constants as fsConstants } from "node:fs";
import {
	access,
	readdir,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import {
	DEPRECATED_SKILL_DIRECTORIES,
	GENERATED_SKILL_DIRECTORIES,
} from "./skills.js";

const HOOK_MARKER_START = "# >>> indexer-cli >>>";
const HOOK_MARKER_END = "# <<< indexer-cli <<<";

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function isDirEmpty(dirPath: string): Promise<boolean> {
	const entries = await readdir(dirPath);
	return entries.length === 0;
}

async function removeClaudeSkill(projectRoot: string): Promise<void> {
	for (const skillDirectory of [
		...GENERATED_SKILL_DIRECTORIES,
		...DEPRECATED_SKILL_DIRECTORIES,
	]) {
		const skillDir = path.join(
			projectRoot,
			".claude",
			"skills",
			skillDirectory,
		);
		if (await pathExists(skillDir)) {
			await rm(skillDir, { recursive: true, force: true });
			console.log(`Removed ${skillDir}`);
		}
	}

	const skillsDir = path.join(projectRoot, ".claude", "skills");
	if (await pathExists(skillsDir)) {
		try {
			if (await isDirEmpty(skillsDir)) {
				await rm(skillsDir, { recursive: true, force: true });
			}
		} catch {}
	}

	const claudeDir = path.join(projectRoot, ".claude");
	if (await pathExists(claudeDir)) {
		try {
			if (await isDirEmpty(claudeDir)) {
				await rm(claudeDir, { recursive: true, force: true });
				console.log(`Removed empty ${claudeDir}`);
			}
		} catch {}
	}
}

async function removeFromGitignore(
	projectRoot: string,
	entries: string[],
): Promise<void> {
	const gitignorePath = path.join(projectRoot, ".gitignore");
	if (!(await pathExists(gitignorePath))) return;

	const current = await readFile(gitignorePath, "utf8");
	const lines = current.split(/\r?\n/);
	const entrySet = new Set(entries);
	const filtered = lines.filter((line) => !entrySet.has(line.trim()));

	while (filtered.length > 0 && filtered[filtered.length - 1] === "") {
		filtered.pop();
	}
	filtered.push("");

	const nextContent = filtered.join("\n");
	if (nextContent !== current) {
		await writeFile(gitignorePath, nextContent, "utf8");
		console.log(`Updated ${gitignorePath}`);
	}
}

async function removePostCommitHook(projectRoot: string): Promise<void> {
	const hookPath = path.join(projectRoot, ".git", "hooks", "post-commit");
	if (!(await pathExists(hookPath))) return;

	const current = await readFile(hookPath, "utf8");

	if (!current.includes(HOOK_MARKER_START)) return;

	const startIdx = current.indexOf(HOOK_MARKER_START);
	const endIdx = current.indexOf(HOOK_MARKER_END);
	if (endIdx === -1) return;

	const afterBlock = current.slice(endIdx + HOOK_MARKER_END.length);
	let cleaned = current.slice(0, startIdx) + afterBlock;
	cleaned = cleaned.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");

	if (cleaned.trim() === "" || cleaned.trim() === "#!/bin/sh") {
		await unlink(hookPath);
		console.log(`Removed ${hookPath}`);
	} else {
		await writeFile(hookPath, cleaned, "utf8");
		console.log(`Cleaned ${hookPath}`);
	}
}

export async function performUninstall(projectRoot: string): Promise<void> {
	const dataDir = path.join(projectRoot, ".indexer-cli");

	if (!(await pathExists(dataDir))) {
		console.log(`Nothing to remove at ${dataDir}`);
		return;
	}

	await rm(dataDir, { recursive: true, force: true });
	console.log(`Removed ${dataDir}`);

	await removeClaudeSkill(projectRoot);
	await removeFromGitignore(projectRoot, [".indexer-cli/", ".claude/"]);
	await removePostCommitHook(projectRoot);
}

export function registerUninstallCommand(program: Command): void {
	program
		.command("uninstall")
		.description("Remove indexer data for a project")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option("-f, --force", "Skip confirmation prompt")
		.action(async (options: { force?: boolean }) => {
			const projectRoot = process.cwd();
			const dataDir = path.join(projectRoot, ".indexer-cli");

			if (!(await pathExists(dataDir))) {
				console.log(`Nothing to remove at ${dataDir}`);
				return;
			}

			if (!options.force) {
				const rl = createInterface({ input, output });

				try {
					const answer = await rl.question(`Delete ${dataDir}? [y/N] `);
					if (!/^y(es)?$/i.test(answer.trim())) {
						console.log("Uninstall cancelled.");
						return;
					}
				} finally {
					rl.close();
				}
			}

			try {
				await performUninstall(projectRoot);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Uninstall failed: ${message}`);
				process.exitCode = 1;
			}
		});
}
