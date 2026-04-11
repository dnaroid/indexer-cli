import { MAX_RETRIES, TIMEOUT_MS } from "../constants/app";
import { HTTP_STATUS } from "../constants/http";
import type { ApiError, ApiResponse } from "../types/api";

const requestCounts = new Map<string, { count: number; resetAt: number }>();

export function applyRateLimit(key: string, limit = MAX_RETRIES): ApiResponse<{ remaining: number }> {
	const now = Date.now();
	const current = requestCounts.get(key);
	if (!current || current.resetAt <= now) {
		requestCounts.set(key, { count: 1, resetAt: now + TIMEOUT_MS });
		return { ok: true, data: { remaining: limit - 1 } };
	}
	if (current.count >= limit) {
		const error: ApiError = { code: "RATE_LIMITED", message: "Request quota exceeded", status: HTTP_STATUS.TOO_MANY_REQUESTS };
		return { ok: false, error };
	}
	current.count += 1;
	requestCounts.set(key, current);
	return { ok: true, data: { remaining: Math.max(limit - current.count, 0) } };
}