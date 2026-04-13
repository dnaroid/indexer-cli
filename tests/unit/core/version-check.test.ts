import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSemver } from "../../../src/core/version-check.js";

const { uninstallMock, initMock, refreshSkillsMock, mockSkillsVersion } =
	vi.hoisted(() => ({
		uninstallMock: vi.fn(),
		initMock: vi.fn(),
		refreshSkillsMock: vi.fn(),
		mockSkillsVersion: 999999,
	}));

vi.mock("../../../src/cli/commands/uninstall.js", () => ({
	performUninstall: uninstallMock,
}));

vi.mock("../../../src/cli/commands/init.js", () => ({
	performInit: initMock,
	refreshClaudeSkills: refreshSkillsMock,
}));

vi.mock("../../../src/core/version.js", () => ({
	PACKAGE_VERSION: "0.5.0",
}));

vi.mock("../../../src/core/skills-version.js", () => ({
	SKILLS_VERSION: mockSkillsVersion,
}));

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "version-check-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeConfig(tempDir: string, content: string): void {
	const configDir = path.join(tempDir, ".indexer-cli");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(path.join(configDir, "config.json"), content, "utf8");
}

afterEach(async () => {
	vi.restoreAllMocks();
	uninstallMock.mockReset();
	initMock.mockReset();
	refreshSkillsMock.mockReset();
	process.exitCode = undefined;

	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

// ---------------------------------------------------------------------------
// parseSemver
// ---------------------------------------------------------------------------

describe("parseSemver", () => {
	it("parses a valid semver string", () => {
		expect(parseSemver("0.4.2")).toEqual([0, 4, 2]);
	});

	it("returns null for two segments", () => {
		expect(parseSemver("0.4")).toBeNull();
	});

	it("returns null for four segments", () => {
		expect(parseSemver("0.4.2.1")).toBeNull();
	});

	it("returns null for non-numeric segments", () => {
		expect(parseSemver("a.b.c")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseSemver("")).toBeNull();
	});

	it("returns null for mixed numeric and non-numeric segments", () => {
		expect(parseSemver("0.4.beta")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// checkAndMigrateIfNeeded
// ---------------------------------------------------------------------------

describe("checkAndMigrateIfNeeded", () => {
	it("returns false when .indexer-cli/ directory does not exist", async () => {
		const tempDir = createTempDir();
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndMigrateIfNeeded } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndMigrateIfNeeded();

		expect(result).toBe(false);
		expect(uninstallMock).not.toHaveBeenCalled();
		expect(initMock).not.toHaveBeenCalled();
	});

	it("returns false when config has no version field", async () => {
		const tempDir = createTempDir();
		writeConfig(tempDir, JSON.stringify({ other: "value" }));
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndMigrateIfNeeded } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndMigrateIfNeeded();

		expect(result).toBe(false);
		expect(uninstallMock).not.toHaveBeenCalled();
		expect(initMock).not.toHaveBeenCalled();
	});

	it("returns false when config contains invalid JSON", async () => {
		const tempDir = createTempDir();
		writeConfig(tempDir, "this is not json!!!");
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndMigrateIfNeeded } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndMigrateIfNeeded();

		expect(result).toBe(false);
		expect(uninstallMock).not.toHaveBeenCalled();
		expect(initMock).not.toHaveBeenCalled();
	});

	it("returns false when config version matches current minor", async () => {
		const tempDir = createTempDir();
		// PACKAGE_VERSION is read from package.json at runtime ("0.5.0")
		writeConfig(tempDir, JSON.stringify({ version: "0.5.0" }));
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndMigrateIfNeeded } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndMigrateIfNeeded();

		expect(result).toBe(false);
		expect(uninstallMock).not.toHaveBeenCalled();
		expect(initMock).not.toHaveBeenCalled();
	});

	it("migrates when config has different minor version", async () => {
		const tempDir = createTempDir();
		writeConfig(tempDir, JSON.stringify({ version: "0.3.0" }));
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndMigrateIfNeeded } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndMigrateIfNeeded();

		expect(result).toBe(true);
		expect(uninstallMock).toHaveBeenCalledTimes(1);
		expect(uninstallMock).toHaveBeenCalledWith(tempDir);
		expect(initMock).toHaveBeenCalledTimes(1);
		expect(initMock).toHaveBeenCalledWith(tempDir, {
			skipIndexing: false,
		});
	});

	it("migrates when config has different major version", async () => {
		const tempDir = createTempDir();
		writeConfig(tempDir, JSON.stringify({ version: "1.0.0" }));
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndMigrateIfNeeded } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndMigrateIfNeeded();

		expect(result).toBe(true);
		expect(uninstallMock).toHaveBeenCalledTimes(1);
		expect(uninstallMock).toHaveBeenCalledWith(tempDir);
		expect(initMock).toHaveBeenCalledTimes(1);
		expect(initMock).toHaveBeenCalledWith(tempDir, {
			skipIndexing: false,
		});
	});

	it("returns false and sets exitCode when migration fails", async () => {
		const tempDir = createTempDir();
		writeConfig(tempDir, JSON.stringify({ version: "0.3.0" }));
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		uninstallMock.mockRejectedValue(new Error("disk on fire"));

		const { checkAndMigrateIfNeeded } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndMigrateIfNeeded();

		expect(result).toBe(false);
		expect(process.exitCode).toBe(1);
		expect(initMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// checkAndRefreshSkills
// ---------------------------------------------------------------------------

describe("checkAndRefreshSkills", () => {
	it("returns false when .indexer-cli/ directory does not exist", async () => {
		const tempDir = createTempDir();
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndRefreshSkills } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndRefreshSkills();

		expect(result).toBe(false);
		expect(refreshSkillsMock).not.toHaveBeenCalled();
	});

	it("returns false when skillsVersion matches current version", async () => {
		const tempDir = createTempDir();
		writeConfig(
			tempDir,
			JSON.stringify({ version: "0.5.0", skillsVersion: mockSkillsVersion }),
		);
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndRefreshSkills } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndRefreshSkills();

		expect(result).toBe(false);
		expect(refreshSkillsMock).not.toHaveBeenCalled();
	});

	it("refreshes skills and writes new version when skillsVersion differs", async () => {
		const tempDir = createTempDir();
		writeConfig(
			tempDir,
			JSON.stringify({ version: "0.5.0", skillsVersion: 12345 }),
		);
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndRefreshSkills } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndRefreshSkills();

		expect(result).toBe(true);
		expect(refreshSkillsMock).toHaveBeenCalledTimes(1);
		expect(refreshSkillsMock).toHaveBeenCalledWith(tempDir);

		const updated = JSON.parse(
			readFileSync(path.join(tempDir, ".indexer-cli", "config.json"), "utf8"),
		);
		expect(updated.skillsVersion).toBe(mockSkillsVersion);
	});

	it("refreshes skills when config has no skillsVersion field", async () => {
		const tempDir = createTempDir();
		writeConfig(tempDir, JSON.stringify({ version: "0.5.0" }));
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndRefreshSkills } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndRefreshSkills();

		expect(result).toBe(true);
		expect(refreshSkillsMock).toHaveBeenCalledTimes(1);

		const updated = JSON.parse(
			readFileSync(path.join(tempDir, ".indexer-cli", "config.json"), "utf8"),
		);
		expect(updated.skillsVersion).toBe(mockSkillsVersion);
	});

	it("preserves other config fields when updating skillsVersion", async () => {
		const tempDir = createTempDir();
		writeConfig(
			tempDir,
			JSON.stringify({
				version: "0.5.0",
				skillsVersion: 12345,
				vectorSize: 768,
				ollamaBaseUrl: "http://localhost:11434",
			}),
		);
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndRefreshSkills } = await import(
			"../../../src/core/version-check.js"
		);
		await checkAndRefreshSkills();

		const updated = JSON.parse(
			readFileSync(path.join(tempDir, ".indexer-cli", "config.json"), "utf8"),
		);
		expect(updated.vectorSize).toBe(768);
		expect(updated.ollamaBaseUrl).toBe("http://localhost:11434");
		expect(updated.version).toBe("0.5.0");
	});

	it("returns false when config contains invalid JSON", async () => {
		const tempDir = createTempDir();
		writeConfig(tempDir, "not json");
		vi.spyOn(process, "cwd").mockReturnValue(tempDir);

		const { checkAndRefreshSkills } = await import(
			"../../../src/core/version-check.js"
		);
		const result = await checkAndRefreshSkills();

		expect(result).toBe(false);
		expect(refreshSkillsMock).not.toHaveBeenCalled();
	});
});
