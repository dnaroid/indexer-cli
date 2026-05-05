import { constants as fsConstants } from "node:fs";
import { access, lstat, rm, symlink } from "node:fs/promises";
import { accessSync } from "node:fs";
import path from "node:path";

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await access(targetPath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function isPiInstalled(): boolean {
	const pathValue = process.env.PATH;
	if (!pathValue) return false;

	const executableNames =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
					.split(";")
					.filter(Boolean)
					.map((extension) => `pi${extension.toLowerCase()}`)
			: ["pi"];

	for (const directory of pathValue.split(path.delimiter)) {
		for (const executableName of executableNames) {
			try {
				accessSync(path.join(directory, executableName), fsConstants.X_OK);
				return true;
			} catch {}
		}
	}

	return false;
}

export async function ensurePiSkillsSymlink(
	projectRoot: string,
	options: { silent?: boolean } = {},
): Promise<boolean> {
	if (!isPiInstalled()) {
		return false;
	}

	const claudeDir = path.join(projectRoot, ".claude");
	const piDir = path.join(projectRoot, ".pi");

	if (!(await pathExists(claudeDir))) {
		return false;
	}

	try {
		const piStat = await lstat(piDir);
		if (piStat.isSymbolicLink()) {
			await rm(piDir, { force: true });
		} else {
			return false;
		}
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? Reflect.get(error, "code")
				: undefined;
		if (code !== "ENOENT") {
			throw error;
		}
	}

	await symlink(".claude", piDir, "dir");
	if (!options.silent) {
		console.log(`  Pi skills: ${path.relative(projectRoot, piDir)} -> .claude`);
	}
	return true;
}

export async function removePiSkillsSymlink(projectRoot: string): Promise<boolean> {
	const piDir = path.join(projectRoot, ".pi");
	try {
		const piStat = await lstat(piDir);
		if (!piStat.isSymbolicLink()) {
			return false;
		}
		await rm(piDir, { force: true });
		console.log(`Removed ${piDir}`);
		return true;
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? Reflect.get(error, "code")
				: undefined;
		if (code === "ENOENT") {
			return false;
		}
		throw error;
	}
}