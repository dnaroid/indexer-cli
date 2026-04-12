import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ChunkOverlapSymbol,
	MetadataStore,
	SymbolRecord,
	VectorStore,
	EmbeddingProvider,
	ProjectId,
	VectorSearchFilters,
} from "../core/types.js";
import { SystemLogger } from "../core/logger.js";

const logger = new SystemLogger("search");
const IMPORT_CHUNK_SCORE_PENALTY = 0.5;
const PREAMBLE_CHUNK_SCORE_PENALTY = 0.7;
const TEST_FILE_SCORE_PENALTY = 0.75;
const SYMBOL_MATCH_THRESHOLD = 1;
const SYMBOL_NAME_TOKEN_WEIGHT = 3;
const SYMBOL_SIGNATURE_TOKEN_WEIGHT = 2;
const SYMBOL_BODY_TOKEN_WEIGHT = 2;
const SYMBOL_BODY_EXACT_BONUS = 1;
const SYMBOL_START_IN_CHUNK_BONUS = 0.25;

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"for",
	"get",
	"has",
	"is",
	"of",
	"on",
	"or",
	"set",
	"the",
	"to",
]);

interface RankedSymbolCandidate {
	symbol: ChunkOverlapSymbol;
	score: number;
}

const TEST_PATH_PATTERNS: RegExp[] = [
	/__tests?__\//i,
	/(?:^|\/)(?:tests?|spec|fixtures)\//i,
];

const TEST_FILE_PATTERNS_BY_EXTENSION: Record<string, RegExp> = {
	".ts": /\.(?:test|spec)\.ts$/i,
	".tsx": /\.(?:test|spec)\.tsx$/i,
	".js": /\.(?:test|spec)\.js$/i,
	".jsx": /\.(?:test|spec)\.jsx$/i,
	".mjs": /\.(?:test|spec)\.mjs$/i,
	".py": /(?:^|\/)(?:test_|_test\.py$)/i,
	".cs": /(?:tests?|specs?)\.cs$/i,
	".rb": /(?:^|\/)(?:_test\.rb$|_spec\.rb$)/i,
	".gd": /\.test\.gd$/i,
};

function isTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");

	for (const pattern of TEST_PATH_PATTERNS) {
		if (pattern.test(normalized)) return true;
	}

	const ext = normalized.substring(normalized.lastIndexOf("."));
	const extPattern = TEST_FILE_PATTERNS_BY_EXTENSION[ext];
	if (extPattern && extPattern.test(normalized)) return true;

	return false;
}

function stemToken(token: string): string {
	if (token.length > 5 && token.endsWith("ing")) {
		return token.slice(0, -3);
	}
	if (token.length > 4 && token.endsWith("ied")) {
		return `${token.slice(0, -3)}y`;
	}
	if (token.length > 4 && token.endsWith("ed")) {
		return token.slice(0, -2);
	}
	if (token.length > 4 && token.endsWith("es")) {
		return token.slice(0, -2);
	}
	if (token.length > 3 && token.endsWith("s")) {
		return token.slice(0, -1);
	}
	return token;
}

function normalizeTokens(input: string): string[] {
	return input
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_\-]+/g, " ")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.map((token) => stemToken(token.trim()))
		.filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function countTokenOverlap(queryTokens: Set<string>, text: string): number {
	const candidateTokens = new Set(normalizeTokens(text));
	let score = 0;
	for (const token of queryTokens) {
		if (candidateTokens.has(token)) {
			score += 1;
		}
	}
	return score;
}

function overlapsChunk(
	symbol: SymbolRecord,
	startLine: number,
	endLine: number,
): boolean {
	return (
		symbol.range.start.line <= endLine && symbol.range.end.line >= startLine
	);
}

function isFunctionLikeSymbol(symbol: SymbolRecord): boolean {
	return symbol.kind === "function" || symbol.kind === "method";
}

function toChunkOverlapSymbol(symbol: SymbolRecord): ChunkOverlapSymbol {
	return {
		name: symbol.name,
		kind: symbol.kind,
		startLine: symbol.range.start.line,
		endLine: symbol.range.end.line,
		signature: symbol.signature,
	};
}

function sliceLines(
	content: string,
	startLine: number,
	endLine: number,
): string {
	const lines = content.split("\n");
	const start = Math.max(0, startLine - 1);
	const end = Math.min(lines.length, endLine);
	return lines.slice(start, end).join("\n");
}

function scoreSymbolCandidate(
	symbol: ChunkOverlapSymbol,
	queryTokens: Set<string>,
	chunkStartLine: number,
	fileContent?: string,
): number {
	let score =
		countTokenOverlap(queryTokens, symbol.name) * SYMBOL_NAME_TOKEN_WEIGHT;

	if (symbol.signature) {
		score +=
			countTokenOverlap(queryTokens, symbol.signature) *
			SYMBOL_SIGNATURE_TOKEN_WEIGHT;
	}

	if (fileContent) {
		const symbolBody = sliceLines(
			fileContent,
			symbol.startLine,
			symbol.endLine,
		);
		const bodyOverlap = countTokenOverlap(queryTokens, symbolBody);
		score += bodyOverlap * SYMBOL_BODY_TOKEN_WEIGHT;
		if (bodyOverlap > 0) {
			score += SYMBOL_BODY_EXACT_BONUS;
		}
	}

	if (symbol.startLine >= chunkStartLine) {
		score += SYMBOL_START_IN_CHUNK_BONUS;
	}

	return score;
}

export interface SearchOptions {
	topK?: number;
	pathPrefix?: string;
	chunkTypes?: string[];
	filePath?: string;
	includeContent?: boolean;
	minScore?: number;
	includeImportChunks?: boolean;
}

export interface SearchResult {
	filePath: string;
	startLine: number;
	endLine: number;
	score: number;
	chunkType?: string;
	primarySymbol?: string;
	content?: string;
}

export class SearchEngine {
	constructor(
		private metadata: MetadataStore,
		private vectors: VectorStore,
		private embedder: EmbeddingProvider,
		private repoRoot: string,
	) {}

	async search(
		projectId: ProjectId,
		snapshotId: string,
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResult[]> {
		const topK = options.topK ?? 10;
		const includeContent = options.includeContent ?? true;
		const minScore = options.minScore;
		const excludeImportPreamble =
			!options.includeImportChunks && !options.chunkTypes;

		logger.info(`Searching for "${query}" (topK=${topK})`);

		const queryEmbedding = (await this.embedder.embed([query]))[0];
		if (!queryEmbedding) {
			throw new Error("Failed to generate query embedding");
		}

		const filters: VectorSearchFilters = {
			projectId,
			snapshotId,
			filePath: options.filePath,
			pathPrefix: options.pathPrefix,
			chunkTypes: options.chunkTypes,
		};

		const vectorResults = await this.vectors.search(
			queryEmbedding,
			topK,
			filters,
		);
		const queryTokens = new Set(normalizeTokens(query));
		const fileContentCache = new Map<string, string>();
		const symbolsByFileCache = new Map<string, SymbolRecord[]>();

		const getFileContent = async (filePath: string): Promise<string> => {
			const cached = fileContentCache.get(filePath);
			if (typeof cached === "string") {
				return cached;
			}

			try {
				const fullPath = join(this.repoRoot, filePath);
				const nextContent = await readFile(fullPath, "utf-8");
				fileContentCache.set(filePath, nextContent);
				return nextContent;
			} catch (err) {
				logger.warn(`Failed to read ${filePath}:`, err);
				fileContentCache.set(filePath, "");
				return "";
			}
		};

		const getSymbolsForFile = async (
			filePath: string,
		): Promise<SymbolRecord[]> => {
			const cached = symbolsByFileCache.get(filePath);
			if (cached) {
				return cached;
			}

			const symbols = await this.metadata.listSymbols(
				projectId,
				snapshotId,
				filePath,
			);
			symbolsByFileCache.set(filePath, symbols);
			return symbols;
		};

		const results: SearchResult[] = [];
		for (const vr of vectorResults) {
			let content: string | undefined;
			const overlappingSymbols = (await getSymbolsForFile(vr.filePath))
				.filter(isFunctionLikeSymbol)
				.filter((symbol) => overlapsChunk(symbol, vr.startLine, vr.endLine))
				.map(toChunkOverlapSymbol);
			const shouldReadFile =
				includeContent ||
				(queryTokens.size > 0 && overlappingSymbols.length > 0);
			const fileContent = shouldReadFile
				? await getFileContent(vr.filePath)
				: undefined;

			if (includeContent) {
				content = sliceLines(fileContent ?? "", vr.startLine, vr.endLine);
			}

			const bestSymbol = overlappingSymbols
				.map(
					(symbol): RankedSymbolCandidate => ({
						symbol,
						score: scoreSymbolCandidate(
							symbol,
							queryTokens,
							vr.startLine,
							fileContent,
						),
					}),
				)
				.sort((a, b) => b.score - a.score)[0];

			results.push({
				filePath: vr.filePath,
				startLine: vr.startLine,
				endLine: vr.endLine,
				score: vr.score,
				chunkType: vr.chunkType,
				primarySymbol:
					bestSymbol && bestSymbol.score >= SYMBOL_MATCH_THRESHOLD
						? bestSymbol.symbol.name
						: vr.primarySymbol,
				content,
			});
		}

		return results
			.filter((result) => {
				if (excludeImportPreamble) {
					return (
						result.chunkType !== "imports" && result.chunkType !== "preamble"
					);
				}
				return true;
			})
			.map((result) => {
				let penalizedScore = result.score;

				if (result.chunkType === "imports") {
					penalizedScore *= IMPORT_CHUNK_SCORE_PENALTY;
				} else if (result.chunkType === "preamble") {
					penalizedScore *= PREAMBLE_CHUNK_SCORE_PENALTY;
				}

				if (isTestFile(result.filePath)) {
					penalizedScore *= TEST_FILE_SCORE_PENALTY;
				}

				return {
					...result,
					score: penalizedScore,
				};
			})
			.filter(
				(result) => typeof minScore !== "number" || result.score >= minScore,
			)
			.sort((a, b) => b.score - a.score);
	}
}
