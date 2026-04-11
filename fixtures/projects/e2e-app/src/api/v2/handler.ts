import type { ApiResponse } from "../../types/api";
import { HTTP_STATUS } from "../../constants/http";

export type Status = "pending" | "running" | "done" | "error";

export type ApiV2Context = {
	requestId: string;
	method: string;
	path: string;
	body?: unknown;
};

export function handleRequest(ctx: ApiV2Context): ApiResponse<unknown> {
	if (ctx.method === "GET") {
		return { success: true, data: { version: 2, path: ctx.path, id: ctx.requestId } };
	}
	if (ctx.method === "POST" && ctx.body) {
		return { success: true, data: ctx.body };
	}
	return { success: false, error: { code: HTTP_STATUS.BAD_REQUEST, message: "Unsupported v2 operation" } };
}

export function parseV2Path(raw: string): string[] {
	return raw.split("/").filter(Boolean);
}