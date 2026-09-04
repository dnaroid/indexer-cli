import path from "node:path";
import { parse } from "svelte/compiler";
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

type AstNode = Record<string, unknown> & {
	type: string;
	start?: number;
	end?: number;
};

type TraversableNode = {
	type: string;
	startIndex: number;
	endIndex: number;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	namedChildren: TraversableNode[];
	childForFieldName(name: string): TraversableNode | null;
};

type SvelteAst = {
	source: string;
	root: AstNode;
	tree: { rootNode: TraversableNode };
	lineStarts: number[];
};

type ChunkSegment = {
	start: number;
	end: number;
	chunkType: "imports" | "types" | "impl" | "module_section";
	primarySymbol?: string;
};

const SKIPPED_AST_FIELDS = new Set([
	"type",
	"start",
	"end",
	"loc",
	"metadata",
	"parent",
]);

function isAstNode(value: unknown): value is AstNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

export class SveltePlugin implements LanguagePlugin {
	readonly id = "svelte";
	readonly displayName = "Svelte";
	readonly fileExtensions = [".svelte"];
	readonly frameworks = ["svelte", "sveltekit"];

	parse(file: SourceFile): ParsedFile {
		const root = parse(file.content, {
			filename: file.path,
			modern: true,
		}) as unknown as AstNode;
		const lineStarts = this.buildLineStarts(file.content);
		const rootNode = this.toTraversableNode(
			root,
			file.content,
			lineStarts,
			0,
			file.content.length,
		);

		return {
			languageId: this.id,
			path: file.path,
			ast: {
				source: file.content,
				root,
				tree: { rootNode },
				lineStarts,
			} satisfies SvelteAst,
			meta: file.projectRoot ? { projectRoot: file.projectRoot } : undefined,
		};
	}

	getEntrypoints(filePaths: string[]): string[] {
		return filePaths
			.map((filePath, index) => ({
				filePath,
				index,
				score: this.entrypointScore(filePath),
			}))
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score || left.index - right.index)
			.slice(0, 20)
			.map((entry) => entry.filePath);
	}

	extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
		const ast = parsed.ast as SvelteAst;
		const symbols: LanguageSymbol[] = [];
		const componentName = path.basename(parsed.path, path.extname(parsed.path));

		symbols.push({
			id: `${parsed.path}:component:${componentName}:0`,
			kind: "component",
			name: componentName,
			filePath: parsed.path,
			range: this.rangeFromOffsets(ast, 0, ast.source.length),
			exported: true,
			signature: `<${componentName}>`,
			metadata: { framework: "svelte" },
		});

		for (const script of this.scriptNodes(ast.root)) {
			const context = script.context === "module" ? "module" : "default";
			const program = isAstNode(script.content) ? script.content : undefined;
			const body = Array.isArray(program?.body) ? program.body : [];
			for (const statement of body) {
				if (isAstNode(statement)) {
					this.collectScriptSymbols(ast, parsed.path, statement, context, false, symbols);
				}
			}
		}

		const fragment = isAstNode(ast.root.fragment) ? ast.root.fragment : undefined;
		if (fragment) {
			this.walkAst(fragment, (node) => {
				if (node.type !== "SnippetBlock" || !isAstNode(node.expression)) return;
				const name = this.identifierName(node.expression);
				if (!name) return;
				symbols.push(
					this.createSymbol(ast, parsed.path, node, "function", name, false, {
						frameworkConstruct: "snippet",
					}),
				);
			});
		}

		return this.dedupeSymbols(symbols);
	}

	extractImports(parsed: ParsedFile): LanguageImport[] {
		const ast = parsed.ast as SvelteAst;
		const imports: LanguageImport[] = [];

		this.walkAst(ast.root, (node) => {
				let kind: LanguageImport["kind"] | undefined;
				let sourceNode: AstNode | undefined;

				if (node.type === "ImportDeclaration") {
					kind = "import";
					sourceNode = isAstNode(node.source) ? node.source : undefined;
				} else if (
					node.type === "ExportNamedDeclaration" ||
					node.type === "ExportAllDeclaration"
				) {
					kind = "export";
					sourceNode = isAstNode(node.source) ? node.source : undefined;
				} else if (node.type === "ImportExpression") {
					kind = "dynamic_import";
					sourceNode = isAstNode(node.source) ? node.source : undefined;
				}

				const spec = this.literalValue(sourceNode);
				if (!kind || !spec) return;
				const start = this.nodeStart(node, this.nodeStart(sourceNode, 0));
				imports.push({
					id: `${parsed.path}:${kind}:${spec}:${start}`,
					kind,
					spec,
					filePath: parsed.path,
					range: this.rangeFromNode(ast, node),
				});
		});

		return imports.filter(
			(entry, index) =>
				imports.findIndex(
					(candidate) =>
						candidate.kind === entry.kind &&
						candidate.spec === entry.spec &&
						candidate.range.startLine === entry.range.startLine &&
						candidate.range.startCol === entry.range.startCol,
				) === index,
		);
	}

	splitIntoChunks(parsed: ParsedFile, opts: ChunkOptions): LanguageCodeChunk[] {
		const ast = parsed.ast as SvelteAst;
		const targetTokens = Math.max(1, opts.targetTokens || 300);
		const maxTokens = Math.max(targetTokens, opts.maxTokens ?? targetTokens);
		const componentName = path.basename(parsed.path, path.extname(parsed.path));
		const segments: ChunkSegment[] = [];

		for (const script of this.scriptNodes(ast.root)) {
			const start = this.nodeStart(script, 0);
			const end = this.nodeEnd(script, start);
			if (end <= start) continue;
			segments.push({
				start,
				end,
				chunkType: this.classifyScriptChunk(script),
				primarySymbol: this.primaryScriptSymbol(script),
			});
		}

		const fragment = isAstNode(ast.root.fragment) ? ast.root.fragment : undefined;
		const fragmentNodes = Array.isArray(fragment?.nodes) ? fragment.nodes : [];
		for (const node of fragmentNodes) {
			if (!isAstNode(node)) continue;
			const start = this.nodeStart(node, 0);
			const end = this.nodeEnd(node, start);
			if (end <= start || !ast.source.slice(start, end).trim()) continue;
			segments.push({
				start,
				end,
				chunkType: "module_section",
				primarySymbol:
					node.type === "SnippetBlock" && isAstNode(node.expression)
						? this.identifierName(node.expression)
						: componentName,
			});
		}

		if (isAstNode(ast.root.css)) {
			const start = this.nodeStart(ast.root.css, 0);
			const end = this.nodeEnd(ast.root.css, start);
			if (end > start) {
				segments.push({ start, end, chunkType: "module_section" });
			}
		}

		if (segments.length === 0 && ast.source.trim()) {
			segments.push({
				start: 0,
				end: ast.source.length,
				chunkType: "module_section",
				primarySymbol: componentName,
			});
		}

		const bounded = segments
			.sort((left, right) => left.start - right.start)
			.flatMap((segment) => this.splitOversizedSegment(ast, segment, maxTokens));
		const merged = this.mergeSegments(ast, bounded, targetTokens, maxTokens);

		return merged.map((segment, index) => {
			const range = this.rangeFromOffsets(ast, segment.start, segment.end);
			const content = ast.source.slice(segment.start, segment.end).trim();
			return {
				id: `${parsed.path}:${range.startLine}-${range.endLine}:${index}`,
				filePath: parsed.path,
				languageId: this.id,
				content,
				range,
				estimatedTokens: this.estimateTokens(content),
				metadata: {
					chunkType: segment.chunkType,
					...(segment.primarySymbol
						? { primarySymbol: segment.primarySymbol }
						: {}),
				},
			};
		});
	}

	private collectScriptSymbols(
		ast: SvelteAst,
		filePath: string,
		node: AstNode,
		context: "default" | "module",
		exported: boolean,
		symbols: LanguageSymbol[],
	): void {
		if (node.type === "ExportNamedDeclaration") {
			if (isAstNode(node.declaration)) {
				this.collectScriptSymbols(ast, filePath, node.declaration, context, true, symbols);
			}
			return;
		}

		const namedKinds: Record<string, string> = {
			FunctionDeclaration: "function",
			TSDeclareFunction: "function",
			ClassDeclaration: "class",
			TSInterfaceDeclaration: "interface",
			TSTypeAliasDeclaration: "type",
			TSEnumDeclaration: "type",
		};
		const kind = namedKinds[node.type];
		if (kind && isAstNode(node.id)) {
			const name = this.identifierName(node.id);
			if (name) {
				symbols.push(this.createSymbol(ast, filePath, node, kind, name, exported));
			}
		}

		if (node.type === "ClassDeclaration") {
			const className = isAstNode(node.id) ? this.identifierName(node.id) : undefined;
			const body = isAstNode(node.body) && Array.isArray(node.body.body) ? node.body.body : [];
			for (const member of body) {
				if (!isAstNode(member) || member.type !== "MethodDefinition") continue;
				const name = isAstNode(member.key) ? this.identifierName(member.key) : undefined;
				if (!name) continue;
				symbols.push({
					...this.createSymbol(ast, filePath, member, "method", name, false),
					containerName: className,
				});
			}
		}

		if (node.type !== "VariableDeclaration" || !Array.isArray(node.declarations)) return;
		for (const declaration of node.declarations) {
			if (!isAstNode(declaration) || !isAstNode(declaration.id)) continue;
			const names = this.bindingNames(declaration.id);
			const isFunction =
				isAstNode(declaration.init) &&
				["ArrowFunctionExpression", "FunctionExpression"].includes(
					declaration.init.type,
				);
			const isProps =
				context === "default" &&
				isAstNode(declaration.init) &&
				this.isPropsCall(declaration.init);

			for (const name of names) {
				if (isFunction) {
					symbols.push(
						this.createSymbol(ast, filePath, declaration, "function", name, exported),
					);
				} else if (isProps || (context === "default" && exported)) {
					symbols.push(
						this.createSymbol(ast, filePath, declaration, "prop", name, true, {
							frameworkConstruct: "prop",
						}),
					);
				} else if (context === "module" && exported) {
					symbols.push(
						this.createSymbol(ast, filePath, declaration, "variable", name, true),
					);
				}
			}
		}
	}

	private createSymbol(
		ast: SvelteAst,
		filePath: string,
		node: AstNode,
		kind: string,
		name: string,
		exported: boolean,
		metadata?: Record<string, unknown>,
	): LanguageSymbol {
		const start = this.nodeStart(node, 0);
		const end = this.nodeEnd(node, start);
		return {
			id: `${filePath}:${kind}:${name}:${start}`,
			kind,
			name,
			filePath,
			range: this.rangeFromOffsets(ast, start, end),
			exported,
			signature: this.firstLine(ast.source.slice(start, end)),
			metadata,
		};
	}

	private scriptNodes(root: AstNode): AstNode[] {
		return [root.module, root.instance].filter(isAstNode);
	}

	private classifyScriptChunk(script: AstNode): "imports" | "types" | "impl" {
		const program = isAstNode(script.content) ? script.content : undefined;
		const body = Array.isArray(program?.body) ? program.body.filter(isAstNode) : [];
		if (body.length === 0) return "impl";
		const types = body.map((node) => {
			const value =
				node.type === "ExportNamedDeclaration" && isAstNode(node.declaration)
					? node.declaration.type
					: node.type;
			if (["ImportDeclaration", "ExportAllDeclaration"].includes(value)) return "import";
			if (["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration"].includes(value)) return "type";
			return "impl";
		});
		if (types.every((type) => type === "import")) return "imports";
		if (types.every((type) => type === "type")) return "types";
		return "impl";
	}

	private primaryScriptSymbol(script: AstNode): string | undefined {
		const program = isAstNode(script.content) ? script.content : undefined;
		const body = Array.isArray(program?.body) ? program.body.filter(isAstNode) : [];
		for (const rawNode of body) {
			const node =
				rawNode.type === "ExportNamedDeclaration" && isAstNode(rawNode.declaration)
					? rawNode.declaration
					: rawNode;
			if (isAstNode(node.id)) {
				const name = this.identifierName(node.id);
				if (name) return name;
			}
			if (node.type === "VariableDeclaration" && Array.isArray(node.declarations)) {
				const declaration = node.declarations.find(isAstNode);
				if (declaration && isAstNode(declaration.id)) {
					return this.bindingNames(declaration.id)[0];
				}
			}
		}
		return undefined;
	}

	private bindingNames(node: AstNode): string[] {
		if (node.type === "Identifier") {
			const name = this.identifierName(node);
			return name ? [name] : [];
		}
		if (node.type === "AssignmentPattern" && isAstNode(node.left)) {
			return this.bindingNames(node.left);
		}
		if (node.type === "RestElement" && isAstNode(node.argument)) {
			return this.bindingNames(node.argument);
		}
		const values: unknown[] = [];
		if (Array.isArray(node.properties)) values.push(...node.properties);
		if (Array.isArray(node.elements)) values.push(...node.elements);
		const names: string[] = [];
		for (const value of values) {
			if (!isAstNode(value)) continue;
			const target =
				value.type === "Property" && isAstNode(value.value) ? value.value : value;
			names.push(...this.bindingNames(target));
		}
		return names;
	}

	private isPropsCall(node: AstNode): boolean {
		return (
			node.type === "CallExpression" &&
			isAstNode(node.callee) &&
			this.identifierName(node.callee) === "$props"
		);
	}

	private identifierName(node: AstNode): string | undefined {
		return typeof node.name === "string" ? node.name : undefined;
	}

	private literalValue(node: AstNode | undefined): string | undefined {
		return node && typeof node.value === "string" ? node.value : undefined;
	}

	private walkAst(node: AstNode, visit: (node: AstNode) => void): void {
		visit(node);
		for (const [key, value] of Object.entries(node)) {
			if (SKIPPED_AST_FIELDS.has(key)) continue;
			if (isAstNode(value)) {
				this.walkAst(value, visit);
			} else if (Array.isArray(value)) {
				for (const child of value) {
					if (isAstNode(child)) this.walkAst(child, visit);
				}
			}
		}
	}

	private toTraversableNode(
		node: AstNode,
		source: string,
		lineStarts: number[],
		fallbackStart: number,
		fallbackEnd: number,
	): TraversableNode {
		const childEntries: Array<{ field: string; node: AstNode }> = [];
		for (const [field, value] of Object.entries(node)) {
			if (SKIPPED_AST_FIELDS.has(field)) continue;
			if (isAstNode(value)) childEntries.push({ field, node: value });
			else if (Array.isArray(value)) {
				for (const child of value) {
					if (isAstNode(child)) childEntries.push({ field, node: child });
				}
			}
		}
		const directStart = this.nodeStart(node, fallbackStart);
		const directEnd = this.nodeEnd(node, fallbackEnd);
		const childrenWithFields = childEntries.map((entry) => ({
			entry,
			node: this.toTraversableNode(
				entry.node,
				source,
				lineStarts,
				directStart,
				directEnd,
			),
		}));
		childrenWithFields.sort(
			(left, right) =>
				left.node.startIndex - right.node.startIndex ||
				left.node.endIndex - right.node.endIndex,
		);
		const namedChildren = childrenWithFields.map((child) => child.node);
		const childStart = namedChildren.length
			? Math.min(...namedChildren.map((child) => child.startIndex))
			: directStart;
		const childEnd = namedChildren.length
			? Math.max(...namedChildren.map((child) => child.endIndex))
			: directEnd;
		const startIndex = typeof node.start === "number" ? node.start : childStart;
		const endIndex = typeof node.end === "number" ? node.end : childEnd;
		const fieldMap = new Map<string, TraversableNode>();
		childrenWithFields.forEach(({ entry, node: child }) => {
			if (!fieldMap.has(entry.field)) fieldMap.set(entry.field, child);
		});
		if (!fieldMap.has("name")) {
			const name = fieldMap.get("id") ?? fieldMap.get("key");
			if (name) fieldMap.set("name", name);
		}
		if (!fieldMap.has("function") && fieldMap.has("callee")) {
			const callee = fieldMap.get("callee");
			if (callee) fieldMap.set("function", callee);
		}

		return {
			type: node.type,
			startIndex,
			endIndex,
			startPosition: this.positionAt(lineStarts, startIndex),
			endPosition: this.positionAt(lineStarts, endIndex),
			namedChildren,
			childForFieldName: (name) => fieldMap.get(name) ?? null,
		};
	}

	private splitOversizedSegment(
		ast: SvelteAst,
		segment: ChunkSegment,
		maxTokens: number,
	): ChunkSegment[] {
		if (this.estimateTokens(ast.source.slice(segment.start, segment.end)) <= maxTokens) {
			return [segment];
		}
		const chunks: ChunkSegment[] = [];
		let start = segment.start;
		let cursor = segment.start;
		let tokens = 0;
		while (cursor < segment.end) {
			const newline = ast.source.indexOf("\n", cursor);
			const end = newline === -1 || newline >= segment.end ? segment.end : newline + 1;
			const lineTokens = this.estimateTokens(ast.source.slice(cursor, end));
			if (lineTokens > maxTokens) {
				if (cursor > start) chunks.push({ ...segment, start, end: cursor });
				const maxChars = Math.max(1, maxTokens * 4);
				for (let partStart = cursor; partStart < end; partStart += maxChars) {
					chunks.push({
						...segment,
						start: partStart,
						end: Math.min(end, partStart + maxChars),
					});
				}
				cursor = end;
				start = end;
				tokens = 0;
				continue;
			}
			if (cursor > start && tokens + lineTokens > maxTokens) {
				chunks.push({ ...segment, start, end: cursor });
				start = cursor;
				tokens = 0;
			}
			tokens += lineTokens;
			cursor = end;
		}
		if (start < segment.end) chunks.push({ ...segment, start, end: segment.end });
		return chunks;
	}

	private mergeSegments(
		ast: SvelteAst,
		segments: ChunkSegment[],
		targetTokens: number,
		maxTokens: number,
	): ChunkSegment[] {
		const merged: ChunkSegment[] = [];
		for (const segment of segments) {
			const previous = merged[merged.length - 1];
			if (
				previous &&
				previous.chunkType === segment.chunkType &&
				this.estimateTokens(ast.source.slice(previous.start, segment.end)) <=
					Math.min(targetTokens, maxTokens)
			) {
				previous.end = segment.end;
				previous.primarySymbol ??= segment.primarySymbol;
			} else {
				merged.push({ ...segment });
			}
		}
		return merged;
	}

	private dedupeSymbols(symbols: LanguageSymbol[]): LanguageSymbol[] {
		const seen = new Set<string>();
		return symbols.filter((symbol) => {
			const key = `${symbol.kind}\0${symbol.name}\0${symbol.range.startLine}\0${symbol.range.startCol}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	private entrypointScore(filePath: string): number {
		const normalized = filePath.replace(/\\/g, "/");
		const name = path.posix.basename(normalized);
		if (name === "App.svelte") return 100 - normalized.split("/").length;
		if (/\/(?:routes|pages)\/.*\+(?:page|layout|error)\.svelte$/.test(`/${normalized}`)) {
			return 90 - normalized.split("/").length;
		}
		if (/^\+(?:page|layout|error)\.svelte$/.test(name)) {
			return 80 - normalized.split("/").length;
		}
		return 0;
	}

	private buildLineStarts(source: string): number[] {
		const starts = [0];
		for (let index = 0; index < source.length; index += 1) {
			if (source[index] === "\n") starts.push(index + 1);
		}
		return starts;
	}

	private positionAt(lineStarts: number[], offset: number): { row: number; column: number } {
		const safeOffset = Math.max(0, offset);
		let low = 0;
		let high = lineStarts.length - 1;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			if (lineStarts[middle] <= safeOffset) low = middle + 1;
			else high = middle - 1;
		}
		const row = Math.max(0, high);
		return { row, column: safeOffset - lineStarts[row] };
	}

	private rangeFromNode(ast: SvelteAst, node: AstNode): CodeRange {
		const start = this.nodeStart(node, 0);
		return this.rangeFromOffsets(ast, start, this.nodeEnd(node, start));
	}

	private rangeFromOffsets(ast: SvelteAst, start: number, end: number): CodeRange {
		const startPosition = this.positionAt(ast.lineStarts, start);
		const endPosition = this.positionAt(ast.lineStarts, end);
		return {
			startLine: startPosition.row + 1,
			startCol: startPosition.column,
			endLine: endPosition.row + 1,
			endCol: endPosition.column,
		};
	}

	private nodeStart(node: AstNode | undefined, fallback: number): number {
		return node && typeof node.start === "number" ? node.start : fallback;
	}

	private nodeEnd(node: AstNode | undefined, fallback: number): number {
		return node && typeof node.end === "number" ? node.end : fallback;
	}

	private estimateTokens(text: string): number {
		const trimmed = text.trim();
		return trimmed ? Math.max(1, Math.ceil(trimmed.length / 4)) : 0;
	}

	private firstLine(text: string): string {
		return text.trim().split(/\r?\n/, 1)[0] ?? "";
	}
}

export const plugin = new SveltePlugin();
export default plugin;
