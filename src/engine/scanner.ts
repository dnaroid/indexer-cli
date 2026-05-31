import { readdir, realpath, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { parseGitignore } from "../utils/gitignore.js";
import {
	matchesPathPatterns,
	mayContainPathPatternMatch,
	sanitizePathPatterns,
} from "../utils/path-patterns.js";

const SKIP_READDIR_CODES: ReadonlySet<string> = new Set([
	"EINVAL",
	"EIO",
	"ENOENT",
	"EACCES",
	"EPERM",
	"EBUSY",
	"ENOTDIR",
]);

function getErrorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null) {
		const code = Reflect.get(error, "code");
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

type ScanWarning = {
	path: string;
	code: string;
	message: string;
};

async function safeReaddir(
	dir: string,
	rootPath: string,
	onWarning?: (warning: ScanWarning) => void,
): Promise<
	Array<{
		name: string;
		isDirectory: () => boolean;
		isFile: () => boolean;
		isSymbolicLink?: () => boolean;
	}>
> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (error: unknown) {
		const code = getErrorCode(error);
		if (code && SKIP_READDIR_CODES.has(code) && dir !== rootPath) {
			const relativeDir = relative(rootPath, dir).replace(/\\/g, "/");
			onWarning?.({
				path: relativeDir || dir,
				code,
				message: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
		throw error;
	}
}

async function safeStat(
	path: string,
	rootPath: string,
	onWarning?: (warning: ScanWarning) => void,
) {
	try {
		return await stat(path);
	} catch (error: unknown) {
		const code = getErrorCode(error);
		if (code && SKIP_READDIR_CODES.has(code)) {
			const relativePath = relative(rootPath, path).replace(/\\/g, "/");
			onWarning?.({
				path: relativePath || path,
				code,
				message: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		throw error;
	}
}

async function safeRealpath(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

export type { ScanWarning };

export async function scanProjectFiles(
	rootPath: string,
	codeExtensions: string[],
	options?: {
		onWarning?: (warning: ScanWarning) => void;
		includePaths?: string[];
	},
): Promise<string[]> {
	const gitignore = parseGitignore(rootPath);
	const allowed = new Set(codeExtensions.map((ext) => ext.toLowerCase()));
	const includePaths = sanitizePathPatterns(options?.includePaths ?? []);
	const files: string[] = [];
	const directories = [rootPath];
	const visitedSymlinkDirectories = new Set<string>();

	while (directories.length > 0) {
		const currentDir = directories.pop();
		if (!currentDir) {
			continue;
		}

		const entries = await safeReaddir(currentDir, rootPath, options?.onWarning);
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			const relativePath = relative(rootPath, fullPath).replace(/\\/g, "/");

			if (!relativePath || relativePath === ".") {
				continue;
			}

			if (entry.isDirectory()) {
				if (
					gitignore.ignores(relativePath) &&
					!matchesPathPatterns(relativePath, includePaths) &&
					!mayContainPathPatternMatch(relativePath, includePaths)
				) {
					continue;
				}
				directories.push(fullPath);
				continue;
			}

			if (entry.isSymbolicLink?.()) {
				const mayMatchIncludePath =
					matchesPathPatterns(relativePath, includePaths) ||
					mayContainPathPatternMatch(relativePath, includePaths);

				if (!mayMatchIncludePath) {
					continue;
				}

				const targetStats = await safeStat(
					fullPath,
					rootPath,
					options?.onWarning,
				);
				if (!targetStats) {
					continue;
				}

				if (targetStats.isDirectory()) {
					if (
						gitignore.ignores(relativePath) &&
						!matchesPathPatterns(relativePath, includePaths) &&
						!mayContainPathPatternMatch(relativePath, includePaths)
					) {
						continue;
					}

					const resolvedPath = await safeRealpath(fullPath);
					if (resolvedPath) {
						if (visitedSymlinkDirectories.has(resolvedPath)) {
							continue;
						}
						visitedSymlinkDirectories.add(resolvedPath);
					}

					directories.push(fullPath);
					continue;
				}

				if (
					targetStats.isFile() &&
					allowed.has(extname(relativePath).toLowerCase()) &&
					(!gitignore.ignores(relativePath) ||
						matchesPathPatterns(relativePath, includePaths))
				) {
					files.push(relativePath);
				}
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			if (
				allowed.has(extname(relativePath).toLowerCase()) &&
				(!gitignore.ignores(relativePath) ||
					matchesPathPatterns(relativePath, includePaths))
			) {
				files.push(relativePath);
			}
		}
	}

	files.sort((a, b) => a.localeCompare(b));
	return files;
}
