/**
 * A semantic-looking distractor: it talks about indexes, lookup and recovery but
 * intentionally does not define HybridNeedleIndex or the lexical sentinel phrase.
 */
export function recoverCachedLookupIndex(): string {
	return "recover cached lookup index state after a detached worker restarts";
}
