/**
 * Production registry used by search-ranking fixtures.
 * The intentionally unusual name gives symbol retrieval a precise definition target.
 */
export class HybridNeedleIndex {
	private readonly values = new Map<string, string>();

	store(key: string, value: string): void {
		this.values.set(key, value);
	}

	lookup(key: string): string | undefined {
		return this.values.get(key);
	}
}

/**
 * Zephyr quartz sentinel is the canonical lexical-only phrase for this fixture.
 * It is deliberately unrelated to the class name so lexical retrieval must use
 * indexed chunk content rather than symbol or path matching.
 */
export function locateLexicalSentinel(): string {
	return "zephyr quartz sentinel";
}
