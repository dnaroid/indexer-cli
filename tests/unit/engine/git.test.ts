import { beforeEach, describe, expect, it, vi } from "vitest";
import { SimpleGitOperations } from "../../../src/engine/git.js";

const { execSyncMock } = vi.hoisted(() => ({
	execSyncMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execSync: execSyncMock,
	};
});

describe("SimpleGitOperations", () => {
	beforeEach(() => {
		execSyncMock.mockReset();
	});

	it("reads the current HEAD commit hash", async () => {
		execSyncMock.mockReturnValue("0123456789abcdef0123456789abcdef01234567\n");
		const git = new SimpleGitOperations();

		await expect(git.getHeadCommit("/repo")).resolves.toBe(
			"0123456789abcdef0123456789abcdef01234567",
		);
		expect(execSyncMock).toHaveBeenCalledWith("git rev-parse HEAD", {
			cwd: "/repo",
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	});

	it("reports whether the repository is dirty from porcelain output", async () => {
		const git = new SimpleGitOperations();

		execSyncMock.mockReturnValueOnce("");
		await expect(git.isDirty("/repo")).resolves.toBe(false);

		execSyncMock.mockReturnValueOnce(" M src/index.ts\n");
		await expect(git.isDirty("/repo")).resolves.toBe(true);
	});

	it("returns added, modified, and deleted files since a commit", async () => {
		execSyncMock.mockReturnValue(
			[
				"A src/new.ts",
				"M src/updated.ts",
				"D src/removed.ts",
				"R100 src/old.ts src/renamed.ts",
			].join("\n"),
		);
		const git = new SimpleGitOperations();

		await expect(git.getChangedFiles("/repo", "deadbeef")).resolves.toEqual({
			added: ["src/new.ts"],
			modified: ["src/updated.ts", "src/renamed.ts"],
			deleted: ["src/removed.ts"],
		});
	});

	it("aggregates churn by file from git numstat output", async () => {
		execSyncMock.mockReturnValue(
			[
				"10 2 src/index.ts",
				"3 1 src/index.ts",
				"- - assets/logo.png",
				"1 0 src/util.ts",
			].join("\n"),
		);
		const git = new SimpleGitOperations();

		await expect(
			git.getChurnByFile("/repo", { sinceDays: 7 }),
		).resolves.toEqual({
			"assets/logo.png": 0,
			"src/index.ts": 16,
			"src/util.ts": 1,
		});
		expect(execSyncMock).toHaveBeenCalledWith(
			'git log --since="7 days ago" --numstat --format=',
			{
				cwd: "/repo",
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	});

	it("returns safe fallbacks when git commands fail", async () => {
		execSyncMock.mockImplementation(() => {
			throw new Error("git failed");
		});
		const git = new SimpleGitOperations();

		await expect(git.getHeadCommit("/repo")).resolves.toBeNull();
		await expect(git.isDirty("/repo")).resolves.toBe(false);
		await expect(git.getChangedFiles("/repo", "deadbeef")).resolves.toEqual({
			added: [],
			modified: [],
			deleted: [],
		});
		await expect(
			git.getChurnByFile("/repo", { sinceDays: 7 }),
		).resolves.toEqual({});
	});

	it("returns empty change buckets when git diff output is empty", async () => {
		execSyncMock.mockReturnValue("");
		const git = new SimpleGitOperations();

		await expect(git.getChangedFiles("/repo", "deadbeef")).resolves.toEqual({
			added: [],
			modified: [],
			deleted: [],
		});
	});

	it("returns an empty churn map when git log output is empty", async () => {
		execSyncMock.mockReturnValue("");
		const git = new SimpleGitOperations();

		await expect(git.getChurnByFile("/repo")).resolves.toEqual({});
	});

	it("returns null for empty HEAD output and ignores malformed diff and churn rows", async () => {
		execSyncMock
			.mockReturnValueOnce("")
			.mockReturnValueOnce(["", "M", "M src/kept.ts"].join("\n"))
			.mockReturnValueOnce(["bad row", "7 nope src/file.ts"].join("\n"));
		const git = new SimpleGitOperations();

		await expect(git.getHeadCommit("/repo")).resolves.toBeNull();
		await expect(git.getChangedFiles("/repo", "deadbeef")).resolves.toEqual({
			added: [],
			modified: ["src/kept.ts"],
			deleted: [],
		});
		await expect(git.getChurnByFile("/repo")).resolves.toEqual({
			"src/file.ts": 7,
		});
	});
});
