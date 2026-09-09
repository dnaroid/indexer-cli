export function tokenIsValid(expiresAt: number, now: number): boolean {
	return expiresAt > now;
}
