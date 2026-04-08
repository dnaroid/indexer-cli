import { execSync } from "node:child_process";
import type { GitDiff, GitOperations } from "../core/types.js";

function runGit(repoRoot: string, args: string[]): string {
	return execSync(`git ${args.join(" ")}`, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function normalizePath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function createEmptyDiff(): GitDiff {
	return {
		added: [],
		modified: [],
		deleted: [],
	};
}

function sortDiff(diff: GitDiff): GitDiff {
	return {
		added: [...diff.added].sort(),
		modified: [...diff.modified].sort(),
		deleted: [...diff.deleted].sort(),
	};
}

function pushUnique(target: string[], filePath: string): void {
	if (!target.includes(filePath)) {
		target.push(filePath);
	}
}

function parseRenamePaths(rawPath: string): {
	fromPath: string;
	toPath: string;
} | null {
	const arrowIndex = rawPath.lastIndexOf(" -> ");
	if (arrowIndex >= 0) {
		const fromPath = normalizePath(rawPath.slice(0, arrowIndex));
		const toPath = normalizePath(rawPath.slice(arrowIndex + 4));
		return fromPath && toPath ? { fromPath, toPath } : null;
	}

	const tabParts = rawPath.split("\t");
	if (tabParts.length >= 2) {
		const fromPath = normalizePath(tabParts[0] ?? "");
		const toPath = normalizePath(tabParts[tabParts.length - 1] ?? "");
		return fromPath && toPath ? { fromPath, toPath } : null;
	}

	const spaceParts = rawPath.split(/\s+/).filter(Boolean);
	if (spaceParts.length >= 2) {
		const fromPath = normalizePath(spaceParts[0] ?? "");
		const toPath = normalizePath(spaceParts[spaceParts.length - 1] ?? "");
		return fromPath && toPath ? { fromPath, toPath } : null;
	}

	return null;
}

function parseDiffLine(diff: GitDiff, status: string, rawPath: string): void {
	const normalizedStatus = status.trim();
	if (normalizedStatus.startsWith("R")) {
		const renamePaths = parseRenamePaths(rawPath);
		if (!renamePaths) {
			return;
		}

		pushUnique(diff.deleted, renamePaths.fromPath);
		pushUnique(diff.added, renamePaths.toPath);
		return;
	}

	const normalizedPath = normalizePath(rawPath);
	if (!normalizedPath) {
		return;
	}

	if (normalizedStatus.startsWith("A")) {
		pushUnique(diff.added, normalizedPath);
		return;
	}

	if (normalizedStatus.startsWith("D")) {
		pushUnique(diff.deleted, normalizedPath);
		return;
	}

	pushUnique(diff.modified, normalizedPath);
}

export function mergeGitDiffs(...diffs: GitDiff[]): GitDiff {
	const states = new Map<string, "added" | "modified" | "deleted">();

	for (const diff of diffs) {
		for (const filePath of diff.deleted) {
			states.set(filePath, "deleted");
		}

		for (const filePath of diff.added) {
			states.set(filePath, "added");
		}

		for (const filePath of diff.modified) {
			if (states.get(filePath) !== "added") {
				states.set(filePath, "modified");
			}
		}
	}

	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];

	for (const [filePath, state] of states.entries()) {
		if (state === "added") {
			added.push(filePath);
		} else if (state === "modified") {
			modified.push(filePath);
		} else {
			deleted.push(filePath);
		}
	}

	return {
		added: added.sort(),
		modified: modified.sort(),
		deleted: deleted.sort(),
	};
}

export class SimpleGitOperations implements GitOperations {
	async getHeadCommit(repoRoot: string): Promise<string | null> {
		try {
			const commit = runGit(repoRoot, ["rev-parse", "HEAD"]);
			return commit.length > 0 ? commit : null;
		} catch {
			return null;
		}
	}

	async isDirty(repoRoot: string): Promise<boolean> {
		try {
			return runGit(repoRoot, ["status", "--porcelain"]).length > 0;
		} catch {
			return false;
		}
	}

	async getChangedFiles(
		repoRoot: string,
		sinceCommit: string,
	): Promise<GitDiff> {
		try {
			const output = runGit(repoRoot, [
				"diff",
				"--name-status",
				`${sinceCommit}..HEAD`,
			]);
			const diff = createEmptyDiff();

			if (!output) {
				return diff;
			}

			for (const line of output.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				const [status, ...rest] = trimmed.split(/\s+/);
				const rawPath = rest.join(" ");
				parseDiffLine(diff, status ?? "", rawPath);
			}

			return sortDiff(diff);
		} catch {
			return createEmptyDiff();
		}
	}

	async getWorkingTreeChanges(repoRoot: string): Promise<GitDiff> {
		try {
			const output = runGit(repoRoot, [
				"status",
				"--porcelain",
				"--untracked-files=all",
			]);
			const diff = createEmptyDiff();

			if (!output) {
				return diff;
			}

			for (const line of output.split(/\r?\n/)) {
				const match = line.match(/^(.{1,2})\s+(.+)$/);
				if (!match) {
					continue;
				}

				const status = match[1].padStart(2, " ");
				const rawPath = match[2].trim();
				if (!rawPath) {
					continue;
				}

				if (status === "??") {
					pushUnique(diff.added, normalizePath(rawPath));
					continue;
				}

				if (status.includes("R")) {
					const renamePaths = parseRenamePaths(rawPath);
					if (!renamePaths) {
						continue;
					}

					pushUnique(diff.deleted, renamePaths.fromPath);
					pushUnique(diff.added, renamePaths.toPath);
					continue;
				}

				const normalizedPath = normalizePath(rawPath);
				if (!normalizedPath) {
					continue;
				}

				if (status.includes("D")) {
					pushUnique(diff.deleted, normalizedPath);
					continue;
				}

				if (status.includes("A")) {
					pushUnique(diff.added, normalizedPath);
					continue;
				}

				pushUnique(diff.modified, normalizedPath);
			}

			return sortDiff(diff);
		} catch {
			return createEmptyDiff();
		}
	}

	async getChurnByFile(
		repoRoot: string,
		options?: { sinceDays?: number },
	): Promise<Record<string, number>> {
		const sinceDays = Math.max(1, options?.sinceDays ?? 30);

		try {
			const output = runGit(repoRoot, [
				"log",
				`--since=${JSON.stringify(`${sinceDays} days ago`)}`,
				"--numstat",
				"--format=",
			]);

			const churn: Record<string, number> = {};
			if (!output) {
				return churn;
			}

			for (const line of output.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				const match = trimmed.match(/^(\S+)\s+(\S+)\s+(.+)$/);
				if (!match) continue;

				const added = match[1] === "-" ? 0 : Number.parseInt(match[1], 10) || 0;
				const removed =
					match[2] === "-" ? 0 : Number.parseInt(match[2], 10) || 0;
				const filePath = normalizePath(match[3]);
				churn[filePath] = (churn[filePath] ?? 0) + added + removed;
			}

			return churn;
		} catch {
			return {};
		}
	}
}
