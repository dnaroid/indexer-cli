import Parser from "tree-sitter";
import RustLanguage from "tree-sitter-rust";

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

type RustAst = {
	source: string;
	tree: Parser.Tree;
};

type RustUseSpec = {
	spec: string;
	node: Parser.SyntaxNode;
};

const RUST_SYMBOL_KINDS: Record<string, string> = {
	const_item: "constant",
	enum_item: "enum",
	enum_variant: "enum_variant",
	function_item: "function",
	function_signature_item: "function",
	macro_definition: "macro",
	mod_item: "module",
	static_item: "static",
	struct_item: "struct",
	trait_item: "trait",
	type_item: "type",
};

const RUST_TYPE_NODES = new Set([
	"enum_item",
	"struct_item",
	"trait_item",
	"type_item",
]);

const RUST_CHUNK_NODES = new Set([
	"const_item",
	"enum_item",
	"function_item",
	"impl_item",
	"macro_definition",
	"mod_item",
	"static_item",
	"struct_item",
	"trait_item",
	"type_item",
]);

export class RustPlugin implements LanguagePlugin {
	readonly id = "rust";
	readonly displayName = "Rust";
	readonly fileExtensions = [".rs"];
	readonly frameworks = ["cargo"];

	private readonly parser: Parser;

	constructor() {
		this.parser = new Parser();
		const language = RustLanguage as unknown as Parameters<
			Parser["setLanguage"]
		>[0];
		this.parser.setLanguage(language);
	}

	parse(file: SourceFile): ParsedFile {
		const tree = this.parser.parse(file.content);
		const ast: RustAst = { source: file.content, tree };

		return {
			languageId: "rust",
			path: file.path,
			ast,
			meta: { frameworkHint: "cargo" },
		};
	}

	extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
		const ast = parsed.ast as RustAst;
		const symbols: LanguageSymbol[] = [];
		const lines = ast.source.split(/\r?\n/);

		this.walk(ast.tree.rootNode, (node) => {
			const kind = RUST_SYMBOL_KINDS[node.type];
			if (!kind) return;

			const nameNode = node.childForFieldName("name");
			if (!nameNode) return;

			const name = this.nodeText(ast.source, nameNode);
			symbols.push({
				id: `${parsed.path}:${kind}:${name}:${nameNode.startPosition.row + 1}`,
				kind,
				name,
				filePath: parsed.path,
				range: this.rangeFromNode(nameNode),
				exported: this.isExported(ast.source, node),
				containerName: this.getContainerName(ast.source, node),
				signature: this.firstLine(this.nodeText(ast.source, node)),
				docComment: this.extractDocComment(lines, node.startPosition.row),
				metadata: { framework: "cargo" },
			});
		});

		return symbols;
	}

	extractImports(parsed: ParsedFile): LanguageImport[] {
		const ast = parsed.ast as RustAst;
		const imports: LanguageImport[] = [];

		this.walk(ast.tree.rootNode, (node) => {
			if (node.type === "use_declaration") {
				for (const useSpec of this.collectUseSpecs(ast.source, node)) {
					imports.push({
						id: `${parsed.path}:use:${useSpec.spec}:${node.startPosition.row + 1}`,
						kind: "import",
						spec: useSpec.spec,
						filePath: parsed.path,
						range: this.rangeFromNode(useSpec.node),
						metadata: { syntax: "use" },
					});
				}
				return;
			}

			if (node.type === "extern_crate_declaration") {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				const spec = this.nodeText(ast.source, nameNode);
				imports.push({
					id: `${parsed.path}:extern:${spec}:${node.startPosition.row + 1}`,
					kind: "import",
					spec,
					filePath: parsed.path,
					range: this.rangeFromNode(nameNode),
					metadata: { syntax: "extern crate" },
				});
				return;
			}

			if (
				node.type === "mod_item" &&
				this.isModuleDeclaration(ast.source, node)
			) {
				const nameNode = node.childForFieldName("name");
				if (!nameNode) return;
				const spec = this.nodeText(ast.source, nameNode);
				imports.push({
					id: `${parsed.path}:mod:${spec}:${node.startPosition.row + 1}`,
					kind: "include",
					spec,
					filePath: parsed.path,
					range: this.rangeFromNode(nameNode),
					metadata: { syntax: "mod" },
				});
			}
		});

		return imports;
	}

	splitIntoChunks(parsed: ParsedFile, opts: ChunkOptions): LanguageCodeChunk[] {
		const ast = parsed.ast as RustAst;
		const content = ast.source;
		if (!content.trim()) return [];

		const lines = content.split(/\r?\n/);
		const importNodes: Parser.SyntaxNode[] = [];
		const declarationNodes: Parser.SyntaxNode[] = [];

		for (const node of ast.tree.rootNode.namedChildren) {
			if (
				node.type === "use_declaration" ||
				node.type === "extern_crate_declaration" ||
				(node.type === "mod_item" && this.isModuleDeclaration(content, node))
			) {
				importNodes.push(node);
				continue;
			}

			if (RUST_CHUNK_NODES.has(node.type)) {
				declarationNodes.push(node);
			}
		}

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
					languageId: "rust",
					estimatedTokens: Math.max(1, Math.ceil(importContent.length / 4)),
					metadata: { chunkType: "imports" },
				});
			}
		}

		for (const node of declarationNodes.sort(
			(a, b) => a.startPosition.row - b.startPosition.row,
		)) {
			const startLine = this.extendStartForAttributesAndDocs(
				lines,
				node.startPosition.row,
			);
			const range = this.rangeFromNode(node);
			const chunkContent = lines
				.slice(startLine - 1, range.endLine)
				.join("\n")
				.trim();
			if (!chunkContent) continue;

			chunks.push({
				id: `${parsed.path}:chunk:${startLine}`,
				filePath: parsed.path,
				range: { ...range, startLine, startCol: 1 },
				content: chunkContent,
				languageId: "rust",
				estimatedTokens: Math.max(1, Math.ceil(chunkContent.length / 4)),
				metadata: {
					chunkType: this.chunkTypeForNode(node),
					primarySymbol: this.primarySymbolForNode(ast.source, node),
				},
			});
		}

		if (chunks.length > 0) return chunks;

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
				languageId: "rust",
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
				filePath === "src/main.rs" ||
				filePath === "src/lib.rs" ||
				/^src\/bin\/[^/]+\.rs$/.test(filePath) ||
				/^examples\/[^/]+\.rs$/.test(filePath),
		);
	}

	private collectUseSpecs(
		source: string,
		node: Parser.SyntaxNode,
	): RustUseSpec[] {
		return this.collectUseSpecsFromNode(source, node, []);
	}

	private collectUseSpecsFromNode(
		source: string,
		node: Parser.SyntaxNode,
		prefix: string[],
	): RustUseSpec[] {
		switch (node.type) {
			case "use_declaration":
			case "use_list":
				return node.namedChildren.flatMap((child) =>
					this.collectUseSpecsFromNode(source, child, prefix),
				);
			case "scoped_use_list": {
				const useList = node.namedChildren.find(
					(child) => child.type === "use_list",
				);
				if (!useList) return [];
				const useListIndex = node.namedChildren.indexOf(useList);
				const localPrefix = node.namedChildren
					.slice(0, useListIndex)
					.flatMap((child) => this.splitRustPath(this.nodeText(source, child)));
				return this.collectUseSpecsFromNode(source, useList, [
					...prefix,
					...localPrefix,
				]);
			}
			case "use_as_clause": {
				const target = node.namedChildren[0];
				return target
					? this.collectUseSpecsFromNode(source, target, prefix)
					: [];
			}
			case "use_wildcard": {
				const target = node.namedChildren[0];
				const spec = target
					? this.combineRustPath(prefix, this.nodeText(source, target))
					: this.combineRustPath(
							prefix,
							this.nodeText(source, node).replace(/::\*$/, ""),
						);
				return spec ? [{ spec, node: target ?? node }] : [];
			}
			case "scoped_identifier":
			case "scoped_type_identifier": {
				const spec = this.combineRustPath(prefix, this.nodeText(source, node));
				return spec ? [{ spec, node }] : [];
			}
			case "crate":
			case "identifier":
			case "self":
			case "super": {
				const spec = this.combineRustPath(prefix, this.nodeText(source, node));
				return spec ? [{ spec, node }] : [];
			}
			default:
				return [];
		}
	}

	private combineRustPath(prefix: string[], value: string): string {
		const parts = [...prefix, ...this.splitRustPath(value)];
		if (parts[parts.length - 1] === "self" && parts.length > 1) parts.pop();
		return parts.join("::");
	}

	private splitRustPath(value: string): string[] {
		return value
			.replace(/::\*$/, "")
			.split("::")
			.map((part) => part.trim())
			.filter(Boolean);
	}

	private isModuleDeclaration(
		source: string,
		node: Parser.SyntaxNode,
	): boolean {
		return this.nodeText(source, node).trimEnd().endsWith(";");
	}

	private isExported(source: string, node: Parser.SyntaxNode): boolean {
		const visibility = node.namedChildren.find(
			(child) => child.type === "visibility_modifier",
		);
		if (visibility) return this.nodeText(source, visibility).startsWith("pub");

		const parent = this.findAncestor(node, "enum_item");
		return node.type === "enum_variant" && parent
			? this.isExported(source, parent)
			: false;
	}

	private getContainerName(
		source: string,
		node: Parser.SyntaxNode,
	): string | undefined {
		const impl = this.findAncestor(node, "impl_item");
		if (impl) {
			const target = this.findImplTarget(impl);
			return target ? this.nodeText(source, target) : "impl";
		}

		const trait = this.findAncestor(node, "trait_item");
		const traitName = trait?.childForFieldName("name");
		if (traitName) return this.nodeText(source, traitName);

		const enumNode = this.findAncestor(node, "enum_item");
		const enumName = enumNode?.childForFieldName("name");
		return enumName ? this.nodeText(source, enumName) : undefined;
	}

	private primarySymbolForNode(
		source: string,
		node: Parser.SyntaxNode,
	): string | undefined {
		if (node.type === "impl_item") {
			const target = this.findImplTarget(node);
			return target ? `impl ${this.nodeText(source, target)}` : "impl";
		}

		const nameNode = node.childForFieldName("name");
		return nameNode ? this.nodeText(source, nameNode) : undefined;
	}

	private findImplTarget(
		node: Parser.SyntaxNode,
	): Parser.SyntaxNode | undefined {
		return node.namedChildren.find(
			(child) =>
				child.type === "type_identifier" ||
				child.type === "scoped_type_identifier" ||
				child.type === "generic_type",
		);
	}

	private chunkTypeForNode(
		node: Parser.SyntaxNode,
	): "types" | "impl" | "module_section" {
		if (RUST_TYPE_NODES.has(node.type)) return "types";
		if (node.type === "mod_item") return "module_section";
		return "impl";
	}

	private extractDocComment(
		lines: string[],
		startRow: number,
	): string | undefined {
		const comments: string[] = [];
		for (let index = startRow - 1; index >= 0; index -= 1) {
			const line = lines[index]?.trim();
			if (!line) break;
			if (line.startsWith("#")) continue;
			if (line.startsWith("///") || line.startsWith("//!")) {
				comments.unshift(line.replace(/^\/\/[/!]?\s?/, ""));
				continue;
			}
			break;
		}

		return comments.length > 0 ? comments.join("\n") : undefined;
	}

	private extendStartForAttributesAndDocs(
		lines: string[],
		startRow: number,
	): number {
		let start = startRow;
		for (let index = startRow - 1; index >= 0; index -= 1) {
			const line = lines[index]?.trim();
			if (!line) break;
			if (
				line.startsWith("#") ||
				line.startsWith("///") ||
				line.startsWith("//!")
			) {
				start = index + 1;
				continue;
			}
			break;
		}
		return start;
	}

	private findAncestor(
		node: Parser.SyntaxNode,
		type: string,
	): Parser.SyntaxNode | null {
		let current: Parser.SyntaxNode | null = node.parent;
		while (current) {
			if (current.type === type) return current;
			current = current.parent;
		}
		return null;
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

	private walk(
		node: Parser.SyntaxNode,
		visitor: (node: Parser.SyntaxNode) => void,
	): void {
		visitor(node);
		for (let index = 0; index < node.namedChildCount; index += 1) {
			const child = node.namedChild(index);
			if (child) this.walk(child, visitor);
		}
	}
}

export const plugin = new RustPlugin();
