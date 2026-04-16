import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	execFileSyncMock,
	existsSyncMock,
	readFileSyncMock,
	writeFileSyncMock,
	mkdirSyncMock,
	rmSyncMock,
	statSyncMock,
} = vi.hoisted(() => ({
	execFileSyncMock: vi.fn(),
	existsSyncMock: vi.fn(),
	readFileSyncMock: vi.fn(),
	writeFileSyncMock: vi.fn(),
	mkdirSyncMock: vi.fn(),
	rmSyncMock: vi.fn(),
	statSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFileSync: execFileSyncMock,
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: existsSyncMock,
		readFileSync: readFileSyncMock,
		writeFileSync: writeFileSyncMock,
		mkdirSync: mkdirSyncMock,
		rmSync: rmSyncMock,
		statSync: statSyncMock,
	};
});

vi.mock("../../../src/core/version.js", () => ({
	PACKAGE_VERSION: "1.0.0",
}));

import {
	detectInstallMethod,
	performAutoUpdate,
	shouldSkipAutoUpdate,
} from "../../../src/core/update-check.js";

const originalArgv = process.argv.slice();
const originalEnv = { ...process.env };
const originalStdoutIsTTY = process.stdout.isTTY;

function setStdoutIsTTY(value: boolean | undefined): void {
	Object.defineProperty(process.stdout, "isTTY", {
		value,
		configurable: true,
		writable: true,
	});
}

function mockCacheExists(latestVersion: string, lastChecked: number): void {
	existsSyncMock.mockImplementation((filePath: string) =>
		filePath.endsWith(".update-check.json"),
	);
	readFileSyncMock.mockImplementation((filePath: string) => {
		if (filePath.endsWith(".update-check.json")) {
			return JSON.stringify({ lastChecked, latestVersion });
		}

		throw new Error(`Unexpected read: ${filePath}`);
	});
}

function mockSuccessfulUpdateFlow(installedVersion: string): void {
	existsSyncMock.mockImplementation((filePath: string) => {
		if (filePath.endsWith(".update-check.json")) return true;
		if (filePath.endsWith(".update-lock")) return false;
		if (filePath.endsWith("indexer-cli/package.json")) return true;
		return false;
	});
	readFileSyncMock.mockImplementation((filePath: string) => {
		if (filePath.endsWith(".update-check.json")) {
			return JSON.stringify({
				lastChecked: Date.now(),
				latestVersion: "1.1.0",
			});
		}

		if (filePath.endsWith("indexer-cli/package.json")) {
			return JSON.stringify({ version: installedVersion });
		}

		throw new Error(`Unexpected read: ${filePath}`);
	});
}

beforeEach(() => {
	process.env = { ...originalEnv };
	process.argv = originalArgv.slice();
	setStdoutIsTTY(originalStdoutIsTTY);

	execFileSyncMock.mockReset();
	existsSyncMock.mockReset();
	readFileSyncMock.mockReset();
	writeFileSyncMock.mockReset();
	mkdirSyncMock.mockReset();
	rmSyncMock.mockReset();
	statSyncMock.mockReset();

	existsSyncMock.mockReturnValue(false);
	writeFileSyncMock.mockImplementation(() => undefined);
	mkdirSyncMock.mockImplementation(() => undefined);
	rmSyncMock.mockImplementation(() => undefined);
	statSyncMock.mockImplementation(() => ({ mtimeMs: Date.now() }));
});

afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...originalEnv };
	process.argv = originalArgv.slice();
	setStdoutIsTTY(originalStdoutIsTTY);
});

describe("detectInstallMethod", () => {
	it("detects npx from cache path", () => {
		process.argv = [
			process.argv[0],
			"/home/user/.npm/_npx/abc123/node_modules/.bin/indexer-cli",
		];
		expect(detectInstallMethod()).toBe("npx");
	});

	it("detects pnpm-global install", () => {
		process.argv = [
			process.argv[0],
			"/home/user/.pnpm/global/xyz/node_modules/.bin/indexer-cli",
		];
		expect(detectInstallMethod()).toBe("pnpm-global");
	});

	it("detects yarn-global install", () => {
		process.argv = [
			process.argv[0],
			"/home/user/.yarn/global/node_modules/.bin/indexer-cli",
		];
		expect(detectInstallMethod()).toBe("yarn-global");
	});

	it("defaults to npm-global for standard bin paths", () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		expect(detectInstallMethod()).toBe("npm-global");
	});

	it("returns unknown when argv[1] is undefined", () => {
		process.argv = [process.argv[0]];
		expect(detectInstallMethod()).toBe("unknown");
	});

	it("returns unknown when argv[1] is empty string", () => {
		process.argv = [process.argv[0], ""];
		expect(detectInstallMethod()).toBe("unknown");
	});
});

describe("shouldSkipAutoUpdate", () => {
	it("returns true when INDEXER_CLI_AUTO_UPDATE_ATTEMPTED is set", () => {
		process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED = "1";
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);

		expect(shouldSkipAutoUpdate()).toBe(true);
	});

	it("returns true when install method is npx", () => {
		process.argv = [
			process.argv[0],
			"/home/user/.npm/_npx/abc123/node_modules/.bin/indexer-cli",
		];
		setStdoutIsTTY(true);

		expect(shouldSkipAutoUpdate()).toBe(true);
	});

	it("returns true when install method is pnpm-global", () => {
		process.argv = [
			process.argv[0],
			"/home/user/.pnpm/global/xyz/node_modules/.bin/indexer-cli",
		];
		setStdoutIsTTY(true);

		expect(shouldSkipAutoUpdate()).toBe(true);
	});

	it("returns false when install method is npm-global", () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);

		expect(shouldSkipAutoUpdate()).toBe(false);
	});

	it("returns true when CI is true", () => {
		process.env.CI = "true";
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);

		expect(shouldSkipAutoUpdate()).toBe(true);
	});

	it("returns true when --no-auto-update is passed", () => {
		process.argv = [
			process.argv[0],
			"/usr/local/bin/indexer-cli",
			"search",
			"--no-auto-update",
		];
		setStdoutIsTTY(true);

		expect(shouldSkipAutoUpdate()).toBe(true);
	});

	it("returns true when stdout is not a TTY", () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(undefined);

		expect(shouldSkipAutoUpdate()).toBe(true);
	});
});

describe("performAutoUpdate", () => {
	it("returns immediately when shouldSkipAutoUpdate gates it off", async () => {
		process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED = "1";
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);

		await performAutoUpdate();

		expect(execFileSyncMock).not.toHaveBeenCalled();
		expect(writeFileSyncMock).not.toHaveBeenCalled();
	});

	it("returns immediately when cache shows no newer version", async () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		mockCacheExists("1.0.0", Date.now() - 60_000);

		await performAutoUpdate();

		expect(execFileSyncMock).not.toHaveBeenCalled();
		expect(writeFileSyncMock).not.toHaveBeenCalled();
	});

	it("returns immediately when cache is fresh and version is current", async () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		mockCacheExists("1.0.0", Date.now());
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		await performAutoUpdate();

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});

	it("calls process.exit(42) on successful update flow", async () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		mockSuccessfulUpdateFlow("1.1.0");
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);

		await performAutoUpdate();

		expect(execFileSyncMock).toHaveBeenCalledWith(
			"npm",
			["install", "-g", "indexer-cli@latest"],
			{ stdio: "inherit" },
		);
		expect(exitSpy).toHaveBeenCalledWith(42);
		expect(rmSyncMock).toHaveBeenCalledWith(
			expect.stringContaining(".update-lock"),
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("returns with warning when update command fails", async () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		mockSuccessfulUpdateFlow("1.1.0");
		execFileSyncMock.mockImplementation(() => {
			throw new Error("npm install failed");
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await performAutoUpdate();

		expect(errorSpy).toHaveBeenCalledWith(
			"Auto-update warning: failed to update indexer-cli automatically.",
		);
		expect(rmSyncMock).toHaveBeenCalledWith(
			expect.stringContaining(".update-lock"),
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("returns with warning when version verification fails", async () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		mockSuccessfulUpdateFlow("1.0.0");
		const exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await performAutoUpdate();

		expect(errorSpy).toHaveBeenCalledWith(
			"Auto-update warning: indexer-cli version did not change after install.",
		);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(rmSyncMock).toHaveBeenCalledWith(
			expect.stringContaining(".update-lock"),
			{
				recursive: true,
				force: true,
			},
		);
	});
});
