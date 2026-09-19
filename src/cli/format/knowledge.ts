import type { KnowledgeCandidateReviewSummary } from "../../knowledge/service.js";

type CandidateReviewCounts = Pick<
	KnowledgeCandidateReviewSummary,
	"unclassifiedCandidateCount" | "changedClassifiedCandidateCount"
>;

function documentCount(count: number): string {
	return `${count} document${count === 1 ? "" : "s"}`;
}

export function candidateReviewRecommendation(
	counts: CandidateReviewCounts,
): string | undefined {
	const { unclassifiedCandidateCount, changedClassifiedCandidateCount } = counts;
	if (unclassifiedCandidateCount === 0 && changedClassifiedCandidateCount === 0) {
		return undefined;
	}

	const unclassified =
		unclassifiedCandidateCount > 0
			? `${documentCount(unclassifiedCandidateCount)} ${unclassifiedCandidateCount === 1 ? "is" : "are"} unclassified and ${unclassifiedCandidateCount === 1 ? "requires" : "require"} review and classification.`
			: undefined;
	const changedClassified =
		changedClassifiedCandidateCount > 0
			? `${documentCount(changedClassifiedCandidateCount)} ${changedClassifiedCandidateCount === 1 ? "was" : "were"} previously classified, changed since classification, and ${changedClassifiedCandidateCount === 1 ? "requires" : "require"} review.`
			: undefined;

	if (unclassified && changedClassified) {
		return `${unclassified} ${changedClassified} Tell the user both kinds of candidate review remain, run \`idx wiki discover\`, and read each source. Classify unclassified documents with \`idx wiki record\`; for changed classified documents, review the existing classification/metadata and re-run \`idx wiki record\` when confirming or updating it. Changed classified candidates are already registered project knowledge; only unclassified candidates are not yet registered.`;
	}
	if (unclassified) {
		return `${unclassified} Tell the user unreviewed unclassified candidates remain, run \`idx wiki discover\`, read each source, then classify it with \`idx wiki record\`; do not treat unclassified candidates as registered project knowledge before review.`;
	}
	return `${changedClassified} Tell the user changed classified candidates still need review, run \`idx wiki discover\`, and read each changed source. Review the existing classification/metadata and re-run \`idx wiki record\` when confirming or updating it. These candidates are already registered project knowledge; do not describe them as unregistered.`;
}
