export type ApiError = {
	code: string;
	message: string;
	status: number;
	details?: Record<string, unknown>;
};

export type ApiResponse<T> =
	| { ok: true; data: T; meta?: Record<string, unknown> }
	| { ok: false; error: ApiError };

export type PaginationMeta = {
	page: number;
	pageSize: number;
	totalItems: number;
	totalPages: number;
};

export type PaginatedResponse<T> = ApiResponse<{
	items: T[];
	pagination: PaginationMeta;
}>;