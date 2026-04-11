import { HTTP_STATUS } from "../constants/http";
import type { ApiError, ApiResponse } from "../types/api";

export type RequestContext = {
	headers: Record<string, string | undefined>;
	requestId: string;
};

export type AuthenticatedContext = RequestContext & {
	principalId: string;
	roles: string[];
};

function readBearerToken(headers: Record<string, string | undefined>): string | null {
	const authorization = headers.authorization?.trim();
	if (!authorization?.startsWith("Bearer ") ) {
		return null;
	}
	return authorization.slice(7).trim() || null;
}

export function requireAuthentication(context: RequestContext): ApiResponse<AuthenticatedContext> {
	const token = readBearerToken(context.headers);
	if (!token || token.length < 12) {
		const error: ApiError = { code: "UNAUTHORIZED", message: "Missing or invalid bearer token", status: HTTP_STATUS.UNAUTHORIZED };
		return { ok: false, error };
	}
	return {
		ok: true,
		data: { ...context, principalId: token.slice(0, 8), roles: ["reader"] },
	};
}