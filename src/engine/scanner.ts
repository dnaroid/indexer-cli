import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { SystemLogger } from "../core/logger.js";
import { parseGitignore } from "../utils/gitignore.js";

const logger = new SystemLogger("scanner");

const SKIP_REaddir_CODES = new Set([
	"EINVAL",
	"EIO",
	"ENOENT",
	"EACCES",
	"EPERM",
	"EBUSY",
	"EMFILE",
	"ENFILE",
	"ENOTDIR",
]);

async function safeReaddir(
	dir: string,
	rootPath: string,
): Promise<
	Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (error: unknown) {
		if (
			typeof error === "object" &&
			error !== null &&
			SKIP_REaddir_CODES.has(Reflect.get(error, "code") as string)
		) {
			const relativeDir = relative(rootPath, dir).replace(/\\/g, "/");
			logger.warn("Skipping unreadable directory", {
				path: relativeDir || dir,
				code: Reflect.get(error, "code"),
				message: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
		throw error;
	}
}

export async function scanProjectFiles(
	rootPath: string,
	codeExtensions: string[],
): Promise<string[]> {
	const gitignore = parseGitignore(rootPath);
	const allowed = new Set(codeExtensions.map((ext) => ext.toLowerCase()));
	const files: string[] = [];
	const directories = [rootPath];

	while (directories.length > 0) {
		const currentDir = directories.pop();
		if (!currentDir) {
			continue;
		}

		const entries = await safeReaddir(currentDir, rootPath);
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			const relativePath = relative(rootPath, fullPath).replace(/\\/g, "/");

			if (!relativePath || relativePath === ".") {
				continue;
			}

			if (gitignore.ignores(relativePath)) {
				continue;
			}

			if (entry.isDirectory()) {
				directories.push(fullPath);
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			if (allowed.has(extname(relativePath).toLowerCase())) {
				files.push(relativePath);
			}
		}
	}

	files.sort((a, b) => a.localeCompare(b));
	return files;
}
