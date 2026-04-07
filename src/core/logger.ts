import fs from "node:fs";
import path from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};

const VALID_LEVELS = new Set<string>(["error", "warn", "info", "debug"]);
const MAX_LOG_LINES = 100;

let currentLogLevel: LogLevel = "error";
let logFilePath: string | null = null;

export function setLogLevel(level: LogLevel): void {
	currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
	return currentLogLevel;
}

/**
 * Initialize the logger with a project data directory.
 * Reads logLevel from <dataDir>/config.json if present,
 * and sets the log file to <dataDir>/log.txt.
 * Safe to call before the directory exists — falls back to console.
 */
export function initLogger(dataDir: string): void {
	const configPath = path.join(dataDir, "config.json");
	try {
		if (fs.existsSync(configPath)) {
			const raw = fs.readFileSync(configPath, "utf-8");
			const cfg = JSON.parse(raw) as Record<string, unknown>;
			if (typeof cfg.logLevel === "string" && VALID_LEVELS.has(cfg.logLevel)) {
				currentLogLevel = cfg.logLevel as LogLevel;
			}
		}
	} catch {
		// config unreadable — keep default level
	}

	logFilePath = path.join(dataDir, "log.txt");
}

function rotateIfNeeded(): void {
	if (!logFilePath) return;
	try {
		if (!fs.existsSync(logFilePath)) return;
		const contents = fs.readFileSync(logFilePath, "utf-8");
		const lines = contents.split("\n");
		const nonEmpty =
			lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
		if (nonEmpty > MAX_LOG_LINES) {
			const trimmed = lines.slice(nonEmpty - MAX_LOG_LINES).join("\n");
			fs.writeFileSync(
				logFilePath,
				trimmed.endsWith("\n") ? trimmed : trimmed + "\n",
			);
		}
	} catch {
		// rotation failed — non-fatal
	}
}

function writeLine(line: string): void {
	if (!logFilePath) {
		// not initialized — fall back to console
		console.log(line);
		return;
	}
	try {
		const dir = path.dirname(logFilePath);
		if (!fs.existsSync(dir)) {
			console.log(line);
			return;
		}
		fs.appendFileSync(logFilePath, line + "\n");
		rotateIfNeeded();
	} catch {
		console.log(line);
	}
}

const shouldLog = (level: LogLevel): boolean =>
	LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[currentLogLevel];

export class SystemLogger {
	private serviceName: string;

	constructor(serviceName: string) {
		this.serviceName = serviceName;
	}

	private sendLog(level: LogLevel, message: unknown, details?: any) {
		if (!shouldLog(level)) {
			return;
		}
		const text = typeof message === "string" ? message : String(message);
		const timestamp = new Date().toISOString();
		const detailsStr = details ? ` ${JSON.stringify(details)}` : "";
		writeLine(
			`[${timestamp}] [${this.serviceName}] [${level.toUpperCase()}] ${text}${detailsStr}`,
		);
	}

	info(message: unknown, details?: any) {
		this.sendLog("info", message, details);
	}

	warn(message: unknown, details?: any) {
		this.sendLog("warn", message, details);
	}

	error(message: unknown, details?: any) {
		this.sendLog("error", message, details);
	}

	debug(message: unknown, details?: any) {
		this.sendLog("debug", message, details);
	}
}
