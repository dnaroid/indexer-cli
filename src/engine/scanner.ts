import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { parseGitignore } from "../utils/gitignore.js";

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
	Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
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

export type { ScanWarning };

export async function scanProjectFiles(
	rootPath: string,
	codeExtensions: string[],
	options?: {
		onWarning?: (warning: ScanWarning) => void;
	},
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

		const entries = await safeReaddir(currentDir, rootPath, options?.onWarning);
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
