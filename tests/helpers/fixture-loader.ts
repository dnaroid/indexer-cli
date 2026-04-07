import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const FIXTURES_ROOT = join(
	__dirname,
	"..",
	"..",
	"fixtures",
	"projects",
);

export function readFixtureFile(relativePath: string): string {
	const fullPath = join(FIXTURES_ROOT, relativePath);
	return readFileSync(fullPath, "utf-8");
}

export function readFixtureAsSource(relativePath: string) {
	return {
		path: relativePath,
		content: readFixtureFile(relativePath),
	};
}

export function listFixtureFiles(projectName: string): string[] {
	const projectDir = join(FIXTURES_ROOT, projectName);
	const files: string[] = [];

	function walk(dir: string) {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
			} else {
				files.push(relative(projectDir, full));
			}
		}
	}

	walk(projectDir);
	return files;
}
