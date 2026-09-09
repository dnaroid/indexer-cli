import path from "node:path";

export type KnowledgeRoleHint =
	| "spec-candidate"
	| "meta-index"
	| "design-reference"
	| "weak-candidate";

export interface KnowledgeDiscoverySignals {
	score: number;
	roleHint: KnowledgeRoleHint;
	signals: string[];
}

const SPEC_NAME_RE = /(?:^|[-_.])(spec|contract|requirements?|rfc|protocol|behavior)(?:[-_.]|$)/i;
const DESIGN_NAME_RE = /(?:^|[-_.])(adr|design|decision|evidence|measurement|review)(?:[-_.]|$)/i;
const META_NAME_RE = /^(?:readme|overview|index|catalog|contents|toc|documentation)$/i;
const SPEC_DIR_NAMES = new Set([
	"spec",
	"specs",
	"contracts",
	"requirements",
	"rfcs",
	"rfc",
	"protocols",
]);
const FIXTURE_DIR_NAMES = new Set([
	"evals",
	"fixtures",
	"fixture",
	"examples",
	"example",
	"testdata",
	"samples",
	"sample",
]);
const SKILL_RESOURCE_DIR_NAMES = new Set(["skills", "agents"]);

const CONTRACT_HEADINGS = new Set([
	"behavior",
	"behaviour",
	"requirement",
	"requirements",
	"contract",
	"contracts",
	"invariant",
	"invariants",
	"scope",
	"non-goal",
	"non-goals",
	"acceptance",
	"verification",
	"compatibility",
	"edge cases",
	"risks",
]);

const META_TEXT_RE = /\b(?:table of contents|documentation index|spec inventory|spec catalog|overview of (?:the )?(?:specs|documents)|generated (?:index|catalog))\b/i;
const TYPE_AS_IS_RE = /\b(?:as[- ]is|current behavior|current behaviour|existing behavior|existing behaviour)\b/i;
const TYPE_CHANGE_RE = /\b(?:intended behavior|intended behaviour|proposed behavior|proposed behaviour|change spec|target behavior|target behaviour)\b/i;
const PATH_REFERENCE_RE = /(?<![\w/])(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+\-]+\.[A-Za-z0-9]{1,12}/g;
const MARKDOWN_DOC_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

function hasAny(set: Set<string>, values: Iterable<string>): boolean {
	for (const value of values) {
		if (set.has(value)) return true;
	}
	return false;
}

function headingText(line: string): string | null {
	const atx = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
	if (atx) return atx[1].trim().toLowerCase();
	const asciidoc = line.match(/^={1,6}\s+(.+?)\s*$/);
	if (asciidoc) return asciidoc[1].trim().toLowerCase();
	return null;
}

function normalizeHeading(value: string): string {
	return value.replace(/[:：]\s*$/, "").trim().toLowerCase();
}

function docLinkCount(text: string): number {
	let count = 0;
	for (const match of text.matchAll(MARKDOWN_DOC_LINK_RE)) {
		const target = (match[1] ?? "").split("#", 1)[0]?.split("?", 1)[0] ?? "";
		if (/\.(?:md|mdx|rst|adoc|txt)$/i.test(target.trim())) count += 1;
	}
	return count;
}

export function documentTitle(text: string, filePath: string): string {
	const lines = text.split(/\r?\n/).slice(0, 80);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const heading = headingText(line);
		if (heading) return line.replace(/^\s*(?:#{1,6}|={1,6})\s+/, "").replace(/\s*#*\s*$/, "").trim();
		const next = lines[index + 1];
		if (line.trim() && next && /^\s*[=~^-]{3,}\s*$/.test(next)) {
			return line.trim();
		}
	}
	return path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ").trim();
}

export function knowledgeDiscoverySignals(
	filePath: string,
	text: string,
	options: { forced?: boolean } = {},
): KnowledgeDiscoverySignals {
	let score = 0;
	const signals: string[] = [];
	const normalizedPath = filePath.replace(/\\/g, "/");
	const parts = normalizedPath.split("/");
	const stem = path.basename(normalizedPath, path.extname(normalizedPath));
	const directoryParts = parts.slice(0, -1).map((part) => part.toLowerCase());
	const forced = options.forced ?? false;

	if (forced) {
		score += 100;
		signals.push("forced-by-config");
	}
	if (SPEC_NAME_RE.test(stem)) {
		score += 4;
		signals.push("spec-like-filename");
	}
	if (hasAny(SPEC_DIR_NAMES, directoryParts)) {
		score += 3;
		signals.push("spec-like-directory");
	}
	const noisyResourcePath =
		!forced &&
		(hasAny(FIXTURE_DIR_NAMES, directoryParts) ||
			hasAny(SKILL_RESOURCE_DIR_NAMES, directoryParts));
	if (!forced && hasAny(FIXTURE_DIR_NAMES, directoryParts)) {
		score -= 12;
		signals.push("fixture-like-path");
	}
	if (!forced && hasAny(SKILL_RESOURCE_DIR_NAMES, directoryParts)) {
		score -= 12;
		signals.push("skill-resource-path");
	}
	if (DESIGN_NAME_RE.test(stem)) {
		score += 3;
		signals.push("design-like-filename");
	}

	const headings = new Set<string>();
	const lines = text.split(/\r?\n/).slice(0, 500);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const direct = headingText(line);
		if (direct) headings.add(normalizeHeading(direct));
		const next = lines[index + 1];
		if (line.trim() && next && /^\s*[=~^-]{3,}\s*$/.test(next)) {
			headings.add(normalizeHeading(line));
		}
	}
	const contractHeadings = [...headings].filter((heading) => CONTRACT_HEADINGS.has(heading));
	if (contractHeadings.length > 0) {
		score += Math.min(6, contractHeadings.length * 2);
		signals.push(`contract-headings:${contractHeadings.slice(0, 4).join(",")}`);
	}

	const sample = text.slice(0, 30_000);
	if (TYPE_AS_IS_RE.test(sample)) {
		score += 1;
		signals.push("as-is-language");
	}
	if (TYPE_CHANGE_RE.test(sample)) {
		score += 1;
		signals.push("change-language");
	}
	const pathReferences = new Set(text.slice(0, 100_000).match(PATH_REFERENCE_RE) ?? []);
	if (pathReferences.size > 0) {
		score += pathReferences.size < 3 ? 1 : 2;
		signals.push(`path-references:${Math.min(pathReferences.size, 99)}`);
	}

	let metaScore = 0;
	if (META_NAME_RE.test(stem)) {
		metaScore += 3;
		signals.push("meta-like-filename");
	}
	if (META_TEXT_RE.test(sample)) {
		metaScore += 4;
		signals.push("meta-index-language");
	}
	const links = docLinkCount(text.slice(0, 100_000));
	if (links >= 4) {
		metaScore += 2;
		signals.push(`many-doc-links:${Math.min(links, 99)}`);
	}
	const title = documentTitle(text, filePath);
	if (/\b(?:specs? index|spec inventory|documentation index)\b/i.test(title)) {
		metaScore += 4;
		signals.push("meta-like-title");
	}

	let roleHint: KnowledgeRoleHint;
	if (noisyResourcePath) roleHint = "weak-candidate";
	else if (metaScore >= 5) roleHint = "meta-index";
	else if (score >= 4) roleHint = "spec-candidate";
	else if (DESIGN_NAME_RE.test(stem)) roleHint = "design-reference";
	else roleHint = "weak-candidate";

	return { score, roleHint, signals };
}

