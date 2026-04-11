import { DEFAULT_PAGE_SIZE } from "../constants/app";

export type CorsOptions = {
	origins: string[];
	methods: string[];
	allowCredentials: boolean;
};

export function createCorsHeaders(origin: string | undefined, options: CorsOptions): Record<string, string> {
	const allowedOrigin = origin && options.origins.includes(origin) ? origin : options.origins[0] ?? "*";
	return {
		"access-control-allow-origin": allowedOrigin,
		"access-control-allow-methods": options.methods.join(", "),
		"access-control-allow-credentials": String(options.allowCredentials),
		"x-default-page-size": String(DEFAULT_PAGE_SIZE),
	};
}

export function shouldHandlePreflight(method: string, headers: Record<string, string | undefined>): boolean {
	return method.toUpperCase() === "OPTIONS" && Boolean(headers["access-control-request-method"]);
}