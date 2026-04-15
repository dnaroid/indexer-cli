import { existsSync } from "node:fs";
import path from "node:path";

export type ResolvedProjectRoot = {
	projectRoot: string;
	notice?: string;
};

function hasIndexerData(dir: string): boolean {
	return existsSync(path.join(dir, ".indexer-cli", "config.json"));
}

function hasGitDir(dir: string): boolean {
	return existsSync(path.join(dir, ".git"));
}

function walkUp(
	startDir: string,
	predicate: (dir: string) => boolean,
): string | null {
	let current = path.resolve(startDir);

	while (true) {
		if (predicate(current)) {
			return current;
		}

		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}

		current = parent;
	}
}

function formatAutoDetectedNotice(projectRoot: string): string {
	return `Detected indexer-cli project root at ${projectRoot}. Running there instead of the current directory.`;
}

export function resolveInitializedProjectRoot(
	cwd: string = process.cwd(),
): ResolvedProjectRoot {
	const normalizedCwd = path.resolve(cwd);
	const indexedRoot = walkUp(normalizedCwd, hasIndexerData);

	if (indexedRoot) {
		return indexedRoot === normalizedCwd
			? { projectRoot: indexedRoot }
			: {
					projectRoot: indexedRoot,
					notice: formatAutoDetectedNotice(indexedRoot),
				};
	}

	const gitRoot = walkUp(normalizedCwd, hasGitDir);
	if (gitRoot) {
		throw new Error(
			gitRoot === normalizedCwd
				? `No indexer-cli project data found in ${gitRoot}. Run \`idx init\` here first.`
				: `No indexer-cli project data found from ${normalizedCwd} upwards. Detected Git root at ${gitRoot}. Run \`idx init\` there first.`,
		);
	}

	throw new Error(
		`No initialized indexer-cli project found from ${normalizedCwd} upwards. Run \`idx init\` in the project root first.`,
	);
}

export function resolveInitProjectRoot(
	cwd: string = process.cwd(),
): ResolvedProjectRoot {
	const normalizedCwd = path.resolve(cwd);
	const indexedRoot = walkUp(normalizedCwd, hasIndexerData);

	if (indexedRoot) {
		return indexedRoot === normalizedCwd
			? { projectRoot: indexedRoot }
			: {
					projectRoot: indexedRoot,
					notice: formatAutoDetectedNotice(indexedRoot),
				};
	}

	const gitRoot = walkUp(normalizedCwd, hasGitDir);
	if (gitRoot && gitRoot !== normalizedCwd) {
		return {
			projectRoot: gitRoot,
			notice: `Detected Git project root at ${gitRoot}. Initializing there instead of the current directory.`,
		};
	}

	return { projectRoot: normalizedCwd };
}
