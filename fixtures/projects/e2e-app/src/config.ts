import type { LogLevel } from "./utils/logger";

export interface AppConfig {
	appName: string;
	port: number;
	sessionSecret: string;
	paymentProvider: "stripe" | "paypal";
	logLevel: LogLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const port = Number(env.PORT ?? 3000);
	const provider = env.PAYMENT_PROVIDER === "paypal" ? "paypal" : "stripe";
	const logLevel = resolveLogLevel(env.LOG_LEVEL);

	return {
		appName: env.APP_NAME?.trim() || "semantic-traps-app",
		port: Number.isFinite(port) && port > 0 ? port : 3000,
		sessionSecret: env.SESSION_SECRET?.trim() || "local-development-secret",
		paymentProvider: provider,
		logLevel,
	};
}

function resolveLogLevel(value: string | undefined): LogLevel {
	if (value === "debug" || value === "error") {
		return value;
	}
	return "info";
}