import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

const PACKAGE_MARKERS = [
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"Package.swift",
];

const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const BACKTICK_RE = /`([^`\n]+)`/g;
const PLAIN_PATH_RE = /(?<![\w/])(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+\-]+\.[A-Za-z0-9]{1,12}/g;
const RELATIVE_BASE_RE = /(?:paths?|references?|files?)\b[^\n]{0,80}?\brelative\s+to\s+`([^`]+)`/gi;

export interface ExplicitKnowledgeRelations {
	code: string[];
	knowledge: string[];
	unresolved: string[];
}

function markdownDestination(token: string): string {
	const trimmed = token.trim();
	if (trimmed.startsWith("<")) {
		const end = trimmed.indexOf(">", 1);
		return end >= 0 ? trimmed.slice(1, end) : trimmed;
	}

	let result = "";
	let escaped = false;
	let parenDepth = 0;
	for (const char of trimmed) {
		if (escaped) {
			result += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "(") parenDepth += 1;
		if (char === ")" && parenDepth > 0) parenDepth -= 1;
		if (/\s/.test(char) && parenDepth === 0) break;
		result += char;
	}
	if (escaped) result += "\\";
	return result;
}

export function cleanReferenceToken(token: string): string | null {
	let value = markdownDestination(token).trim().replace(/^[<>"']+|[<>"']+$/g, "");
	value = value.split("#", 1)[0]?.split("?", 1)[0]?.trim() ?? "";
	if (!value) return null;
	if (/^(?:https?:|mailto:|data:|#|~)/i.test(value)) return null;
	if (value.includes(" ") && !value.startsWith("./") && !value.startsWith("../")) {
		return null;
	}
	return value.replace(/\\/g, "/");
}

export function expandReferenceToken(token: string): string[] {
	const cleaned = cleanReferenceToken(token);
	if (!cleaned) return [];
	const match = cleaned.match(/\{([^{}]+)\}/);
	if (!match || match.index === undefined) return [cleaned];
	const choices = match[1]
		.split(",")
		.map((choice) => choice.trim())
		.filter(Boolean);
	if (choices.length === 0) return [cleaned];
	return choices.map(
		(choice) =>
			`${cleaned.slice(0, match.index)}${choice}${cleaned.slice(
				(match.index ?? 0) + match[0].length,
			)}`,
	);
}

export function strongUnresolvedPathHint(token: string): boolean {
	if (!token || /^(?:\/|~|\$|\.\.\.)/.test(token)) return false;
	if (token.includes("://") || token.includes("::") || /[*?<>|]/.test(token)) {
		return false;
	}
	if (token.endsWith("/")) return false;
	const extension = path.extname(token).toLowerCase();
	if (!extension || extension.length > 13) return false;
	const first = token.replace(/^\.\//, "").split("/", 1)[0]?.toLowerCase();
	return (
		new Set([
			"src",
			"test",
			"tests",
			"docs",
			"doc",
			"spec",
			"specs",
			"external",
			"desktop",
			"acp",
			"lib",
			"packages",
			"package",
			".pi",
			"schemas",
		]).has(first ?? "") || token.startsWith("./") || token.startsWith("../")
	);
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

async function isDirectory(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isDirectory();
	} catch {
		return false;
	}
}

async function packageReferenceRoots(rootPath: string, sourcePath: string): Promise<string[]> {
	const root = await realpath(rootPath);
	let current = path.dirname(path.join(root, sourcePath));
	const result = [current];

	while (current !== root && path.dirname(current) !== current) {
		let markerFound = false;
		for (const marker of PACKAGE_MARKERS) {
			try {
				await access(path.join(current, marker));
				markerFound = true;
				break;
			} catch {
				// continue
			}
		}
		if (markerFound && !result.includes(current)) result.push(current);
		current = path.dirname(current);
	}
	if (!result.includes(root)) result.push(root);
	return result;
}

async function explicitReferenceBases(rootPath: string, text: string): Promise<string[]> {
	const root = await realpath(rootPath);
	const bases: string[] = [];
	for (const match of text.slice(0, 20_000).matchAll(RELATIVE_BASE_RE)) {
		const cleaned = cleanReferenceToken(match[1] ?? "");
		if (!cleaned) continue;
		const candidate = path.resolve(root, cleaned);
		const relative = path.relative(root, candidate);
		if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
		if (await isDirectory(candidate)) bases.push(candidate);
	}
	return [...new Set(bases)];
}

async function resolveReference(
	rootPath: string,
	sourcePath: string,
	token: string,
	extraBases: string[],
): Promise<string | null> {
	const cleaned = cleanReferenceToken(token);
	if (!cleaned || cleaned.startsWith("...")) return null;
	const root = await realpath(rootPath);
	const bases = [
		...extraBases,
		...(await packageReferenceRoots(root, sourcePath)),
	];
	const candidates = path.isAbsolute(cleaned)
		? [cleaned]
		: bases.map((base) => path.resolve(base, cleaned));

	for (const candidate of candidates) {
		try {
			const resolved = await realpath(candidate);
			const relative = path.relative(root, resolved);
			if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
				continue;
			}
			if (await isFile(resolved)) return relative.replace(/\\/g, "/");
		} catch {
			// try next base
		}
	}
	return null;
}

function extractTokens(text: string): string[] {
	const result: string[] = [];
	for (const match of text.matchAll(MARKDOWN_LINK_RE)) result.push(match[1] ?? "");
	for (const match of text.matchAll(BACKTICK_RE)) result.push(match[1] ?? "");
	for (const match of text.matchAll(PLAIN_PATH_RE)) result.push(match[0] ?? "");
	return result;
}

export async function extractExplicitKnowledgeRelations(
	rootPath: string,
	sourcePath: string,
	text: string,
	documentExtensions: Iterable<string> = [".md", ".mdx", ".rst", ".adoc", ".txt"],
): Promise<ExplicitKnowledgeRelations> {
	const documentExtensionSet = new Set(
		[...documentExtensions].map((extension) => extension.toLowerCase()),
	);
	const extraBases = await explicitReferenceBases(rootPath, text);
	const resolved = new Set<string>();
	const unresolved = new Set<string>();

	for (const rawToken of extractTokens(text)) {
		const expanded = expandReferenceToken(rawToken);
		if (expanded.length === 0) continue;
		let tokenResolved = false;
		for (const token of expanded) {
			const target = await resolveReference(
				rootPath,
				sourcePath,
				token,
				extraBases,
			);
			if (target && target !== sourcePath.replace(/\\/g, "/")) {
				resolved.add(target);
				tokenResolved = true;
			}
		}
		const cleaned = cleanReferenceToken(rawToken);
		if (
			!tokenResolved &&
			cleaned &&
			cleaned.length <= 300 &&
			strongUnresolvedPathHint(cleaned)
		) {
			unresolved.add(cleaned);
		}
	}

	const code: string[] = [];
	const knowledge: string[] = [];
	for (const target of [...resolved].sort()) {
		if (documentExtensionSet.has(path.extname(target).toLowerCase())) {
			knowledge.push(target);
		} else {
			code.push(target);
		}
	}

	const resolvedValues = [...resolved];
	const unresolvedValues = [...unresolved]
		.filter(
			(token) =>
				!resolvedValues.some(
					(target) =>
						target === token.replace(/^\.\//, "") ||
						target.endsWith(`/${token.replace(/^\.\//, "")}`),
				),
		)
		.sort()
		.slice(0, 50);

	return { code, knowledge, unresolved: unresolvedValues };
}

