import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const wrapperPath = path.join(repoRoot, "bin", "indexer-cli.js");
const wrapperDir = path.dirname(wrapperPath);
const wrapperSource = readFileSync(wrapperPath, "utf8").replace(/^#!.*\n/, "");

type WrapperModule = {
	main: () => void;
};

type BetterSqlite3Mode = "ok" | "throw";

const existsSyncMock = vi.fn<(filePath: string) => boolean>();
const spawnSyncMock = vi.fn();

function loadWrapper(options?: {
	betterSqlite3?: BetterSqlite3Mode;
}): WrapperModule {
	const betterSqlite3Mode = options?.betterSqlite3 ?? "ok";
	const module = { exports: {} as WrapperModule };
	const customRequire = Object.assign(
		(moduleId: string) => {
			if (moduleId === "node:child_process") {
				return { spawnSync: spawnSyncMock };
			}

			if (moduleId === "node:fs") {
				return { existsSync: existsSyncMock };
			}

			if (moduleId === "better-sqlite3") {
				if (betterSqlite3Mode === "throw") {
					throw new Error("native module unavailable");
				}
				return {};
			}

			return require(moduleId);
		},
		{
			main: {},
			resolve: require.resolve,
		},
	);

	const evaluateWrapper = new Function(
		"require",
		"module",
		"exports",
		"__dirname",
		"__filename",
		"process",
		"console",
		wrapperSource,
	) as (
		requireFn: typeof customRequire,
		moduleRef: typeof module,
		exportsRef: WrapperModule,
		dirnameRef: string,
		filenameRef: string,
		processRef: NodeJS.Process,
		consoleRef: Console,
	) => void;

	evaluateWrapper(
		customRequire,
		module,
		module.exports,
		wrapperDir,
		wrapperPath,
		process,
		console,
	);

	return module.exports;
}

function exitWithError(code?: string | number | null): never {
	throw new Error(`process.exit:${code ?? "undefined"}`);
}

beforeEach(() => {
	existsSyncMock.mockReset();
	spawnSyncMock.mockReset();
	existsSyncMock.mockImplementation((filePath: string) =>
		filePath.endsWith("dist/cli/entry.js"),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("CLI wrapper supervisor", () => {
	it("calls spawnSync and exits with the child's exit code", () => {
		spawnSyncMock.mockReturnValue({ status: 7, error: undefined });
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitWithError);
		const { main } = loadWrapper();

		expect(() => main()).toThrow("process.exit:7");
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		expect(exitSpy).toHaveBeenCalledWith(7);
	});

	it("re-spawns with INDEXER_CLI_AUTO_UPDATE_ATTEMPTED=1 after exit code 42", () => {
		spawnSyncMock
			.mockReturnValueOnce({ status: 42, error: undefined })
			.mockReturnValueOnce({ status: 0, error: undefined });
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitWithError);
		const { main } = loadWrapper();

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

	it("exits with 42 on the second restart code without looping forever", () => {
		spawnSyncMock
			.mockReturnValueOnce({ status: 42, error: undefined })
			.mockReturnValueOnce({ status: 42, error: undefined });
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitWithError);
		const { main } = loadWrapper();

		expect(() => main()).toThrow("process.exit:42");
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
		expect(exitSpy).toHaveBeenCalledWith(42);
	});

	it("keeps the better-sqlite3 guard behavior", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(exitWithError);
		const { main } = loadWrapper({ betterSqlite3: "throw" });

		expect(() => main()).toThrow("process.exit:1");
		expect(spawnSyncMock).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("native modules could not be loaded"),
		);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});
