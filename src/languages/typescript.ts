import type {
	LanguagePlugin,
	SourceFile,
	ParsedFile,
	LanguageSymbol,
	LanguageImport,
	LanguageCodeChunk,
	ChunkOptions,
	CodeRange,
} from "./plugin.js";
import { Project, Node, SyntaxKind } from "ts-morph";
import * as path from "node:path";
import * as fs from "node:fs";

type ChunkSegment = {
	text: string;
	range: CodeRange;
	estimatedTokens: number;
	statementKinds?: StatementKind[];
};

type StatementKind = "import" | "type" | "impl";

export class TypeScriptPlugin implements LanguagePlugin {
	public readonly id = "typescript";
	public readonly fileExtensions = [
		".ts",
		".tsx",
		".mts",
		".cts",
		".js",
		".jsx",
	];

	private project: Project;

	constructor() {
		this.project = new Project({ useInMemoryFileSystem: true });
	}

	parse(file: SourceFile): ParsedFile {
		const sourceFile = this.project.createSourceFile(file.path, file.content, {
			overwrite: true,
		});
		return {
			languageId: this.id,
			path: file.path,
			ast: sourceFile,
			meta: file.projectRoot ? { projectRoot: file.projectRoot } : undefined,
		};
	}

	getEntrypoints(filePaths: string[], projectRoot?: string): string[] {
		const entrypointPatterns: Record<string, number> = {
			"App.tsx": 8,
			"app.tsx": 8,
			"main.ts": 7,
			"main.mts": 7,
			"main.cts": 7,
			"main.js": 6,
			"main.jsx": 6,
			"main.tsx": 6,
			"server.ts": 7,
			"server.mts": 7,
			"server.cts": 7,
			"server.js": 6,
			"server.jsx": 6,
			"app.ts": 6,
			"app.mts": 6,
			"app.cts": 6,
			"cli.ts": 6,
			"cli.mts": 6,
			"cli.cts": 6,
			"cli.js": 5,
			"index.tsx": 5,
			"index.ts": 5,
			"index.mts": 5,
			"index.cts": 5,
			"index.js": 4,
			"index.jsx": 4,
		};

		const ranked = filePaths
			.map((filePath) => {
				const fileName = path.basename(filePath);
				const fileContent = this.readEntrypointCandidate(filePath, projectRoot);
				const nameScore = entrypointPatterns[fileName] ?? 0;
				const mainScore = this.hasMainEntrypointPattern(fileContent) ? 6 : 0;
				const baseScore = Math.max(nameScore, mainScore);
				if (!baseScore) return null;

				const depth = filePath.split("/").length;
				const bonus = filePath.includes("/src/") ? 1 : 0;
				const penalty = filePath.includes("/dist/") ? 3 : 0;
				const score = baseScore * 10 - depth + bonus - penalty;

				return { path: filePath, score };
			})
			.filter((entry): entry is { path: string; score: number } =>
				Boolean(entry),
			)
			.sort((a, b) => b.score - a.score)
			.slice(0, 20)
			.map((entry) => entry.path);

		return ranked;
	}

	extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
		const sourceFile = parsed.ast as any;
		const symbols: LanguageSymbol[] = [];

		const isExportedSafe = (node: any) => {
			if (node && typeof node.isExported === "function") {
				return node.isExported();
			}
			if (node && typeof node.hasModifier === "function") {
				return node.hasModifier(SyntaxKind.ExportKeyword);
			}
			return false;
		};

		for (const f of sourceFile.getFunctions()) {
			symbols.push({
				id: `${sourceFile.getFilePath()}:func:${f.getName() || "anon"}:${f.getStart()}`,
				name: f.getName() || "anonymous",
				kind: "function",
				filePath: sourceFile.getFilePath(),
				range: this.getRange(f),
				exported: isExportedSafe(f),
				signature: this.firstLine(f.getText()),
			});
		}

		for (const iface of sourceFile.getInterfaces()) {
			symbols.push({
				id: `${sourceFile.getFilePath()}:interface:${iface.getName() || "anon"}:${iface.getStart()}`,
				name: iface.getName() || "anonymous",
				kind: "interface",
				filePath: sourceFile.getFilePath(),
				range: this.getRange(iface),
				exported: isExportedSafe(iface),
				signature: this.firstLine(iface.getText()),
			});
		}

		for (const typeAlias of sourceFile.getTypeAliases()) {
			symbols.push({
				id: `${sourceFile.getFilePath()}:type:${typeAlias.getName() || "anon"}:${typeAlias.getStart()}`,
				name: typeAlias.getName() || "anonymous",
				kind: "type",
				filePath: sourceFile.getFilePath(),
				range: this.getRange(typeAlias),
				exported: isExportedSafe(typeAlias),
				signature: this.firstLine(typeAlias.getText()),
			});
		}

		for (const c of sourceFile.getClasses()) {
			symbols.push({
				id: `${sourceFile.getFilePath()}:class:${c.getName() || "anon"}:${c.getStart()}`,
				name: c.getName() || "anonymous",
				kind: "class",
				filePath: sourceFile.getFilePath(),
				range: this.getRange(c),
				exported: isExportedSafe(c),
				signature: this.firstLine(c.getText()),
			});

			for (const m of c.getMethods()) {
				symbols.push({
					id: `${sourceFile.getFilePath()}:method:${c.getName()}:${m.getName()}:${m.getStart()}`,
					name: m.getName(),
					kind: "method",
					filePath: sourceFile.getFilePath(),
					range: this.getRange(m),
					containerName: c.getName(),
					exported: isExportedSafe(m),
					signature: this.firstLine(m.getText()),
				});
			}
		}

		return symbols;
	}

	extractImports(parsed: ParsedFile): LanguageImport[] {
		const sourceFile = parsed.ast as any;
		const imports: LanguageImport[] = [];
		const projectRoot =
			typeof parsed.meta?.projectRoot === "string"
				? parsed.meta.projectRoot
				: undefined;

		const toRelative = (p: string) => {
			const normalized = p.replace(/\\/g, "/");
			return normalized.startsWith("/") ? normalized.substring(1) : normalized;
		};

		const handleDeclaration = (decl: any, kind: "import" | "export") => {
			const spec = decl.getModuleSpecifierValue();
			if (!spec) return;

			let resolvedPath: string | undefined;

			try {
				const moduleSourceFile = decl.getModuleSpecifierSourceFile();
				if (moduleSourceFile) {
					resolvedPath = toRelative(moduleSourceFile.getFilePath());
				}
			} catch (e) {}

			if (!resolvedPath && spec.startsWith(".")) {
				try {
					const baseDir = projectRoot ?? process.cwd();
					const currentFileDir = path.dirname(
						path.resolve(baseDir, parsed.path),
					);
					const absPath = path.resolve(currentFileDir, spec);

					if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
						resolvedPath = path.relative(baseDir, absPath);
					} else {
						const extensions = [".ts", ".tsx", ".js", ".jsx", ".d.ts"];
						for (const ext of extensions) {
							const candidate = absPath + ext;
							if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
								resolvedPath = path.relative(baseDir, candidate);
								break;
							}
						}
					}

					if (!resolvedPath) {
						const extensions = [".ts", ".tsx", ".js", ".jsx", ".d.ts"];
						for (const ext of extensions) {
							const candidate = path.join(absPath, `index${ext}`);
							if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
								resolvedPath = path.relative(baseDir, candidate);
								break;
							}
						}
					}
				} catch (e) {}
			}

			if (resolvedPath) {
				resolvedPath = toRelative(resolvedPath);
			}

			imports.push({
				id: `${sourceFile.getFilePath()}:${kind}:${decl.getStart()}`,
				kind,
				spec,
				resolvedPath,
				filePath: sourceFile.getFilePath(),
				range: this.getRange(decl),
			});
		};

		for (const decl of sourceFile.getImportDeclarations()) {
			handleDeclaration(decl, "import");
		}

		for (const decl of sourceFile.getExportDeclarations()) {
			handleDeclaration(decl, "export");
		}

		return imports;
	}

	splitIntoChunks(parsed: ParsedFile, opts: ChunkOptions): LanguageCodeChunk[] {
		const sourceFile = parsed.ast as any;
		const targetTokens = Math.max(1, opts?.targetTokens ?? 300);
		const maxTokens = Math.max(targetTokens, opts?.maxTokens ?? targetTokens);
		const minTokens = Math.min(50, Math.max(1, Math.floor(targetTokens * 0.1)));
		const overlapTokens = Math.min(
			120,
			Math.max(0, Math.floor(targetTokens * 0.15)),
		);

		const segments: ChunkSegment[] = [];
		for (const node of sourceFile.getStatements()) {
			const text = node.getFullText();
			if (text.trim().length === 0) {
				continue;
			}
			const range = this.getRange(node);
			segments.push({
				text,
				range,
				estimatedTokens: this.estimateTokens(text),
				statementKinds: [this.classifyStatement(node)],
			});
		}

		const normalizedSegments = segments.flatMap((segment) =>
			this.splitOversizedSegment(segment, maxTokens, overlapTokens),
		);
		const mergedSegments = this.mergeSegments(
			normalizedSegments,
			targetTokens,
			maxTokens,
			minTokens,
		);

		return mergedSegments.map((segment, index) => ({
			id: this.buildChunkId(sourceFile.getFilePath(), segment.range),
			filePath: sourceFile.getFilePath(),
			languageId: this.id,
			content: segment.text,
			range: segment.range,
			estimatedTokens: segment.estimatedTokens,
			metadata: {
				chunkType: this.classifyChunkType(
					segment.statementKinds ?? [],
					index === 0,
				),
			},
		}));
	}

	private classifyStatement(node: Node): StatementKind {
		const kind = node.getKind();
		if (
			kind === SyntaxKind.ImportDeclaration ||
			kind === SyntaxKind.ImportEqualsDeclaration
		) {
			return "import";
		}

		if (kind === SyntaxKind.ExportDeclaration) {
			if (Node.isExportDeclaration(node) && node.getModuleSpecifier()) {
				return "import";
			}
			return "impl";
		}

		if (
			kind === SyntaxKind.InterfaceDeclaration ||
			kind === SyntaxKind.TypeAliasDeclaration ||
			kind === SyntaxKind.EnumDeclaration
		) {
			return "type";
		}

		if (kind === SyntaxKind.ModuleDeclaration) {
			return "impl";
		}

		return "impl";
	}

	private classifyChunkType(
		statementKinds: StatementKind[],
		isFirstChunk: boolean,
	): "imports" | "types" | "preamble" | "impl" {
		if (statementKinds.length === 0) return "impl";

		const hasImpl = statementKinds.some((kind) => kind === "impl");
		const hasImport = statementKinds.some((kind) => kind === "import");
		const hasType = statementKinds.some((kind) => kind === "type");

		if (hasImpl) return "impl";
		if (hasImport && !hasType) return "imports";
		if (isFirstChunk && hasImport && hasType) return "preamble";
		if (hasType) return "types";

		return "impl";
	}

	private estimateTokens(text: string): number {
		const trimmed = text.trim();
		if (!trimmed) {
			return 0;
		}
		return Math.max(1, Math.ceil(trimmed.length / 4));
	}

	private buildChunkId(filePath: string, range: CodeRange): string {
		return `${filePath}:${range.startLine}-${range.endLine}`;
	}

	private readEntrypointCandidate(
		filePath: string,
		projectRoot?: string,
	): string {
		try {
			const absolutePath = projectRoot
				? path.resolve(projectRoot, filePath)
				: path.resolve(process.cwd(), filePath);
			return fs.readFileSync(absolutePath, "utf8");
		} catch {
			return "";
		}
	}

	private hasMainEntrypointPattern(fileContent: string): boolean {
		if (!fileContent) {
			return false;
		}

		return /export\s+(?:async\s+)?function\s+main\s*\(/.test(fileContent);
	}

	private splitOversizedSegment(
		segment: ChunkSegment,
		maxTokens: number,
		overlapTokens: number,
	): ChunkSegment[] {
		if (segment.estimatedTokens <= maxTokens) {
			return [segment];
		}

		const lines = segment.text.split(/\r?\n/);
		const lineTokens = lines.map((line) => this.estimateTokens(`${line}\n`));
		const results: ChunkSegment[] = [];

		let currentStartIndex = 0;
		let currentLines: string[] = [];
		let currentTokens = 0;

		const sumTokens = (start: number, end: number) => {
			let total = 0;
			for (let i = start; i <= end; i++) {
				total += lineTokens[i] ?? 0;
			}
			return total;
		};

		const overlapStartIndexFor = (start: number, end: number) => {
			if (overlapTokens <= 0) {
				return end + 1;
			}
			let total = 0;
			for (let i = end; i >= start; i--) {
				total += lineTokens[i] ?? 0;
				if (total >= overlapTokens) {
					return i;
				}
			}
			return start;
		};

		for (let i = 0; i < lines.length; i++) {
			const nextTokens = lineTokens[i] ?? 0;
			if (currentLines.length > 0 && currentTokens + nextTokens > maxTokens) {
				const endIndex = currentStartIndex + currentLines.length - 1;
				const chunkText = currentLines.join("\n");
				results.push({
					text: chunkText,
					range: {
						startLine: segment.range.startLine + currentStartIndex,
						startCol: 0,
						endLine: segment.range.startLine + endIndex,
						endCol: 0,
					},
					estimatedTokens: currentTokens,
					statementKinds: segment.statementKinds,
				});

				const overlapStart = overlapStartIndexFor(currentStartIndex, endIndex);
				currentStartIndex = overlapStart;
				currentLines = lines.slice(currentStartIndex, i);
				currentTokens =
					currentLines.length > 0 ? sumTokens(currentStartIndex, i - 1) : 0;
			}

			currentLines.push(lines[i]);
			currentTokens += nextTokens;
		}

		if (currentLines.length > 0) {
			const endIndex = currentStartIndex + currentLines.length - 1;
			results.push({
				text: currentLines.join("\n"),
				range: {
					startLine: segment.range.startLine + currentStartIndex,
					startCol: 0,
					endLine: segment.range.startLine + endIndex,
					endCol: 0,
				},
				estimatedTokens: currentTokens,
				statementKinds: segment.statementKinds,
			});
		}

		return results.filter((entry) => entry.text.trim().length > 0);
	}

	private mergeSegments(
		segments: ChunkSegment[],
		targetTokens: number,
		maxTokens: number,
		minTokens: number,
	): ChunkSegment[] {
		const merged: ChunkSegment[] = [];
		let buffer: ChunkSegment[] = [];
		let bufferTokens = 0;

		const hasKind = (segmentList: ChunkSegment[], kind: StatementKind) =>
			segmentList.some((segment) => segment.statementKinds?.includes(kind));

		const shouldKeepLeadingPreambleSeparate = (nextSegment: ChunkSegment) => {
			if (buffer.length === 0) {
				return false;
			}

			const startsAtTopOfFile = buffer[0]?.range.startLine === 1;
			const bufferHasImpl = hasKind(buffer, "impl");
			const bufferHasPreambleContent =
				hasKind(buffer, "import") || hasKind(buffer, "type");
			const nextHasImpl = nextSegment.statementKinds?.includes("impl") ?? false;

			return (
				startsAtTopOfFile &&
				!bufferHasImpl &&
				bufferHasPreambleContent &&
				nextHasImpl
			);
		};

		const flush = () => {
			if (buffer.length === 0) {
				return;
			}
			const first = buffer[0];
			const last = buffer[buffer.length - 1];
			merged.push({
				text: buffer.map((segment) => segment.text).join(""),
				range: {
					startLine: first.range.startLine,
					startCol: first.range.startCol,
					endLine: last.range.endLine,
					endCol: last.range.endCol,
				},
				estimatedTokens: bufferTokens,
				statementKinds: buffer.flatMap(
					(segment) => segment.statementKinds ?? [],
				),
			});
			buffer = [];
			bufferTokens = 0;
		};

		for (const segment of segments) {
			if (segment.estimatedTokens === 0) {
				continue;
			}

			if (shouldKeepLeadingPreambleSeparate(segment)) {
				flush();
			}

			if (segment.estimatedTokens > maxTokens) {
				flush();
				merged.push(segment);
				continue;
			}

			if (
				bufferTokens + segment.estimatedTokens <= maxTokens ||
				bufferTokens < minTokens
			) {
				buffer.push(segment);
				bufferTokens += segment.estimatedTokens;
				if (bufferTokens >= targetTokens) {
					flush();
				}
				continue;
			}

			flush();
			buffer.push(segment);
			bufferTokens = segment.estimatedTokens;
		}

		flush();

		if (merged.length > 1) {
			const last = merged[merged.length - 1];
			if (last.estimatedTokens < minTokens) {
				const previous = merged[merged.length - 2];
				const combinedTokens = previous.estimatedTokens + last.estimatedTokens;
				if (combinedTokens <= maxTokens) {
					merged.splice(merged.length - 2, 2, {
						text: `${previous.text}${last.text}`,
						range: {
							startLine: previous.range.startLine,
							startCol: previous.range.startCol,
							endLine: last.range.endLine,
							endCol: last.range.endCol,
						},
						estimatedTokens: combinedTokens,
						statementKinds: [
							...(previous.statementKinds ?? []),
							...(last.statementKinds ?? []),
						],
					});
				}
			}
		}

		return merged;
	}

	private getRange(node: Node) {
		return {
			startLine: node.getStartLineNumber(),
			startCol: 0,
			endLine: node.getEndLineNumber(),
			endCol: 0,
		};
	}

	private firstLine(text: string): string {
		const trimmed = text.trim();
		if (!trimmed) return trimmed;
		const newlineIndex = trimmed.indexOf("\n");
		return newlineIndex === -1 ? trimmed : trimmed.slice(0, newlineIndex);
	}
}

export const plugin = new TypeScriptPlugin();
export default plugin;
