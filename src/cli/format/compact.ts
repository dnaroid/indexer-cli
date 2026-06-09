import type { AutoIndexResult } from "../commands/ensure-indexed.js";

function sanitizeValue(value: string): string {
	const compact = value.trim().replace(/\s+/g, "-");
	return compact.length > 0 ? compact : "unknown";
}

export function formatAutoIndexResult(result: AutoIndexResult): string {
	const parts = [`IDX ${result.status}`];

	if (result.status === "updated") {
		if (result.files !== undefined) {
			parts.push(`files=${result.files}`);
		}
		if (result.removed !== undefined) {
			parts.push(`removed=${result.removed}`);
		}
		if (result.errors !== undefined && result.errors > 0) {
			parts.push(`errors=${result.errors}`);
		}
	}

	if (result.status === "stale") {
		parts.push(`reason=${sanitizeValue(result.reason)}`);
		if (result.action) {
			parts.push(`action=${sanitizeValue(result.action)}`);
		}
	}

	if (result.status === "failed") {
		parts.push(`reason=${sanitizeValue(result.reason)}`);
		if (result.action) {
			parts.push(`action=${sanitizeValue(result.action)}`);
		}
	}

	if (result.ms !== undefined) {
		parts.push(`ms=${result.ms}`);
	}

	return parts.join(" ");
}