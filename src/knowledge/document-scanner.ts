import { config } from "../core/config.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { scanProjectFiles } from "../engine/scanner.js";
import { matchesPathPatterns } from "../utils/path-patterns.js";

export interface DocumentScanOptions {
	extensions?: string[];
	includePaths?: string[];
	excludePaths?: string[];
	onWarning?: (warning: { path: string; code: string; message: string }) => void;
}

export async function scanProjectDocuments(
	rootPath: string,
	options: DocumentScanOptions = {},
): Promise<string[]> {
	const extensions = options.extensions ?? config.get("documentExtensions");
	const includePaths = options.includePaths ?? config.get("documentIncludePaths");
	const excludePaths = options.excludePaths ?? config.get("documentExcludePaths");
	const paths = await scanProjectFiles(rootPath, extensions, {
		onWarning: options.onWarning,
		includePaths,
	});

	const result: string[] = [];
	const root = await realpath(rootPath);
	for (const filePath of paths) {
		const explicitlyIncluded = matchesPathPatterns(filePath, includePaths);
		if (!explicitlyIncluded && matchesPathPatterns(filePath, excludePaths)) {
			continue;
		}
		try {
			const target = await realpath(path.join(rootPath, filePath));
			const relative = path.relative(root, target);
			if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
				options.onWarning?.({ path: filePath, code: "OUTSIDE_PROJECT", message: "Document target is outside the project root." });
				continue;
			}
		} catch {
			options.onWarning?.({ path: filePath, code: "UNREADABLE_DOCUMENT", message: "Document target is unavailable." });
			continue;
		}
		result.push(filePath);
	}

	return result.sort((left, right) => left.localeCompare(right));
}
