import Parser from "tree-sitter";
import RubyLanguage from "tree-sitter-ruby";

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

type RubyAst = {
	source: string;
	tree: Parser.Tree;
};

const RUBY_REQUIRE_METHODS = new Set(["require", "require_relative"]);

export class RubyPlugin implements LanguagePlugin {
	readonly id = "ruby";
	readonly displayName = "Ruby";
	readonly fileExtensions = [".rb"];
	readonly frameworks = ["rails", "sinatra"];
	readonly capabilities = {
		supportsCustomMetadata: true,
		supportsEntryPointDiscovery: true,
	};

	private readonly parser: Parser;

	constructor() {
		this.parser = new Parser();
		const language = RubyLanguage as unknown as Parameters<
			Parser["setLanguage"]
		>[0];
		this.parser.setLanguage(language);
	}

	parse(file: SourceFile): ParsedFile {
		const tree = this.parser.parse(file.content);
		const ast: RubyAst = { source: file.content, tree };

		return {
			languageId: "ruby",
			path: file.path,
			ast,
			meta: {
				frameworkHint: this.detectFramework(file.content),
			},
		};
	}

	extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
		const ast = parsed.ast as RubyAst;
		const symbols: LanguageSymbol[] = [];

		this.walk(ast.tree.rootNode, (node) => {
			if (
				node.type !== "class" &&
				node.type !== "module" &&
				node.type !== "method" &&
				node.type !== "singleton_method"
			) {
				return;
			}

			const nameNode = node.childForFieldName("name");
			if (!nameNode) {
				return;
			}

			const name = this.nodeText(ast.source, nameNode);
			const signature = this.firstLine(this.nodeText(ast.source, node));

			if (node.type === "class" || node.type === "module") {
				symbols.push({
					id: `${parsed.path}:${node.type}:${name}:${nameNode.startPosition.row + 1}`,
					kind: node.type === "class" ? "class" : "module",
					name,
					filePath: parsed.path,
					range: this.rangeFromNode(nameNode),
					exported: true,
					signature,
				});
				return;
			}

			const containerName = this.getQualifiedContainerName(ast.source, node);
			const visibility = this.resolveMethodVisibility(ast.source, node);

			symbols.push({
				id: `${parsed.path}:${node.type}:${name}:${nameNode.startPosition.row + 1}`,
				kind: "method",
				name,
				filePath: parsed.path,
				range: this.rangeFromNode(nameNode),
				exported: visibility === "public" && !name.startsWith("_"),
				containerName,
				signature,
				metadata:
					node.type === "singleton_method"
						? {
								singleton: true,
								visibility,
							}
						: visibility === "public"
							? undefined
							: { visibility },
			});
		});

		return symbols;
	}

	extractImports(parsed: ParsedFile): LanguageImport[] {
		const ast = parsed.ast as RubyAst;
		const imports: LanguageImport[] = [];
		const lines = ast.source.split(/\r?\n/);

		this.walk(ast.tree.rootNode, (node) => {
			if (node.type !== "call") {
				return;
			}

			const methodNode = node.childForFieldName("method");
			if (!methodNode) {
				return;
			}

			const kind = this.nodeText(ast.source, methodNode);
			if (!RUBY_REQUIRE_METHODS.has(kind)) {
				return;
			}

			const statement = this.nodeText(ast.source, node).trim();
			const spec = this.extractImportSpec(statement);
			if (!spec) {
				return;
			}

			imports.push({
				id: `${parsed.path}:${kind}:${spec}:${node.startPosition.row + 1}`,
				kind: "require",
				spec,
				filePath: parsed.path,
				range: this.rangeForToken(lines, node.startPosition.row, spec, node),
				metadata: {
					syntax: kind,
				},
			});
		});

		return imports;
	}

	splitIntoChunks(parsed: ParsedFile, opts: ChunkOptions): LanguageCodeChunk[] {
		const ast = parsed.ast as RubyAst;
		const content = ast.source;

		if (!content.trim()) {
			return [];
		}

		const lines = content.split(/\r?\n/);
		const importNodes: Parser.SyntaxNode[] = [];
		const definitionNodes: Array<{
			node: Parser.SyntaxNode;
			chunkType: "types" | "impl";
			primarySymbol?: string;
		}> = [];

		this.walk(ast.tree.rootNode, (node) => {
			if (node.type === "call") {
				const methodNode = node.childForFieldName("method");
				const methodName = methodNode ? this.nodeText(content, methodNode) : "";
				if (
					RUBY_REQUIRE_METHODS.has(methodName) &&
					this.extractImportSpec(this.nodeText(content, node))
				) {
					importNodes.push(node);
				}
				return;
			}

			if (node.type === "class" || node.type === "module") {
				const nameNode = node.childForFieldName("name");
				const primarySymbol = nameNode
					? this.nodeText(content, nameNode)
					: undefined;
				definitionNodes.push({
					node,
					chunkType: "types",
					primarySymbol,
				});
				return;
			}

			if (node.type === "method" || node.type === "singleton_method") {
				const nameNode = node.childForFieldName("name");
				const primarySymbol = nameNode
					? this.nodeText(content, nameNode)
					: undefined;
				definitionNodes.push({
					node,
					chunkType: "impl",
					primarySymbol,
				});
			}
		});

		const chunks: LanguageCodeChunk[] = [];

		if (importNodes.length > 0) {
			const importStart = Math.min(
				...importNodes.map((node) => node.startPosition.row + 1),
			);
			const importEnd = Math.max(
				...importNodes.map((node) => node.endPosition.row + 1),
			);
			const importContent = lines
				.slice(importStart - 1, importEnd)
				.join("\n")
				.trim();
			if (importContent.length > 0) {
				chunks.push({
					id: `${parsed.path}:chunk:imports`,
					filePath: parsed.path,
					range: {
						startLine: importStart,
						startCol: 1,
						endLine: importEnd,
						endCol: (lines[importEnd - 1]?.length ?? 0) + 1,
					},
					content: importContent,
					languageId: "ruby",
					estimatedTokens: Math.max(1, Math.ceil(importContent.length / 4)),
					metadata: {
						chunkType: "imports",
					},
				});
			}
		}

		const sortedDefinitions = definitionNodes.sort(
			(a, b) => a.node.startPosition.row - b.node.startPosition.row,
		);
		for (const definition of sortedDefinitions) {
			const nodeContent = this.nodeText(content, definition.node).trim();
			if (!nodeContent) {
				continue;
			}

			const range = this.rangeFromNode(definition.node);
			chunks.push({
				id: `${parsed.path}:chunk:${range.startLine}`,
				filePath: parsed.path,
				range,
				content: nodeContent,
				languageId: "ruby",
				estimatedTokens: Math.max(1, Math.ceil(nodeContent.length / 4)),
				metadata: {
					chunkType: definition.chunkType,
					primarySymbol: definition.primarySymbol,
				},
			});
		}

		if (chunks.length > 0) {
			return chunks;
		}

		return [
			{
				id: `${parsed.path}:chunk:1`,
				filePath: parsed.path,
				range: {
					startLine: 1,
					startCol: 1,
					endLine: lines.length,
					endCol: (lines[lines.length - 1]?.length ?? 0) + 1,
				},
				content,
				languageId: "ruby",
				estimatedTokens: Math.max(
					opts.targetTokens,
					Math.ceil(content.length / 4),
				),
				metadata: {
					chunkStrategy: "tree-sitter-single-chunk",
					chunkType: "impl",
				},
			},
		];
	}

	getEntrypoints(filePaths: string[]): string[] {
		return filePaths.filter(
			(filePath) =>
				/\/bin\/.+\.rb$/.test(filePath) ||
				/\/(?:main|app|cli|boot)\.rb$/.test(filePath),
		);
	}

	private detectFramework(content: string): string | null {
		if (content.includes("Rails") || content.includes("ActiveRecord")) {
			return "rails";
		}
		if (content.includes("Sinatra")) {
			return "sinatra";
		}
		return null;
	}

	private extractImportSpec(statement: string): string | null {
		const match = statement.match(
			/^(?:require|require_relative)\s+(?:\(?\s*)?["']?([^"'\)]+)["']?/,
		);
		return match?.[1]?.trim() || null;
	}

	private getQualifiedContainerName(
		source: string,
		node: Parser.SyntaxNode,
	): string | undefined {
		const containers: string[] = [];
		let current: Parser.SyntaxNode | null = node.parent;

		while (current) {
			if (current.type === "class" || current.type === "module") {
				const nameNode = current.childForFieldName("name");
				if (nameNode) {
					containers.push(this.nodeText(source, nameNode));
				}
			}
			current = current.parent;
		}

		if (containers.length === 0) {
			return undefined;
		}

		return containers.reverse().join("::");
	}

	private resolveMethodVisibility(
		source: string,
		node: Parser.SyntaxNode,
	): "public" | "private" | "protected" {
		let sibling = node.previousNamedSibling;

		while (sibling) {
			if (
				sibling.type === "identifier" &&
				(this.nodeText(source, sibling) === "private" ||
					this.nodeText(source, sibling) === "protected" ||
					this.nodeText(source, sibling) === "public")
			) {
				return this.nodeText(source, sibling) as
					| "public"
					| "private"
					| "protected";
			}

			if (sibling.type === "call") {
				const methodNode = sibling.childForFieldName("method");
				if (methodNode) {
					const methodName = this.nodeText(source, methodNode);
					if (
						methodName === "private" ||
						methodName === "protected" ||
						methodName === "public"
					) {
						return methodName;
					}
				}
			}

			sibling = sibling.previousNamedSibling;
		}

		return "public";
	}

	private nodeText(source: string, node: Parser.SyntaxNode): string {
		return source.slice(node.startIndex, node.endIndex);
	}

	private firstLine(value: string): string {
		return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
	}

	private rangeFromNode(node: Parser.SyntaxNode): CodeRange {
		const startCol = node.startPosition.column + 1;
		const endCol = Math.max(startCol + 1, node.endPosition.column + 1);
		return {
			startLine: node.startPosition.row + 1,
			startCol,
			endLine: node.endPosition.row + 1,
			endCol,
		};
	}

	private rangeForToken(
		lines: string[],
		lineIndex: number,
		token: string,
		fallbackNode: Parser.SyntaxNode,
	): CodeRange {
		const line = lines[lineIndex] ?? "";
		const tokenIndex = line.indexOf(token);
		if (tokenIndex < 0) {
			return this.rangeFromNode(fallbackNode);
		}

		return {
			startLine: lineIndex + 1,
			startCol: tokenIndex + 1,
			endLine: lineIndex + 1,
			endCol: tokenIndex + Math.max(2, token.length + 1),
		};
	}

	private walk(
		node: Parser.SyntaxNode,
		visitor: (node: Parser.SyntaxNode) => void,
	): void {
		visitor(node);
		for (const child of node.namedChildren) {
			this.walk(child, visitor);
		}
	}
}

export const plugin = new RubyPlugin();
export default plugin;
