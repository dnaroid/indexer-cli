import { DEFAULT_PAGE_SIZE } from "../constants/app";
import type { PaginationMeta } from "../types/api";

function toPositiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parsePage(value: string | undefined): number {
	return toPositiveInteger(value, 1);
}

export function parsePageSize(value: string | undefined): number {
	return Math.min(toPositiveInteger(value, DEFAULT_PAGE_SIZE), 100);
}

export function buildPaginationMeta(page: number, pageSize: number, totalItems: number): PaginationMeta {
	const totalPages = Math.max(Math.ceil(totalItems / pageSize), 1);
	return { page, pageSize, totalItems, totalPages };
}