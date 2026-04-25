export function normalizePathPrefix(pathPrefix?: string): string | undefined {
	const trimmed = pathPrefix?.trim();
	if (!trimmed) {
		return undefined;
	}

	return trimmed.replace(/\/+$/, "") === "." ? undefined : trimmed;
}