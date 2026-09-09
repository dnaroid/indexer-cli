import { computeHash } from "../utils/hash.js";
import { TokenEstimator } from "../utils/token-estimator.js";
import type { KnowledgeChunkRecord } from "../core/types.js";

export interface PreparedDocumentChunk
	extends Omit<KnowledgeChunkRecord, "projectId" | "snapshotId"> {
	content: string;
}

export interface DocumentChunkOptions {
	maxTokens?: number;
	fullFileMaxTokens?: number;
}

type Heading = {
	lineIndex: number;
	level: number;
	title: string;
};

const estimator = new TokenEstimator();

function cleanHeading(value: string): string {
	return value.replace(/\s+#+\s*$/, "").trim();
}

function findHeadings(lines: string[]): Heading[] {
	const result: Heading[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const atx = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
		if (atx) {
			result.push({
				lineIndex: index,
				level: atx[1].length,
				title: cleanHeading(atx[2]),
			});
			continue;
		}

		const asciidoc = line.match(/^(={1,6})\s+(.+?)\s*$/);
		if (asciidoc) {
			result.push({
				lineIndex: index,
				level: asciidoc[1].length,
				title: asciidoc[2].trim(),
			});
			continue;
		}

		const next = lines[index + 1];
		if (
			line.trim() &&
			next &&
			/^\s*(?:={3,}|-{3,}|~{3,}|\^{3,})\s*$/.test(next)
		) {
			result.push({
				lineIndex: index,
				level: next.trim().startsWith("=") ? 1 : 2,
				title: line.trim(),
			});
			index += 1;
		}
	}
	return result;
}

function splitRangeByTokenBudget(
	lines: string[],
	startIndex: number,
	endIndexExclusive: number,
	maxTokens: number,
): Array<{ startIndex: number; endIndexExclusive: number; content: string }> {
	const result: Array<{
		startIndex: number;
		endIndexExclusive: number;
		content: string;
	}> = [];
	let cursor = startIndex;

	while (cursor < endIndexExclusive) {
		let end = cursor + 1;
		let bestEnd = end;
		while (end <= endIndexExclusive) {
			const content = lines.slice(cursor, end).join("\n").trim();
			if (content && estimator.estimate(content) <= maxTokens) {
				bestEnd = end;
				end += 1;
				continue;
			}
			break;
		}

		if (bestEnd <= cursor) bestEnd = cursor + 1;
		const content = lines.slice(cursor, bestEnd).join("\n").trim();
		if (content) {
			result.push({ startIndex: cursor, endIndexExclusive: bestEnd, content });
		}
		cursor = bestEnd;
	}

	return result;
}

function chunkId(
	filePath: string,
	startLine: number,
	endLine: number,
	chunkType: KnowledgeChunkRecord["chunkType"],
	contentHash: string,
): string {
	return `doc:${computeHash(`${filePath}:${startLine}:${endLine}:${chunkType}:${contentHash}`)}`;
}

function makeChunk(
	filePath: string,
	chunkType: KnowledgeChunkRecord["chunkType"],
	content: string,
	startIndex: number,
	endIndexExclusive: number,
	heading?: string,
	metadata?: Record<string, unknown>,
): PreparedDocumentChunk {
	const contentHash = computeHash(content);
	const startLine = startIndex + 1;
	const endLine = Math.max(startLine, endIndexExclusive);
	return {
		chunkId: chunkId(filePath, startLine, endLine, chunkType, contentHash),
		filePath,
		startLine,
		endLine,
		contentHash,
		chunkType,
		heading,
		metadata,
		content,
	};
}

export function chunkDocument(
	filePath: string,
	content: string,
	options: DocumentChunkOptions = {},
): PreparedDocumentChunk[] {
	const maxTokens = Math.max(64, options.maxTokens ?? 700);
	const fullFileMaxTokens = Math.max(64, options.fullFileMaxTokens ?? 400);
	const normalized = content.replace(/\r\n/g, "\n").replace(/\uFEFF/g, "");
	const lines = normalized.split("\n");
	const headings = findHeadings(lines);
	const chunks: PreparedDocumentChunk[] = [];

	if (headings.length === 0) {
		for (const part of splitRangeByTokenBudget(lines, 0, lines.length, maxTokens)) {
			chunks.push(
				makeChunk(
					filePath,
					"doc_full",
					part.content,
					part.startIndex,
					part.endIndexExclusive,
				),
			);
		}
		return chunks;
	}

	const firstHeadingIndex = headings[0]?.lineIndex ?? 0;
	if (firstHeadingIndex > 0) {
		for (const part of splitRangeByTokenBudget(
			lines,
			0,
			firstHeadingIndex,
			maxTokens,
		)) {
			chunks.push(
				makeChunk(
					filePath,
					"doc_title",
					part.content,
					part.startIndex,
					part.endIndexExclusive,
				),
			);
		}
	}

	for (let index = 0; index < headings.length; index += 1) {
		const heading = headings[index];
		if (!heading) continue;
		const next = headings[index + 1];
		const endIndexExclusive = next?.lineIndex ?? lines.length;
		for (const part of splitRangeByTokenBudget(
			lines,
			heading.lineIndex,
			endIndexExclusive,
			maxTokens,
		)) {
			chunks.push(
				makeChunk(
					filePath,
					"doc_section",
					part.content,
					part.startIndex,
					part.endIndexExclusive,
					heading.title,
					{ headingLevel: heading.level },
				),
			);
		}
	}

	const trimmed = normalized.trim();
	if (trimmed && estimator.estimate(trimmed) <= fullFileMaxTokens) {
		chunks.push(
			makeChunk(
				filePath,
				"doc_full",
				trimmed,
				0,
				lines.length,
			),
		);
	}

	return chunks;
}

