import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LoggerModule = typeof import("../../../src/core/logger.js");

describe("logger", () => {
	let tempDirs: string[] = [];

	beforeEach(() => {
		tempDirs = [];
		vi.resetModules();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const dir of tempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "indexer-logger-test-"));
		tempDirs.push(dir);
		return dir;
	}

	async function loadLoggerModule(): Promise<LoggerModule> {
		return import("../../../src/core/logger.js");
	}

	it("setLogLevel() and getLogLevel() work correctly", async () => {
		const loggerModule = await loadLoggerModule();

		loggerModule.setLogLevel("debug");
		expect(loggerModule.getLogLevel()).toBe("debug");

		loggerModule.setLogLevel("warn");
		expect(loggerModule.getLogLevel()).toBe("warn");
	});

	it("writes the service name into formatted log messages", async () => {
		const dir = makeTempDir();
		const loggerModule = await loadLoggerModule();

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-02T03:04:05.000Z"));

		loggerModule.initLogger(dir);
		loggerModule.setLogLevel("info");

		const logger = new loggerModule.SystemLogger("search-service");
		logger.info("indexed");

		const content = fs.readFileSync(path.join(dir, "log.txt"), "utf-8").trim();
		expect(content).toContain("[search-service]");
	});

	it("filters messages based on log level priority", async () => {
		const dir = makeTempDir();
		const loggerModule = await loadLoggerModule();

		loggerModule.initLogger(dir);
		loggerModule.setLogLevel("warn");

		const logger = new loggerModule.SystemLogger("filter-test");
		logger.error("error message");
		logger.warn("warn message");
		logger.info("info message");
		logger.debug("debug message");

		const lines = fs
			.readFileSync(path.join(dir, "log.txt"), "utf-8")
			.split("\n")
			.filter(Boolean);

		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("[ERROR] error message");
		expect(lines[1]).toContain("[WARN] warn message");
	});

	it("initLogger() reads log level from config.json", async () => {
		const dir = makeTempDir();
		const loggerModule = await loadLoggerModule();

		fs.writeFileSync(
			path.join(dir, "config.json"),
			JSON.stringify({ logLevel: "debug" }),
			"utf-8",
		);

		loggerModule.initLogger(dir);

		expect(loggerModule.getLogLevel()).toBe("debug");
	});

	it("initLogger() handles missing config gracefully", async () => {
		const dir = makeTempDir();
		const loggerModule = await loadLoggerModule();

		loggerModule.initLogger(dir);

		expect(loggerModule.getLogLevel()).toBe("error");
	});

	it("writes to the expected log file path after initialization", async () => {
		const dir = makeTempDir();
		const loggerModule = await loadLoggerModule();

		loggerModule.initLogger(dir);
		loggerModule.setLogLevel("info");

		const logger = new loggerModule.SystemLogger("path-test");
		logger.info("written to file");

		const logPath = path.join(dir, "log.txt");
		expect(fs.existsSync(logPath)).toBe(true);
		expect(fs.readFileSync(logPath, "utf-8")).toContain("written to file");
	});

	it("formats messages with timestamp, service, level, and details", async () => {
		const dir = makeTempDir();
		const loggerModule = await loadLoggerModule();

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2024-06-01T12:34:56.789Z"));

		loggerModule.initLogger(dir);
		loggerModule.setLogLevel("debug");

		const logger = new loggerModule.SystemLogger("formatter");
		logger.debug("hello", { count: 2 });

		const line = fs.readFileSync(path.join(dir, "log.txt"), "utf-8").trim();
		expect(line).toBe(
			'[2024-06-01T12:34:56.789Z] [formatter] [DEBUG] hello {"count":2}',
		);
	});

	it("rotates the log file down to the latest 100 lines", async () => {
		const dir = makeTempDir();
		const loggerModule = await loadLoggerModule();

		loggerModule.initLogger(dir);
		loggerModule.setLogLevel("info");

		const logger = new loggerModule.SystemLogger("rotation");
		for (let index = 0; index < 105; index += 1) {
			logger.info(`line-${index}`);
		}

		const lines = fs
			.readFileSync(path.join(dir, "log.txt"), "utf-8")
			.split("\n")
			.filter(Boolean);

		expect(lines).toHaveLength(100);
		expect(lines[0]).toContain("line-5");
		expect(lines[99]).toContain("line-104");
	});

	it("falls back to console output when initialized directory does not exist", async () => {
		const loggerModule = await loadLoggerModule();
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		loggerModule.initLogger(path.join(os.tmpdir(), `missing-${Date.now()}`));
		loggerModule.setLogLevel("info");

		const logger = new loggerModule.SystemLogger("console-fallback");
		logger.info("fallback message");

		expect(consoleSpy).toHaveBeenCalledTimes(1);
		expect(consoleSpy.mock.calls[0]?.[0]).toContain("fallback message");
	});

	it("falls back to console output when appending to the log file throws", async () => {
		const dir = makeTempDir();
		const loggerModule = await loadLoggerModule();
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
			throw new Error("disk full");
		});

		loggerModule.initLogger(dir);
		loggerModule.setLogLevel("info");

		const logger = new loggerModule.SystemLogger("append-failure");
		logger.info("fallback after append error");

		expect(consoleSpy).toHaveBeenCalledTimes(1);
		expect(consoleSpy.mock.calls[0]?.[0]).toContain(
			"fallback after append error",
		);
	});

	it("keeps the default level for invalid config content and stringifies object messages", async () => {
		const dir = makeTempDir();
		const loggerModule = await loadLoggerModule();

		fs.writeFileSync(path.join(dir, "config.json"), "{ bad json", "utf-8");
		loggerModule.initLogger(dir);
		expect(loggerModule.getLogLevel()).toBe("error");

		fs.writeFileSync(
			path.join(dir, "config.json"),
			JSON.stringify({ logLevel: "trace" }),
			"utf-8",
		);
		loggerModule.initLogger(dir);
		loggerModule.setLogLevel("info");

		const logger = new loggerModule.SystemLogger("stringify");
		logger.info({ ready: true });

		expect(fs.readFileSync(path.join(dir, "log.txt"), "utf-8")).toContain(
			"[object Object]",
		);
	});

	it("preserves a trailing newline when rotation trims a file without one", async () => {
		const dir = makeTempDir();
		const loggerModule = await loadLoggerModule();

		loggerModule.initLogger(dir);
		loggerModule.setLogLevel("info");
		fs.writeFileSync(
			path.join(dir, "log.txt"),
			Array.from({ length: 101 }, (_, index) => `line-${index}`).join("\n"),
			"utf-8",
		);

		new loggerModule.SystemLogger("rotation-newline").info("next line");

		expect(
			fs.readFileSync(path.join(dir, "log.txt"), "utf-8").endsWith("\n"),
		).toBe(true);
	});
});
