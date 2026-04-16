import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { existsSyncMock, spawnSyncMock } = vi.hoisted(() => ({
	existsSyncMock: vi.fn(),
	spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawnSync: spawnSyncMock,
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		existsSync: existsSyncMock,
	};
});

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const wrapperPath = path.join(repoRoot, "bin", "indexer-cli.js");
const require = createRequire(import.meta.url);

type WrapperModule = {
	main: () => void;
};

function exitWithError(code?: string | number | null): never {
	throw new Error(`process.exit:${code ?? "undefined"}`);
}

async function loadWrapper(options?: {
	betterSqlite3Throws?: boolean;
}): Promise<WrapperModule> {
	vi.resetModules();
	vi.doUnmock("better-sqlite3");

	if (options?.betterSqlite3Throws) {
		vi.doMock("better-sqlite3", () => {
			throw new Error("native module unavailable");
		});
	} else {
		vi.doMock("better-sqlite3", () => ({}));
	}

	delete require.cache[require.resolve(wrapperPath)];
	return require(wrapperPath) as WrapperModule;
}

beforeEach(() => {
	spawnSyncMock.mockReset();
	existsSyncMock.mockReset();
	existsSyncMock.mockImplementation((filePath: string) =>
		filePath.endsWith("dist/cli/entry.js"),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.doUnmock("better-sqlite3");
	delete require.cache[require.resolve(wrapperPath)];
});

describe("CLI wrapper supervisor", () => {
	it("calls spawnSync and exits with the child's exit code", async () => {
		spawnSyncMock.mockReturnValue({ status: 7, error: undefined });
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitWithError);
		const { main } = await loadWrapper();

		expect(() => main()).toThrow("process.exit:7");
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		expect(exitSpy).toHaveBeenCalledWith(7);
	});

	it("re-spawns with INDEXER_CLI_AUTO_UPDATE_ATTEMPTED=1 after exit code 42", async () => {
		spawnSyncMock
			.mockReturnValueOnce({ status: 42, error: undefined })
			.mockReturnValueOnce({ status: 0, error: undefined });
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitWithError);
		const { main } = await loadWrapper();

		expect(() => main()).toThrow("process.exit:0");
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
		expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({
			env: process.env,
		});
		expect(spawnSyncMock.mock.calls[1]?.[2]).toMatchObject({
			env: expect.objectContaining({
				INDEXER_CLI_AUTO_UPDATE_ATTEMPTED: "1",
			}),
		});
		expect(exitSpy).toHaveBeenCalledWith(0);
	});

	it("exits with 42 on the second restart code without looping forever", async () => {
		spawnSyncMock
			.mockReturnValueOnce({ status: 42, error: undefined })
			.mockReturnValueOnce({ status: 42, error: undefined });
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitWithError);
		const { main } = await loadWrapper();

		expect(() => main()).toThrow("process.exit:42");
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
		expect(exitSpy).toHaveBeenCalledWith(42);
	});

	it("keeps the better-sqlite3 guard behavior", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitWithError);
		const { main } = await loadWrapper({ betterSqlite3Throws: true });

		expect(() => main()).toThrow("process.exit:1");
		expect(spawnSyncMock).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("native modules could not be loaded"),
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
