import type {
	ChunkOptions,
	CodeRange,
	LanguageCodeChunk,
	LanguageImport,
	LanguagePlugin,
	LanguageSymbol,
	ParsedFile,
	SourceFile,
} from "./plugin.js";

type CppAst = {
	source: string;
	lines: string[];
};

type CppDeclaration = {
	kind: string;
	name: string;
	startLine: number;
	endLine: number;
	signature: string;
	exported: boolean;
};

const CPP_KEYWORDS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"sizeof",
	"alignof",
	"decltype",
	"static_cast",
	"reinterpret_cast",
	"const_cast",
	"dynamic_cast",
]);

const FUNCTION_PATTERN =
	/^\s*(?:(?:template\s*<[^>]+>\s*)?(?:(?:inline|static|constexpr|consteval|extern|virtual|friend|explicit)\s+)*)?(?:[~\w:\<\>\*&\s,]+?\s+)?([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?|~[A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:->\s*[^\{;]+\s*)?(?:\{|;)/;

export class CppPlugin implements LanguagePlugin {
	readonly id = "cpp";
	readonly displayName = "C/C++";
	readonly fileExtensions = [
		".c",
		".cc",
		".cpp",
		".cxx",
		".h",
		".hh",
		".hpp",
		".hxx",
	];
	readonly frameworks = ["platformio", "arduino", "cmake"];

	parse(file: SourceFile): ParsedFile {
		const ast: CppAst = {
			source: file.content,
			lines: file.content.split(/\r?\n/),
		};

		return {
			languageId: "cpp",
			path: file.path,
			ast,
			meta: { frameworkHint: this.detectFramework(file) },
		};
	}

	extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
		const ast = parsed.ast as CppAst;
		return this.collectDeclarations(ast.lines).map((declaration) => ({
			id: `${parsed.path}:${declaration.kind}:${declaration.name}:${declaration.startLine}`,
			kind: declaration.kind,
			name: declaration.name,
			filePath: parsed.path,
			range: this.rangeForLines(ast.lines, declaration.startLine, declaration.endLine),
			exported: declaration.exported,
			signature: declaration.signature,
			docComment: this.extractDocComment(ast.lines, declaration.startLine),
			metadata: { parser: "regex" },
		}));
	}

	extractImports(parsed: ParsedFile): LanguageImport[] {
		const ast = parsed.ast as CppAst;
		const imports: LanguageImport[] = [];

		ast.lines.forEach((line, index) => {
			const match = line.match(/^\s*#\s*include\s*([<"])([^>"]+)[>"]/);
			if (!match) return;

			const spec = match[2].trim();
			imports.push({
				id: `${parsed.path}:include:${spec}:${index + 1}`,
				kind: "include",
				spec,
				filePath: parsed.path,
				range: this.rangeForLines(ast.lines, index + 1, index + 1),
				metadata: { system: match[1] === "<" },
			});
		});

		return imports;
	}

	splitIntoChunks(parsed: ParsedFile, opts: ChunkOptions): LanguageCodeChunk[] {
		const ast = parsed.ast as CppAst;
		if (!ast.source.trim()) return [];

		const chunks: LanguageCodeChunk[] = [];
		const includeLines = ast.lines
			.map((line, index) => ({ line, lineNumber: index + 1 }))
			.filter(({ line }) => /^\s*#\s*(include|define|pragma)\b/.test(line));

		if (includeLines.length > 0) {
			const startLine = includeLines[0].lineNumber;
			const endLine = includeLines[includeLines.length - 1].lineNumber;
			const content = ast.lines.slice(startLine - 1, endLine).join("\n").trim();
			if (content) {
				chunks.push(this.createChunk(parsed.path, ast.lines, {
					id: "includes",
					content,
					startLine,
					endLine,
					chunkType: "imports",
				}));
			}
		}

		const declarations = this.collectDeclarations(ast.lines);
		for (const declaration of declarations) {
			const content = ast.lines
				.slice(declaration.startLine - 1, declaration.endLine)
				.join("\n")
				.trim();
			if (!content) continue;

			chunks.push(this.createChunk(parsed.path, ast.lines, {
				id: `${declaration.kind}:${declaration.name}:${declaration.startLine}`,
				content,
				startLine: declaration.startLine,
				endLine: declaration.endLine,
				chunkType: declaration.kind === "function" ? "impl" : "types",
				primarySymbol: declaration.name,
			}));
		}

		if (chunks.length === 0) {
			return [this.createChunk(parsed.path, ast.lines, {
				id: "full_file",
				content: ast.source.trim(),
				startLine: 1,
				endLine: ast.lines.length,
				chunkType: "full_file",
			})];
		}

		return this.mergeSmallChunks(chunks, opts.maxTokens ?? opts.targetTokens * 2);
	}

	getEntrypoints(filePaths: string[]): string[] {
		const preferred = [
			"src/main.cpp",
			"src/main.c",
			"main.cpp",
			"main.c",
			"app/main.cpp",
		];
		const files = new Set(filePaths);
		return preferred.filter((file) => files.has(file));
	}

	private collectDeclarations(lines: string[]): CppDeclaration[] {
		const declarations: CppDeclaration[] = [];
		let braceDepth = 0;

		lines.forEach((line, index) => {
			const lineNumber = index + 1;
			const depthBeforeLine = braceDepth;
			const typeMatch = line.match(/^\s*(?:typedef\s+)?(?:class|struct|enum)\s+(?:class\s+)?([A-Za-z_]\w*)\b/);
			if (depthBeforeLine === 0 && typeMatch) {
				declarations.push({
					kind: line.includes("enum") ? "enum" : line.includes("struct") ? "struct" : "class",
					name: typeMatch[1],
					startLine: lineNumber,
					endLine: this.findDeclarationEnd(lines, index),
					signature: line.trim(),
					exported: true,
				});
				braceDepth = this.updateBraceDepth(braceDepth, line);
				return;
			}

			const functionMatch = line.match(FUNCTION_PATTERN);
			if (!functionMatch || depthBeforeLine > 0) {
				braceDepth = this.updateBraceDepth(braceDepth, line);
				return;
			}
			const name = functionMatch[1].split("::").pop() ?? functionMatch[1];
			if (CPP_KEYWORDS.has(name)) {
				braceDepth = this.updateBraceDepth(braceDepth, line);
				return;
			}

			declarations.push({
				kind: "function",
				name,
				startLine: lineNumber,
				endLine: line.includes("{")
					? this.findBalancedBlockEnd(lines, index)
					: lineNumber,
				signature: line.trim(),
				exported: !line.trimStart().startsWith("static "),
			});
			braceDepth = this.updateBraceDepth(braceDepth, line);
		});

		return declarations;
	}

	private updateBraceDepth(depth: number, line: string): number {
		let next = depth;
		for (const char of line) {
			if (char === "{") next += 1;
			if (char === "}") next = Math.max(0, next - 1);
		}
		return next;
	}

	private findDeclarationEnd(lines: string[], startIndex: number): number {
		if (!lines[startIndex].includes("{")) {
			return startIndex + 1;
		}
		return this.findBalancedBlockEnd(lines, startIndex);
	}

	private findBalancedBlockEnd(lines: string[], startIndex: number): number {
		let depth = 0;
		for (let index = startIndex; index < lines.length; index += 1) {
			for (const char of lines[index]) {
				if (char === "{") depth += 1;
				if (char === "}") depth -= 1;
			}
			if (depth <= 0 && index > startIndex) {
				return index + 1;
			}
		}
		return startIndex + 1;
	}

	private createChunk(
		filePath: string,
		lines: string[],
		options: {
			id: string;
			content: string;
			startLine: number;
			endLine: number;
			chunkType: string;
			primarySymbol?: string;
		},
	): LanguageCodeChunk {
		return {
			id: `${filePath}:chunk:${options.id}`,
			filePath,
			range: this.rangeForLines(lines, options.startLine, options.endLine),
			content: options.content,
			languageId: "cpp",
			estimatedTokens: Math.max(1, Math.ceil(options.content.length / 4)),
			metadata: {
				chunkType: options.chunkType,
				primarySymbol: options.primarySymbol,
			},
		};
	}

	private mergeSmallChunks(
		chunks: LanguageCodeChunk[],
		maxTokens: number,
	): LanguageCodeChunk[] {
		return chunks.filter((chunk) => (chunk.estimatedTokens ?? 0) <= maxTokens || chunk.metadata?.chunkType !== "imports");
	}

	private rangeForLines(
		lines: string[],
		startLine: number,
		endLine: number,
	): CodeRange {
		return {
			startLine,
			startCol: 1,
			endLine,
			endCol: (lines[endLine - 1]?.length ?? 0) + 1,
		};
	}

	private extractDocComment(lines: string[], startLine: number): string | undefined {
		const comments: string[] = [];
		for (let index = startLine - 2; index >= 0; index -= 1) {
			const trimmed = lines[index].trim();
			if (trimmed.startsWith("//") || trimmed.startsWith("///")) {
				comments.unshift(trimmed.replace(/^\/\/\/?\s?/, ""));
				continue;
			}
			if (trimmed === "") continue;
			break;
		}
		return comments.length > 0 ? comments.join("\n") : undefined;
	}

	private detectFramework(file: SourceFile): string | null {
		if (file.projectRoot && /(?:^|\/)src\/main\.(?:c|cc|cpp|cxx)$/i.test(file.path)) {
			return "platformio";
		}
		if (file.content.includes("Arduino.h") || file.content.includes("setup()")) {
			return "arduino";
		}
		return null;
	}
}
