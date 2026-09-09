const captures = new Map<string, string>();

export function capture(id: string, value: string): string {
	const existing = captures.get(id);
	if (existing !== undefined) return existing;
	captures.set(id, value);
	return value;
}
