export function candidateReviewRecommendation(candidateCount: number): string {
	const candidateLabel = candidateCount === 1 ? "candidate" : "candidates";
	const reviewVerb = candidateCount === 1 ? "requires" : "require";
	return `${candidateCount} new/changed document ${candidateLabel} ${reviewVerb} review. Tell the user they remain unreviewed, run \`idx wiki discover\`, read each source, then classify it with \`idx wiki record\`; do not treat candidates as registered knowledge before review.`;
}
