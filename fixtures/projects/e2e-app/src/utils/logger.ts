import { format } from "./format";

export type LogLevel = "debug" | "info" | "error";

export type LogContext = Record<string, string | number | boolean | undefined>;

export function formatLog(level: LogLevel, message: string, context: LogContext = {}): string {
	const entries = Object.entries(context)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(" " );
	const prefix = `[${format(new Date())}] ${level.toUpperCase()}`;
	return entries ? `${prefix} ${message} ${entries}` : `${prefix} ${message}`;
}

export class Logger {
	constructor(private readonly level: LogLevel) {}

	debug(message: string, context: LogContext = {}): string | undefined {
		if (this.level !== "debug") {
			return undefined;
		}
		return formatLog("debug", message, context);
	}

	info(message: string, context: LogContext = {}): string {
		return formatLog("info", message, context);
	}

	error(message: string, context: LogContext = {}): string {
		return formatLog("error", message, context);
	}
}