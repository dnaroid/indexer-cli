import type { ApiResponse } from "../../types/api";
import { HTTP_STATUS } from "../../constants/http";

export type Status = "idle" | "processing" | "completed" | "failed";

export type ApiV1Context = {
	requestId: string;
	method: string;
	path: string;
};

export function handleRequest(ctx: ApiV1Context): ApiResponse<string> {
	if (ctx.method !== "GET") {
		return { success: false, error: { code: HTTP_STATUS.METHOD_NOT_ALLOWED, message: "Only GET supported in v1" } };
	}
	return { success: true, data: `v1:${ctx.requestId}:${ctx.path}` };
}

export function formatV1Response(data: string): string {
	return `[APIv1] ${data}`;
}