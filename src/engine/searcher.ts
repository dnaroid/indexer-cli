import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type {
	ChunkRecord,
	ChunkOverlapSymbol,
	CodeLexicalSearchResult,
	EmbeddingProvider,
	MetadataStore,
	ProjectId,
	SymbolRecord,
	VectorSearchFilters,
	VectorSearchResult,
	VectorStore,
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
const HYBRID_CANDIDATE_MULTIPLIER = 8;
const HYBRID_MIN_CANDIDATES = 40;
const RRF_K = 50;

type SearchMode = "hybrid" | "semantic" | "lexical" | "symbol";
type SearchChannel = "semantic" | "lexical" | "symbol" | "path";

const CHANNEL_WEIGHTS: Record<SearchChannel, number> = {
	semantic: 1,
	lexical: 1.05,
	symbol: 1.2,
	path: 0.85,
};

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

const TEST_INTENT_TERMS = new Set([
	"test",
	"tests",
	"testing",
	"spec",
	"specs",
	"fixture",
	"fixtures",
	"mock",
	"mocks",
	"e2e",
]);

const LANGUAGE_KEYWORDS = new Set([
	"if",
	"else",
	"for",
	"while",
	"do",
	"switch",
	"case",
	"break",
	"continue",
	"return",
	"throw",
	"try",
	"catch",
	"finally",
	"new",
	"delete",
	"typeof",
	"instanceof",
	"in",
	"of",
	"void",
	"class",
	"extends",
	"super",
	"import",
	"export",
	"default",
	"const",
	"let",
	"var",
	"function",
	"async",
	"await",
	"yield",
	"with",
	"debugger",
	"enum",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
	"static",
	"abstract",
	"readonly",
	"declare",
	"type",
	"namespace",
	"module",
	"from",
	"as",
	"get",
	"set",
	"true",
	"false",
	"null",
	"undefined",
	"this",
	"def",
	"elif",
	"except",
	"lambda",
	"pass",
	"raise",
	"assert",
	"global",
	"nonlocal",
	"not",
	"end",
	"then",
	"begin",
	"fn",
	"mut",
	"pub",
	"use",
	"mod",
	"crate",
	"impl",
	"trait",
	"where",
	"loop",
	"match",
	"move",
	"ref",
	"struct",
	"Self",
	"self",
	"unsafe",
	"extern",
]);

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
	".py": /(?:^|\/)(?:test_|.*_test\.py$)/i,
	".cs": /(?:tests?|specs?)\.cs$/i,
	".rb": /(?:^|\/)(?:.*_test\.rb$|.*_spec\.rb$)/i,
	".gd": /\.test\.gd$/i,
	".c": /(?:^|\/)(?:test_|.*(?:_test|_spec)\.c$)/i,
	".cc": /(?:^|\/)(?:test_|.*(?:_test|_spec)\.cc$)/i,
	".cpp": /(?:^|\/)(?:test_|.*(?:_test|_spec)\.cpp$)/i,
	".cxx": /(?:^|\/)(?:test_|.*(?:_test|_spec)\.cxx$)/i,
	".h": /(?:^|\/)(?:test_|.*(?:_test|_spec)\.h$)/i,
	".hpp": /(?:^|\/)(?:test_|.*(?:_test|_spec)\.hpp$)/i,
};

export function isTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	for (const pattern of TEST_PATH_PATTERNS) {
		if (pattern.test(normalized)) return true;
	}
	const ext = normalized.substring(normalized.lastIndexOf("."));
	const extPattern = TEST_FILE_PATTERNS_BY_EXTENSION[ext];
	return Boolean(extPattern?.test(normalized));
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function stemToken(token: string): string {
	if (!/^[a-z0-9]+$/i.test(token)) return token;
	if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
	if (token.length > 4 && token.endsWith("ied")) return `${token.slice(0, -3)}y`;
	if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
	if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
	if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
	return token;
}

function rawSearchTokens(input: string): string[] {
	const expanded = input
		.normalize("NFKC")
		.replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
		.replace(/[_\-./\\:]+/g, " ")
		.toLocaleLowerCase();
	return (expanded.match(/[\p{L}\p{N}]+/gu) ?? [])
		.map((token) => token.trim())
		.filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

export function normalizeSearchTokens(input: string): string[] {
	return rawSearchTokens(input)
		.map((token) => stemToken(token.trim()))
		.filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

function compactSearchText(input: string): string {
	return normalizeSearchTokens(input).join("");
}

function rawIdentifierTerm(query: string): string | undefined {
	const trimmed = query.normalize("NFKC").trim();
	if (!trimmed || /\s/u.test(trimmed)) return undefined;
	if (!/^[\p{L}\p{N}_$.-]+$/u.test(trimmed)) return undefined;
	return trimmed.toLocaleLowerCase();
}

function uniqueTokens(input: string): string[] {
	return [...new Set(normalizeSearchTokens(input))];
}

function countTokenOverlap(queryTokens: Set<string>, text: string): number {
	const candidateTokens = new Set(normalizeSearchTokens(text));
	let score = 0;
	for (const token of queryTokens) {
		if (candidateTokens.has(token)) score += 1;
	}
	return score;
}

function tokenCoverage(queryTokens: Set<string>, text: string): number {
	if (queryTokens.size === 0) return 0;
	return countTokenOverlap(queryTokens, text) / queryTokens.size;
}

function overlapsChunk(
	symbol: SymbolRecord,
	startLine: number,
	endLine: number,
): boolean {
	return symbol.range.start.line <= endLine && symbol.range.end.line >= startLine;
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

function sliceLines(content: string, startLine: number, endLine: number): string {
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
	let score = countTokenOverlap(queryTokens, symbol.name) * SYMBOL_NAME_TOKEN_WEIGHT;
	if (symbol.signature) {
		score +=
			countTokenOverlap(queryTokens, symbol.signature) * SYMBOL_SIGNATURE_TOKEN_WEIGHT;
	}
	if (fileContent) {
		const symbolBody = sliceLines(fileContent, symbol.startLine, symbol.endLine);
		const bodyOverlap = countTokenOverlap(queryTokens, symbolBody);
		score += bodyOverlap * SYMBOL_BODY_TOKEN_WEIGHT;
		if (bodyOverlap > 0) score += SYMBOL_BODY_EXACT_BONUS;
	}
	if (symbol.startLine >= chunkStartLine) score += SYMBOL_START_IN_CHUNK_BONUS;
	return score;
}

function scoreSymbolMatch(
	query: string,
	queryTokens: Set<string>,
	symbol: SymbolRecord,
): number {
	if (queryTokens.size === 0) return 0;
	const symbolTokens = uniqueTokens(symbol.name);
	if (symbolTokens.length === 0) return 0;
	const queryCompact = compactSearchText(query);
	const symbolCompact = compactSearchText(symbol.name);
	if (queryCompact && queryCompact === symbolCompact) return 1;

	const symbolSet = new Set(symbolTokens);
	let matched = 0;
	for (const token of queryTokens) {
		if (symbolSet.has(token)) matched += 1;
	}
	if (matched === 0) return 0;
	const coverage = matched / queryTokens.size;
	const specificity = matched / symbolSet.size;
	const exactTokenSet = coverage === 1 && specificity === 1;
	if (exactTokenSet) return 0.98;
	return clamp01(0.15 + coverage * 0.6 + specificity * 0.2 + (symbol.exported ? 0.03 : 0));
}

function scorePathMatch(
	query: string,
	queryTokens: Set<string>,
	filePath: string,
): number {
	const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "").toLocaleLowerCase();
	const normalizedQuery = query
		.normalize("NFKC")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.trim()
		.toLocaleLowerCase();
	if (!normalizedQuery) return 0;
	if (normalizedPath === normalizedQuery) return 1;
	const name = basename(normalizedPath);
	if (name === normalizedQuery) return 0.98;
	const stem = name.slice(0, Math.max(0, name.length - extname(name).length));
	if (stem === normalizedQuery) return 0.96;
	if (queryTokens.size === 0) return 0;

	const pathTokens = new Set(uniqueTokens(normalizedPath));
	let matched = 0;
	for (const token of queryTokens) {
		if (pathTokens.has(token)) matched += 1;
	}
	if (matched === 0) return 0;
	const coverage = matched / queryTokens.size;
	const specificity = matched / Math.max(1, pathTokens.size);
	return clamp01(0.2 + coverage * 0.6 + specificity * 0.2);
}

function scoreLexicalMatch(
	query: string,
	queryTokens: Set<string>,
	result: Pick<
		CodeLexicalSearchResult,
		"filePath" | "primarySymbol" | "content"
	>,
): number {
	if (queryTokens.size === 0) return 0;
	const text = `${result.filePath}\n${result.primarySymbol ?? ""}\n${result.content}`;
	const coverage = tokenCoverage(queryTokens, text);
	if (coverage === 0) return 0;
	const normalizedQuery = normalizeSearchTokens(query).join(" ");
	const normalizedText = normalizeSearchTokens(text).join(" ");
	const phraseBonus =
		normalizedQuery.length >= 4 && normalizedText.includes(normalizedQuery) ? 0.1 : 0;
	const symbolCoverage = result.primarySymbol
		? tokenCoverage(queryTokens, result.primarySymbol)
		: 0;
	return clamp01(0.15 + coverage * 0.7 + phraseBonus + symbolCoverage * 0.05);
}

function matchesPrefix(filePath: string, pathPrefix?: string): boolean {
	if (!pathPrefix) return true;
	const normalized = pathPrefix.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	return filePath === normalized || filePath.startsWith(`${normalized}/`);
}

function matchesChunkFilters(chunk: ChunkRecord, options: SearchOptions): boolean {
	if (options.filePath && chunk.filePath !== options.filePath) return false;
	if (!matchesPrefix(chunk.filePath, options.pathPrefix)) return false;
	if (options.chunkTypes && options.chunkTypes.length > 0) {
		return Boolean(chunk.chunkType && options.chunkTypes.includes(chunk.chunkType));
	}
	return true;
}

function queryHasTestIntent(queryTokens: Set<string>): boolean {
	for (const token of queryTokens) {
		if (TEST_INTENT_TERMS.has(token)) return true;
	}
	return false;
}

interface ChannelEvidence {
	rank: number;
	confidence: number;
}

interface InternalCandidate {
	key: string;
	chunkId?: string;
	filePath: string;
	startLine: number;
	endLine: number;
	chunkType?: string;
	primarySymbol?: string;
	content?: string;
	channels: Partial<Record<SearchChannel, ChannelEvidence>>;
}

function candidateKey(input: {
	chunkId?: string;
	filePath: string;
	startLine: number;
	endLine: number;
}): string {
	return input.chunkId ?? `${input.filePath}:${input.startLine}-${input.endLine}`;
}

function mergeCandidate(
	candidates: Map<string, InternalCandidate>,
	input: Omit<InternalCandidate, "key" | "channels"> & {
		channel: SearchChannel;
		rank: number;
		confidence: number;
	},
): void {
	if (input.confidence <= 0) return;
	const key = candidateKey(input);
	const existing = candidates.get(key);
	if (existing) {
		existing.chunkId ??= input.chunkId;
		existing.primarySymbol ??= input.primarySymbol;
		existing.chunkType ??= input.chunkType;
		existing.content ??= input.content;
		const previous = existing.channels[input.channel];
		if (!previous || input.confidence > previous.confidence) {
			existing.channels[input.channel] = {
				rank: Math.min(previous?.rank ?? input.rank, input.rank),
				confidence: input.confidence,
			};
		}
		return;
	}
	const { channel, rank, confidence, ...base } = input;
	candidates.set(key, {
		...base,
		key,
		channels: { [channel]: { rank, confidence } },
	});
}

function normalizedRrf(candidate: InternalCandidate): number {
	let numerator = 0;
	let denominator = 0;
	for (const channel of Object.keys(CHANNEL_WEIGHTS) as SearchChannel[]) {
		const weight = CHANNEL_WEIGHTS[channel];
		denominator += weight / (RRF_K + 1);
		const evidence = candidate.channels[channel];
		if (evidence) numerator += weight / (RRF_K + evidence.rank);
	}
	return denominator > 0 ? clamp01(numerator / denominator) : 0;
}

function hybridConfidence(candidate: InternalCandidate): number {
	let maxConfidence = 0;
	let weightedConfidence = 0;
	let totalWeight = 0;
	for (const channel of Object.keys(CHANNEL_WEIGHTS) as SearchChannel[]) {
		const weight = CHANNEL_WEIGHTS[channel];
		totalWeight += weight;
		const confidence = candidate.channels[channel]?.confidence ?? 0;
		maxConfidence = Math.max(maxConfidence, confidence);
		weightedConfidence += confidence * weight;
	}
	const averageConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;
	return clamp01(maxConfidence * 0.7 + averageConfidence * 0.2 + normalizedRrf(candidate) * 0.1);
}

function buildReasonCode(candidate: InternalCandidate): string {
	const reasons: string[] = [];
	if (candidate.channels.symbol) reasons.push("symbol");
	if (candidate.channels.path) reasons.push("path");
	if (candidate.channels.lexical) reasons.push("text");
	if (candidate.channels.semantic) reasons.push("semantic");
	if (candidate.chunkType === "imports") reasons.push("imports");
	else if (candidate.chunkType === "preamble") reasons.push("preamble");
	return reasons.length > 0 ? reasons.join("+") : "semantic";
}

export interface SearchOptions {
	topK?: number;
	mode?: SearchMode;
	pathPrefix?: string;
	chunkTypes?: string[];
	filePath?: string;
	includeContent?: boolean;
	includeReasonCodes?: boolean;
	minScore?: number;
	includeImportChunks?: boolean;
	dedupeFile?: boolean;
	dedupeSymbol?: boolean;
	cluster?: boolean;
	includeTests?: boolean;
	excludeTests?: boolean;
}

export interface SearchResult {
	filePath: string;
	startLine: number;
	endLine: number;
	score: number;
	chunkType?: string;
	primarySymbol?: string;
	reasonCode?: string;
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
		const topK = Math.max(1, options.topK ?? 10);
		const mode = options.mode ?? "semantic";
		const includeContent = options.includeContent ?? true;
		const minScore = options.minScore;
		const candidateLimit = Math.max(
			topK * HYBRID_CANDIDATE_MULTIPLIER,
			HYBRID_MIN_CANDIDATES,
		);
		const queryTokenList = uniqueTokens(query);
		const queryTokens = new Set(queryTokenList);
		const rawIdentifier = rawIdentifierTerm(query);
		const lexicalTerms = [
			...new Set([
				...rawSearchTokens(query),
				...queryTokenList,
				...(rawIdentifier && !queryTokenList.includes(rawIdentifier)
					? [rawIdentifier]
					: []),
			]),
		];
		const excludeImportPreamble =
			!options.includeImportChunks && !options.chunkTypes;
		const applyTestPenalty =
			!options.includeTests && !queryHasTestIntent(queryTokens);

		logger.info(`Searching for "${query}" (topK=${topK}, mode=${mode})`);

		const filters: VectorSearchFilters = {
			projectId,
			snapshotId,
			filePath: options.filePath,
			pathPrefix: options.pathPrefix,
			chunkTypes: options.chunkTypes,
		};

		const chunksByFile = new Map<string, ChunkRecord[]>();
		const symbolsByFile = new Map<string, SymbolRecord[]>();
		const fileContentCache = new Map<string, string>();
		const getChunksForFile = async (filePath: string): Promise<ChunkRecord[]> => {
			const cached = chunksByFile.get(filePath);
			if (cached) return cached;
			const chunks = await this.metadata.listChunks(projectId, snapshotId, filePath);
			chunksByFile.set(filePath, chunks);
			return chunks;
		};
		const getSymbolsForFile = async (filePath: string): Promise<SymbolRecord[]> => {
			const cached = symbolsByFile.get(filePath);
			if (cached) return cached;
			const symbols = await this.metadata.listSymbols(projectId, snapshotId, filePath);
			symbolsByFile.set(filePath, symbols);
			return symbols;
		};
		const getFileContent = async (filePath: string): Promise<string> => {
			const cached = fileContentCache.get(filePath);
			if (typeof cached === "string") return cached;
			try {
				const content = await readFile(join(this.repoRoot, filePath), "utf-8");
				fileContentCache.set(filePath, content);
				return content;
			} catch (error) {
				logger.warn(`Failed to read ${filePath}:`, error);
				fileContentCache.set(filePath, "");
				return "";
			}
		};

		const candidates = new Map<string, InternalCandidate>();

		if (mode === "semantic" || mode === "hybrid") {
			const semantic = await this.semanticCandidates(
				query,
				mode === "semantic" ? topK : candidateLimit,
				filters,
			);
			semantic.forEach((result, index) => {
				mergeCandidate(candidates, {
					chunkId: result.chunkId,
					filePath: result.filePath,
					startLine: result.startLine,
					endLine: result.endLine,
					chunkType: result.chunkType,
					primarySymbol: result.primarySymbol,
					channel: "semantic",
					rank: index + 1,
					confidence: clamp01(result.score),
				});
			});
		}

		if (mode === "lexical" || mode === "hybrid") {
			const lexical = await this.metadata.searchCodeChunks(
				projectId,
				snapshotId,
				lexicalTerms,
				{
					limit: candidateLimit,
					pathPrefix: options.pathPrefix,
					filePath: options.filePath,
					chunkTypes: options.chunkTypes,
				},
			);
			for (const result of lexical) {
				mergeCandidate(candidates, {
					chunkId: result.chunkId,
					filePath: result.filePath,
					startLine: result.startLine,
					endLine: result.endLine,
					chunkType: result.chunkType,
					primarySymbol: result.primarySymbol,
					content: result.content,
					channel: "lexical",
					rank: result.rank,
					confidence: scoreLexicalMatch(query, queryTokens, result),
				});
			}
		}

		if (mode === "symbol" || mode === "hybrid") {
			const symbolCandidates = await this.collectSymbolCandidates(
				projectId,
				snapshotId,
				query,
				queryTokens,
				lexicalTerms,
				candidateLimit,
				options,
				getChunksForFile,
			);
			for (const candidate of symbolCandidates) mergeCandidate(candidates, candidate);
		}

		if (mode === "hybrid") {
			const pathCandidates = await this.collectPathCandidates(
				projectId,
				snapshotId,
				query,
				queryTokens,
				candidateLimit,
				options,
				getChunksForFile,
			);
			for (const candidate of pathCandidates) mergeCandidate(candidates, candidate);
		}

		let ranked = [...candidates.values()]
			.filter((candidate) => {
				if (excludeImportPreamble) {
					return candidate.chunkType !== "imports" && candidate.chunkType !== "preamble";
				}
				return true;
			})
			.filter((candidate) => !options.excludeTests || !isTestFile(candidate.filePath))
			.map((candidate) => ({
				candidate,
				score: this.finalScore(candidate, mode, applyTestPenalty),
			}))
			.filter(({ score }) => typeof minScore !== "number" || score >= minScore)
			.sort(
				(left, right) =>
					right.score - left.score ||
					left.candidate.filePath.localeCompare(right.candidate.filePath) ||
					left.candidate.startLine - right.candidate.startLine,
			);

		const refinementLimit = Math.max(topK * 4, 20);
		ranked = ranked.slice(0, refinementLimit);
		const publicCandidates: SearchResult[] = [];
		for (const { candidate, score } of ranked) {
			let primarySymbol = candidate.primarySymbol;
			const symbols = (await getSymbolsForFile(candidate.filePath))
				.filter(isFunctionLikeSymbol)
				.filter((symbol) => overlapsChunk(symbol, candidate.startLine, candidate.endLine))
				.map(toChunkOverlapSymbol);
			let fileContent: string | undefined;
			if (symbols.length > 0 && queryTokens.size > 0) {
				fileContent = await getFileContent(candidate.filePath);
				const bestSymbol = symbols
					.map((symbol) => ({
						symbol,
						score: scoreSymbolCandidate(
							symbol,
							queryTokens,
							candidate.startLine,
							fileContent,
						),
					}))
					.sort((a, b) => b.score - a.score)[0];
				if (bestSymbol && bestSymbol.score >= SYMBOL_MATCH_THRESHOLD) {
					primarySymbol = bestSymbol.symbol.name;
				}
			}
			if (primarySymbol && LANGUAGE_KEYWORDS.has(primarySymbol)) primarySymbol = undefined;

			let content: string | undefined;
			if (includeContent) {
				if (candidate.content !== undefined) content = candidate.content;
				else {
					fileContent ??= await getFileContent(candidate.filePath);
					content = sliceLines(fileContent, candidate.startLine, candidate.endLine);
				}
			}

			publicCandidates.push({
				filePath: candidate.filePath,
				startLine: candidate.startLine,
				endLine: candidate.endLine,
				score,
				chunkType: candidate.chunkType,
				primarySymbol,
				...(options.includeReasonCodes ? { reasonCode: buildReasonCode(candidate) } : {}),
				...(includeContent ? { content: content ?? "" } : {}),
			});
		}

		return dedupeSearchResults(publicCandidates, {
			dedupeFile: options.dedupeFile ?? options.cluster,
			dedupeSymbol: options.dedupeSymbol,
			cluster: options.cluster,
		}).slice(0, topK);
	}

	private async semanticCandidates(
		query: string,
		limit: number,
		filters: VectorSearchFilters,
	): Promise<VectorSearchResult[]> {
		const queryEmbedding = (await this.embedder.embed([query]))[0];
		if (!queryEmbedding) throw new Error("Failed to generate query embedding");
		return this.vectors.search(queryEmbedding, limit, filters);
	}

	private async collectSymbolCandidates(
		projectId: ProjectId,
		snapshotId: string,
		query: string,
		queryTokens: Set<string>,
		searchTerms: string[],
		limit: number,
		options: SearchOptions,
		getChunksForFile: (filePath: string) => Promise<ChunkRecord[]>,
	): Promise<
		Array<
			Omit<InternalCandidate, "key" | "channels"> & {
				channel: "symbol";
				rank: number;
				confidence: number;
			}
		>
	> {
		const terms = searchTerms.filter((term) => term.length >= 2).slice(0, 10);
		if (terms.length === 0) return [];
		const symbolLists = await Promise.all(
			terms.map((term) => this.metadata.searchSymbols(projectId, snapshotId, term)),
		);
		const symbols = new Map<string, SymbolRecord>();
		for (const list of symbolLists) {
			for (const symbol of list) symbols.set(`${symbol.filePath}:${symbol.id}`, symbol);
		}
		const rankedSymbols = [...symbols.values()]
			.filter((symbol) => !options.filePath || symbol.filePath === options.filePath)
			.filter((symbol) => matchesPrefix(symbol.filePath, options.pathPrefix))
			.map((symbol) => ({ symbol, confidence: scoreSymbolMatch(query, queryTokens, symbol) }))
			.filter(({ confidence }) => confidence > 0)
			.sort(
				(a, b) =>
					b.confidence - a.confidence ||
					a.symbol.filePath.localeCompare(b.symbol.filePath) ||
					a.symbol.range.start.line - b.symbol.range.start.line,
			)
			.slice(0, limit);

		const results = [] as Array<
			Omit<InternalCandidate, "key" | "channels"> & {
				channel: "symbol";
				rank: number;
				confidence: number;
			}
		>;
		for (let index = 0; index < rankedSymbols.length; index += 1) {
			const { symbol, confidence } = rankedSymbols[index];
			const chunks = (await getChunksForFile(symbol.filePath)).filter((chunk) =>
				matchesChunkFilters(chunk, options),
			);
			const chunk = this.bestChunkForSymbol(symbol, chunks);
			if (!chunk) continue;
			results.push({
				chunkId: chunk.chunkId,
				filePath: symbol.filePath,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				chunkType: chunk.chunkType,
				primarySymbol: symbol.name,
				channel: "symbol",
				rank: index + 1,
				confidence,
			});
		}
		return results;
	}

	private bestChunkForSymbol(symbol: SymbolRecord, chunks: ChunkRecord[]): ChunkRecord | undefined {
		const symbolCompact = compactSearchText(symbol.name);
		return chunks
			.filter((chunk) => chunk.startLine <= symbol.range.end.line && chunk.endLine >= symbol.range.start.line)
			.sort((a, b) => {
				const aPrimary = compactSearchText(a.primarySymbol ?? "") === symbolCompact ? 1 : 0;
				const bPrimary = compactSearchText(b.primarySymbol ?? "") === symbolCompact ? 1 : 0;
				if (aPrimary !== bPrimary) return bPrimary - aPrimary;
				const aSpan = a.endLine - a.startLine;
				const bSpan = b.endLine - b.startLine;
				return aSpan - bSpan || a.startLine - b.startLine;
			})[0];
	}

	private async collectPathCandidates(
		projectId: ProjectId,
		snapshotId: string,
		query: string,
		queryTokens: Set<string>,
		limit: number,
		options: SearchOptions,
		getChunksForFile: (filePath: string) => Promise<ChunkRecord[]>,
	): Promise<
		Array<
			Omit<InternalCandidate, "key" | "channels"> & {
				channel: "path";
				rank: number;
				confidence: number;
			}
		>
	> {
		const files = await this.metadata.listFiles(projectId, snapshotId, {
			pathPrefix: options.pathPrefix,
			domain: "code",
		});
		const rankedFiles = files
			.filter((file) => !options.filePath || file.path === options.filePath)
			.map((file) => ({ file, confidence: scorePathMatch(query, queryTokens, file.path) }))
			.filter(({ confidence }) => confidence > 0)
			.sort((a, b) => b.confidence - a.confidence || a.file.path.localeCompare(b.file.path))
			.slice(0, limit);

		const results = [] as Array<
			Omit<InternalCandidate, "key" | "channels"> & {
				channel: "path";
				rank: number;
				confidence: number;
			}
		>;
		for (let index = 0; index < rankedFiles.length; index += 1) {
			const { file, confidence } = rankedFiles[index];
			const chunks = (await getChunksForFile(file.path)).filter((chunk) =>
				matchesChunkFilters(chunk, options),
			);
			const chunk = this.bestChunkForPath(chunks, queryTokens);
			if (!chunk) continue;
			results.push({
				chunkId: chunk.chunkId,
				filePath: file.path,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				chunkType: chunk.chunkType,
				primarySymbol: chunk.primarySymbol,
				channel: "path",
				rank: index + 1,
				confidence,
			});
		}
		return results;
	}

	private bestChunkForPath(chunks: ChunkRecord[], queryTokens: Set<string>): ChunkRecord | undefined {
		return [...chunks].sort((a, b) => {
			const aImport = a.chunkType === "imports" || a.chunkType === "preamble" ? 1 : 0;
			const bImport = b.chunkType === "imports" || b.chunkType === "preamble" ? 1 : 0;
			if (aImport !== bImport) return aImport - bImport;
			const aSymbol = a.primarySymbol ? tokenCoverage(queryTokens, a.primarySymbol) : 0;
			const bSymbol = b.primarySymbol ? tokenCoverage(queryTokens, b.primarySymbol) : 0;
			if (aSymbol !== bSymbol) return bSymbol - aSymbol;
			return a.startLine - b.startLine;
		})[0];
	}

	private finalScore(
		candidate: InternalCandidate,
		mode: SearchMode,
		applyTestPenalty: boolean,
	): number {
		let score =
			mode === "semantic"
				? candidate.channels.semantic?.confidence ?? 0
				: mode === "lexical"
					? candidate.channels.lexical?.confidence ?? 0
					: mode === "symbol"
						? candidate.channels.symbol?.confidence ?? 0
						: hybridConfidence(candidate);

		if (candidate.chunkType === "imports") score *= IMPORT_CHUNK_SCORE_PENALTY;
		else if (candidate.chunkType === "preamble") score *= PREAMBLE_CHUNK_SCORE_PENALTY;
		if (applyTestPenalty && isTestFile(candidate.filePath)) score *= TEST_FILE_SCORE_PENALTY;
		return clamp01(score);
	}
}

function dedupeSearchResults<T extends SearchResult>(
	results: T[],
	options: { dedupeFile?: boolean; dedupeSymbol?: boolean; cluster?: boolean },
): T[] {
	if (!options.dedupeFile && !options.dedupeSymbol && !options.cluster) return results;
	const seenFiles = new Set<string>();
	const seenSymbols = new Set<string>();
	const seenClusters = new Set<string>();
	const deduped: T[] = [];
	for (const result of results) {
		if (options.dedupeFile) {
			if (seenFiles.has(result.filePath)) continue;
			seenFiles.add(result.filePath);
		}
		if (options.dedupeSymbol && result.primarySymbol) {
			const key = `${result.filePath}::${result.primarySymbol}`;
			if (seenSymbols.has(key)) continue;
			seenSymbols.add(key);
		}
		if (options.cluster) {
			const bucketStart = Math.floor(result.startLine / 50) * 50;
			const key = `${result.filePath}:${result.primarySymbol ?? result.chunkType ?? "chunk"}:${bucketStart}`;
			if (seenClusters.has(key)) continue;
			seenClusters.add(key);
		}
		deduped.push(result);
	}
	return deduped;
}
