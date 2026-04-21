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
	getAutoUpdateSkipReason,
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

	it("detects npm-global when npm prefix matches exec path", () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
			if (
				cmd === "npm" &&
				args[0] === "config" &&
				args[1] === "get" &&
				args[2] === "prefix"
			) {
				return "/usr/local\n";
			}
			throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
		});
		expect(detectInstallMethod()).toBe("npm-global");
	});

	it("returns unknown when npm prefix shows path is not global bin", () => {
		process.argv = [process.argv[0], "/some/random/path/indexer-cli"];
		execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
			if (
				cmd === "npm" &&
				args[0] === "config" &&
				args[1] === "get" &&
				args[2] === "prefix"
			) {
				return "/usr/local\n";
			}
			throw new Error(`Unexpected command: ${cmd} ${args.join(" ")}`);
		});
		expect(detectInstallMethod()).toBe("unknown");
	});

	it("falls back to npm-global when npm prefix command fails", () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		execFileSyncMock.mockImplementation(() => {
			throw new Error("npm unavailable");
		});
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

describe("getAutoUpdateSkipReason", () => {
	it("returns 'already-attempted' when INDEXER_CLI_AUTO_UPDATE_ATTEMPTED is set", () => {
		process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED = "1";
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

		expect(getAutoUpdateSkipReason()).toBe("already-attempted");
	});

	it("returns 'unsupported-install-method' when install method is not npm-global", () => {
		process.argv = [
			process.argv[0],
			"/home/user/.npm/_npx/abc123/node_modules/.bin/indexer-cli",
		];
		setStdoutIsTTY(true);

		expect(getAutoUpdateSkipReason()).toBe("unsupported-install-method");
	});

	it("returns 'non-tty' when stdout is not a TTY", () => {
		delete process.env.CI;
		delete process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED;
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(undefined);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

		expect(getAutoUpdateSkipReason()).toBe("non-tty");
	});

	it("returns 'ci' when CI is true", () => {
		process.env.CI = "true";
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

		expect(getAutoUpdateSkipReason()).toBe("ci");
	});

	it("returns 'flag-disabled' when --no-auto-update is passed", () => {
		process.argv = [
			process.argv[0],
			"/usr/local/bin/indexer-cli",
			"search",
			"--no-auto-update",
		];
		setStdoutIsTTY(true);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

		expect(getAutoUpdateSkipReason()).toBe("flag-disabled");
	});

	it("returns null when no skip conditions are met", () => {
		delete process.env.CI;
		delete process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED;
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

		expect(getAutoUpdateSkipReason()).toBeNull();
	});
});

describe("shouldSkipAutoUpdate", () => {
	it("returns true when INDEXER_CLI_AUTO_UPDATE_ATTEMPTED is set", () => {
		process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED = "1";
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

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
		delete process.env.CI;
		delete process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED;
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

		expect(shouldSkipAutoUpdate()).toBe(false);
	});

	it("returns true when CI is true", () => {
		process.env.CI = "true";
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

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
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

		expect(shouldSkipAutoUpdate()).toBe(true);
	});

	it("returns true when stdout is not a TTY", () => {
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(undefined);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

		expect(shouldSkipAutoUpdate()).toBe(true);
	});
});

describe("performAutoUpdate", () => {
	it("returns skipped result when shouldSkipAutoUpdate gates it off", async () => {
		process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED = "1";
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);

		const result = await performAutoUpdate();

		expect(result).toEqual({ kind: "skipped", reason: "already-attempted" });
		expect(execFileSyncMock).not.toHaveBeenCalled();
		expect(writeFileSyncMock).not.toHaveBeenCalled();
	});

	it("returns no-update result when cache shows no newer version", async () => {
		delete process.env.CI;
		delete process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED;
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		mockCacheExists("1.0.0", Date.now() - 60_000);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

		const result = await performAutoUpdate();

		expect(result).toEqual({ kind: "no-update" });
		expect(execFileSyncMock).toHaveBeenCalledTimes(1);
	});

	it("returns no-update when cache is fresh and version is current", async () => {
		delete process.env.CI;
		delete process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED;
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		mockCacheExists("1.0.0", Date.now());
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const result = await performAutoUpdate();

		expect(result).toEqual({ kind: "no-update" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("returns updated result on successful update flow", async () => {
		delete process.env.CI;
		delete process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED;
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		mockSuccessfulUpdateFlow("1.1.0");

		const result = await performAutoUpdate();

		expect(execFileSyncMock).toHaveBeenCalledWith(
			"npm",
			["install", "-g", "indexer-cli@latest"],
			{ stdio: "inherit" },
		);
		expect(result).toEqual({
			kind: "updated",
			previousVersion: "1.0.0",
			installedVersion: "1.1.0",
			restartRequired: true,
		});
		expect(rmSyncMock).toHaveBeenCalledWith(
			expect.stringContaining(".update-lock"),
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("returns failed result when update command fails", async () => {
		delete process.env.CI;
		delete process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED;
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		mockSuccessfulUpdateFlow("1.1.0");
		execFileSyncMock.mockImplementation(() => {
			throw new Error("npm install failed");
		});
		execFileSyncMock.mockImplementation(() => {
			throw new Error("npm install failed");
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await performAutoUpdate();

		expect(result.kind).toBe("failed");
		if (result.kind === "failed") {
			expect(result.message).toContain("npm install failed");
		}
		expect(rmSyncMock).toHaveBeenCalledWith(
			expect.stringContaining(".update-lock"),
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("returns failed result when version did not change after install", async () => {
		delete process.env.CI;
		delete process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED;
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		mockSuccessfulUpdateFlow("1.0.0");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await performAutoUpdate();

		expect(result.kind).toBe("failed");
		if (result.kind === "failed") {
			expect(result.message).toContain("version did not change");
		}
		expect(rmSyncMock).toHaveBeenCalledWith(
			expect.stringContaining(".update-lock"),
			{
				recursive: true,
				force: true,
			},
		);
	});

	it("returns skipped result when update lock is held by another process", async () => {
		delete process.env.CI;
		delete process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED;
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);
		execFileSyncMock.mockImplementation(() => "/usr/local\n");

		existsSyncMock.mockImplementation((filePath: string) => {
			if (filePath.endsWith(".update-check.json")) return false;
			if (filePath.endsWith(".update-lock")) return true;
			if (filePath.endsWith(".indexer-cli")) return true;
			return false;
		});
		readFileSyncMock.mockImplementation(() => {
			throw new Error("Unexpected read");
		});
		mkdirSyncMock.mockImplementation((filePath: string) => {
			if (typeof filePath === "string" && filePath.endsWith(".update-lock")) {
				throw new Error("EEXIST: lock dir already exists");
			}
		});
		statSyncMock.mockImplementation(() => ({ mtimeMs: Date.now() }));

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			json: () => Promise.resolve({ version: "1.1.0" }),
		} as Response);

		const result = await performAutoUpdate();

		expect(result).toEqual({ kind: "skipped", reason: "update-lock-held" });
	});

	it("cleans stale lock and proceeds with update", async () => {
		delete process.env.CI;
		delete process.env.INDEXER_CLI_AUTO_UPDATE_ATTEMPTED;
		process.argv = [process.argv[0], "/usr/local/bin/indexer-cli"];
		setStdoutIsTTY(true);

		const staleTime = Date.now() - 10 * 60 * 1000;
		let lockCreated = false;

		existsSyncMock.mockImplementation((filePath: string) => {
			if (filePath.endsWith(".update-check.json")) return false;
			if (filePath.endsWith(".update-lock")) return !lockCreated;
			if (filePath.endsWith("indexer-cli/package.json")) return true;
			return false;
		});
		readFileSyncMock.mockImplementation((filePath: string) => {
			if (filePath.endsWith("indexer-cli/package.json")) {
				return JSON.stringify({ version: "1.1.0" });
			}
			throw new Error(`Unexpected read: ${filePath}`);
		});
		statSyncMock.mockImplementation(() => ({ mtimeMs: staleTime }));
		mkdirSyncMock.mockImplementation(() => {
			lockCreated = true;
		});

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			json: () => Promise.resolve({ version: "1.1.0" }),
		} as Response);

		const result = await performAutoUpdate();

		expect(rmSyncMock).toHaveBeenCalledWith(
			expect.stringContaining(".update-lock"),
			{ recursive: true, force: true },
		);
		expect(result).toEqual({
			kind: "updated",
			previousVersion: "1.0.0",
			installedVersion: "1.1.0",
			restartRequired: true,
		});
	});
});
