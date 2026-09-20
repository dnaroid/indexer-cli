import type { KnowledgeCandidateReviewSummary } from "../../knowledge/service.js";

type CandidateReviewCounts = Pick<
	KnowledgeCandidateReviewSummary,
	"unclassifiedCandidateCount" | "changedClassifiedCandidateCount" | "specCandidateCount"
>;

function documentCount(count: number): string {
	return `${count} document${count === 1 ? "" : "s"}`;
}

export function candidateReviewRecommendation(
	counts: CandidateReviewCounts,
): string | undefined {
	const { unclassifiedCandidateCount, changedClassifiedCandidateCount, specCandidateCount } = counts;
	if (unclassifiedCandidateCount === 0 && changedClassifiedCandidateCount === 0) {
		return undefined;
	}

	const unclassified =
		unclassifiedCandidateCount > 0
			? `${documentCount(unclassifiedCandidateCount)} ${unclassifiedCandidateCount === 1 ? "is" : "are"} unclassified (${specCandidateCount} heuristic spec candidate${specCandidateCount === 1 ? "" : "s"}) and available as default-trusted, unreviewed indexed knowledge. Record selected documents only when you want durable classification, relations, and verification.`
			: undefined;
	const changedClassified =
		changedClassifiedCandidateCount > 0
			? `${documentCount(changedClassifiedCandidateCount)} ${changedClassifiedCandidateCount === 1 ? "was" : "were"} previously classified, changed since classification, and ${changedClassifiedCandidateCount === 1 ? "requires" : "require"} review.`
			: undefined;

	if (unclassified && changedClassified) {
		return `${unclassified} ${changedClassified} Use \`idx wiki discover\` to inspect candidates. Changed classified candidates remain registered knowledge and should be reviewed/re-recorded when their metadata needs confirmation.`;
	}
	if (unclassified) {
		return `${unclassified} Use \`idx wiki discover\` to inspect candidates; registration is optional for retrieval but required for durable primary-spec semantics.`;
	}
	return `${changedClassified} Tell the user changed classified candidates still need review, run \`idx wiki discover\`, and read each changed source. Review the existing classification/metadata and re-run \`idx wiki record\` when confirming or updating it. These candidates are already registered project knowledge; do not describe them as unregistered.`;
}
