/**
 * Deliberate test-double collision. Exact-symbol search should prefer the production
 * definition unless tests are explicitly requested or the query itself asks for tests.
 */
export class HybridNeedleIndex {
	lookup(): string {
		return "test-double";
	}
}

export function lexicalSentinelTestFixture(): string {
	return "zephyr quartz sentinel test fixture";
}
