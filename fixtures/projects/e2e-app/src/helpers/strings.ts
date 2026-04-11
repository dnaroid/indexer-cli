function normalizeWhitespace(input: string): string {
	return input.trim().replace(/\s+/g, " " );
}

export function capitalize(value: string): string {
	if (!value) {
		return value;
	}
	const normalized = normalizeWhitespace(value);
	return normalized[0].toUpperCase() + normalized.slice(1);
}

export function slugify(value: string): string {
	return normalizeWhitespace(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function truncate(value: string, maxLength: number): string {
	const normalized = normalizeWhitespace(value);
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(maxLength - 1, 0))}…`;
}

export function escapeHtml(value: string): string {
	const normalized = normalizeWhitespace(value);
	return normalized.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}