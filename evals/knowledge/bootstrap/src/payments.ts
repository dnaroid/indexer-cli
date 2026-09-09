const results = new Map<string, string>();

export function submitPayment(requestKey: string): string {
	const previous = results.get(requestKey);
	if (previous) return previous;
	const result = `payment:${requestKey}`;
	results.set(requestKey, result);
	return result;
}
