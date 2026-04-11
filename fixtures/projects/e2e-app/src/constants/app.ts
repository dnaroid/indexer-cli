export const MAX_RETRIES = 3;
export const TIMEOUT_MS = 15_000;
export const DEFAULT_PAGE_SIZE = 25;

export const APP_ENVIRONMENTS = ["development", "test", "production"] as const;

export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

export function isSupportedEnvironment(value: string): value is AppEnvironment {
	return APP_ENVIRONMENTS.includes(value as AppEnvironment);
}