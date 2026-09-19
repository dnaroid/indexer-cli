import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import {
	Node,
	SyntaxKind,
	type Identifier,
	type SourceFile as TypeScriptSourceFile,
} from "ts-morph";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { ensureIndexed } from "./ensure-indexed.js";
import { createDefaultLanguagePlugins } from "../../engine/indexer.js";
import { formatAutoIndexResult } from "../format/compact.js";
import {
	findNearestTests,
	formatSuggestedVerification,
	formatTestHints,
} from "../test-hints.js";
import { resolveInitializedProjectRoot } from "../project-root.js";
import type { DependencyRecord, SymbolRecord } from "../../core/types.js";
import type { LanguagePlugin, ParsedFile } from "../../languages/plugin.js";

type Direction = "callers" | "callees" | "both";
type DepsMode = "modules" | "calls";

interface DependencyEdge {
	path: string;
	via?: string;
	kind?: string;
	depth: number;
}

interface CallEdge {
	symbol: SymbolRecord;
	via?: string;
	depth: number;
}

type ParsedFileCacheEntry = {
	parsed: ParsedFile;
	plugin: LanguagePlugin;
};

type CalledReference = {
	name: string;
	receiver?:
		| { kind: "this"; className: string; isStatic: boolean }
		| { kind: "class" | "instanceClass"; className: string };
};

type CallGraphIndexes = {
	callableSymbols: SymbolRecord[];
	calleesByCaller: Map<string, SymbolRecord[]>;
	callersByCallee: Map<string, SymbolRecord[]>;
	processedCallers: Set<string>;
	processCaller(caller: SymbolRecord): Promise<void>;
	processCallersForCallee(callee: SymbolRecord): Promise<void>;
};

type TreeSitterPointLike = {
	row: number;
};

type TreeSitterNodeLike = {
	type: string;
	startIndex: number;
	endIndex: number;
	startPosition: TreeSitterPointLike;
	endPosition: TreeSitterPointLike;
	children?: TreeSitterNodeLike[];
	namedChildren?: TreeSitterNodeLike[];
	childForFieldName?(name: string): TreeSitterNodeLike | null;
};

type TreeSitterAstLike = {
	source: string;
	tree: {
		rootNode: TreeSitterNodeLike;
	};
};

function normalizeDirection(value?: string): Direction {
	if (value === "callers" || value === "callees" || value === "both") {
		return value;
	}
	throw new Error(
		`Invalid --direction "${value}". Expected callers, callees, or both.`,
	);
}

function normalizeMode(value?: string): DepsMode {
	if (!value || value === "modules" || value === "module-imports") {
		return "modules";
	}
	if (value === "calls" || value === "call-graph") {
		return "calls";
	}
	throw new Error(`Invalid --mode "${value}". Expected modules or calls.`);
}

function compactSpecifier(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function parseTarget(value: string): { path: string; symbolName?: string } {
	const normalized = value.replace(/^\.\//, "");
	const separator = normalized.indexOf("::");
	if (separator === -1) {
		return { path: normalized };
	}
	return {
		path: normalized.slice(0, separator),
		symbolName: normalized.slice(separator + 2),
	};
}

function isCallableSymbol(symbol: SymbolRecord): boolean {
	return symbol.kind === "function" || symbol.kind === "method";
}

function symbolDisplayName(symbol: SymbolRecord): string {
	const qualifiedName = symbol.containerName
		? `${symbol.containerName}.${symbol.name}`
		: symbol.name;
	return `${symbol.filePath}::${qualifiedName}`;
}

function symbolMatchesName(symbol: SymbolRecord, query: string): boolean {
	const qualifiedName = symbol.containerName
		? `${symbol.containerName}.${symbol.name}`
		: symbol.name;
	return (
		symbol.name === query ||
		qualifiedName === query ||
		symbol.name.toLowerCase() === query.toLowerCase() ||
		qualifiedName.toLowerCase() === query.toLowerCase()
	);
}

function formatCallEdge(
	edge: CallEdge,
	prefix: "<-" | "->",
	showEdges: boolean,
): string {
	const depth = edge.depth > 1 ? ` d=${edge.depth}` : "";
	const label = symbolDisplayName(edge.symbol);
	if (!showEdges) return `${prefix} ${label}${depth}`;
	return `${prefix} ${label}${depth} via=${edge.via ?? edge.symbol.name}() kind=call`;
}

function appendUniqueCallEdge(
	edges: CallEdge[],
	seen: Set<string>,
	edge: CallEdge,
): void {
	const key = `${edge.symbol.id}\0${edge.depth}`;
	if (seen.has(key)) return;
	seen.add(key);
	edges.push(edge);
}

function findLanguagePlugin(
	plugins: LanguagePlugin[],
	filePath: string,
): LanguagePlugin | undefined {
	const extension = path.extname(filePath).toLowerCase();
	return plugins.find((plugin) => plugin.fileExtensions.includes(extension));
}

async function getParsedFile(
	repoRoot: string,
	plugins: LanguagePlugin[],
	fileCache: Map<string, ParsedFileCacheEntry>,
	filePath: string,
): Promise<ParsedFileCacheEntry> {
	let entry = fileCache.get(filePath);
	if (!entry) {
		const plugin = findLanguagePlugin(plugins, filePath);
		if (!plugin) {
			throw new Error(`No language plugin found for ${filePath}`);
		}
		const resolvedRoot = path.resolve(repoRoot);
		const resolvedPath = path.resolve(resolvedRoot, filePath);
		const relativePath = path.relative(resolvedRoot, resolvedPath);
		if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
			throw new Error(`Indexed file path escapes project root: ${filePath}`);
		}
		const content = await readFile(resolvedPath, "utf8");
		entry = {
			plugin,
			parsed: plugin.parse({
				path: filePath,
				content,
				projectRoot: repoRoot,
			}),
		};
		fileCache.set(filePath, entry);
	}
	return entry;
}

function nodeStartsInSymbolRange(
	sourceFile: TypeScriptSourceFile,
	node: Node,
	symbol: SymbolRecord,
): boolean {
	const position = sourceFile.getLineAndColumnAtPos(node.getStart());
	return (
		position.line >= symbol.range.start.line &&
		position.line <= symbol.range.end.line
	);
}

function typeScriptThisReceiver(
	callExpression: Node,
): CalledReference["receiver"] | undefined {
	for (const ancestor of callExpression.getAncestors()) {
		if (Node.isArrowFunction(ancestor)) continue;
		if (Node.isMethodDeclaration(ancestor)) {
			// Object-literal methods also use MethodDeclaration. Only a method
			// directly owned by a class has the class's `this` binding.
			const owner = ancestor.getParent();
			const classDeclaration = Node.isClassDeclaration(owner) ? owner : undefined;
			const className = classDeclaration?.getName();
			if (!className) return undefined;
			return {
				kind: "this",
				className,
				isStatic: ancestor.hasModifier(SyntaxKind.StaticKeyword),
			};
		}
		// A normal nested function has its own `this`; resolving it to the
		// enclosing class would create a false edge.
		if (
			Node.isFunctionDeclaration(ancestor) ||
			Node.isFunctionExpression(ancestor)
		) {
			return undefined;
		}
	}
	return undefined;
}

function calledReferenceFromTypeScriptExpression(
	callExpression: Node,
): CalledReference | undefined {
	const expression = Node.isCallExpression(callExpression)
		? callExpression.getExpression()
		: Node.isNewExpression(callExpression)
			? callExpression.getExpression()
			: undefined;
	if (!expression) return undefined;
	if (Node.isIdentifier(expression)) return { name: expression.getText() };
	if (!Node.isPropertyAccessExpression(expression)) return undefined;

	const receiver = expression.getExpression();
	if (receiver.getKind() === SyntaxKind.ThisKeyword) {
		const thisReceiver = typeScriptThisReceiver(callExpression);
		return thisReceiver ? { name: expression.getName(), receiver: thisReceiver } : undefined;
	}
	if (Node.isIdentifier(receiver)) {
		const instanceClassName = receiverClassFromLocalInitializer(
			callExpression,
			receiver,
		);
		if (instanceClassName) {
			return {
				name: expression.getName(),
				receiver: { kind: "instanceClass", className: instanceClassName },
			};
		}
		// An unresolved local is not a static class reference merely because its
		// spelling matches a class elsewhere. Respect the identifier's binding.
		const declarations = receiver.getSymbol()?.getDeclarations() ?? [];
		if (!declarations.some((declaration) =>
			Node.isClassDeclaration(declaration) ||
			Node.isImportSpecifier(declaration) ||
			Node.isImportClause(declaration)
		)) return undefined;
		return {
			name: expression.getName(),
			receiver: { kind: "class", className: receiver.getText() },
		};
	}
	// Arbitrary object receivers need type information. Do not guess based only
	// on a property name.
	return undefined;
}

function receiverClassFromLocalInitializer(
	callExpression: Node,
	receiver: Identifier,
): string | undefined {
	const symbol = receiver.getSymbol();
	if (!symbol) return undefined;
	const declaration = symbol
		.getDeclarations()
		.find(
			(candidate) =>
				Node.isVariableDeclaration(candidate) ||
				Node.isParameterDeclaration(candidate),
		);
	if (!declaration || declaration.getStart() >= callExpression.getStart()) {
		return undefined;
	}

	// A direct assignment can change the instance independently of its declared
	// type or initializer. Without control-flow analysis, omit the edge.
	const binding = symbol.compilerSymbol;
	const reassigned = callExpression
		.getSourceFile()
		.getDescendantsOfKind(SyntaxKind.BinaryExpression)
		.some((assignment) => {
			if (assignment.getStart() >= callExpression.getStart()) return false;
			if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
				return false;
			}
			const left = assignment.getLeft();
			return (
				Node.isIdentifier(left) &&
				left.getSymbol()?.compilerSymbol === binding
			);
		});
	if (reassigned) return undefined;

	const initializer = Node.isVariableDeclaration(declaration)
		? declaration.getInitializer()
		: undefined;
	if (initializer && Node.isNewExpression(initializer)) {
		const expression = initializer.getExpression();
		if (Node.isIdentifier(expression)) return expression.getText();
	}

	const typeName = Node.isParameterDeclaration(declaration)
		? declaration.getTypeNode()?.getText()
		: undefined;
	return typeName && /^[A-Za-z_$][\w$]*$/.test(typeName)
		? typeName
		: undefined;
}

function calledReferencesInTypeScript(
	sourceFile: TypeScriptSourceFile,
	symbol: SymbolRecord,
): CalledReference[] {
	const references: CalledReference[] = [];
	for (const callExpression of sourceFile.getDescendantsOfKind(
		SyntaxKind.CallExpression,
	)) {
		if (!nodeStartsInSymbolRange(sourceFile, callExpression, symbol)) continue;
		const reference = calledReferenceFromTypeScriptExpression(callExpression);
		if (reference) references.push(reference);
	}
	for (const newExpression of sourceFile.getDescendantsOfKind(
		SyntaxKind.NewExpression,
	)) {
		if (!nodeStartsInSymbolRange(sourceFile, newExpression, symbol)) continue;
		const reference = calledReferenceFromTypeScriptExpression(newExpression);
		if (reference) references.push(reference);
	}
	return references;
}

function treeSitterChildren(node: TreeSitterNodeLike): TreeSitterNodeLike[] {
	return node.namedChildren ?? node.children ?? [];
}

function treeSitterNodeText(source: string, node: TreeSitterNodeLike): string {
	return source.slice(node.startIndex, node.endIndex);
}

function treeSitterNodeName(
	source: string,
	node: TreeSitterNodeLike,
): string | undefined {
	const fieldName = node.childForFieldName?.("name");
	if (fieldName) return treeSitterNodeText(source, fieldName);
	const identifier = treeSitterChildren(node).find((child) =>
		[
			"identifier",
			"constant",
			"type_identifier",
			"property_identifier",
			"field_identifier",
			"name",
		].includes(child.type),
	);
	return identifier ? treeSitterNodeText(source, identifier) : undefined;
}

function isTreeSitterCallableNode(
	languageId: string,
	node: TreeSitterNodeLike,
): boolean {
	if (languageId === "python") return node.type === "function_definition";
	if (languageId === "ruby") {
		return node.type === "method" || node.type === "singleton_method";
	}
	if (languageId === "rust") {
		return (
			node.type === "function_item" || node.type === "function_signature_item"
		);
	}
	if (languageId === "csharp") return node.type === "method_declaration";
	if (languageId === "gdscript") return node.type === "function_definition";
	if (languageId === "svelte") {
		return [
			"FunctionDeclaration",
			"VariableDeclarator",
			"MethodDefinition",
		].includes(node.type);
	}
	return false;
}

function isTreeSitterCallNode(
	languageId: string,
	node: TreeSitterNodeLike,
): boolean {
	if (languageId === "python") return node.type === "call";
	if (languageId === "ruby") return node.type === "call";
	if (languageId === "rust") {
		return node.type === "call_expression" || node.type === "macro_invocation";
	}
	if (languageId === "csharp") {
		return (
			node.type === "invocation_expression" ||
			node.type === "object_creation_expression"
		);
	}
	if (languageId === "gdscript") {
		return node.type === "call" || node.type === "attribute_call";
	}
	if (languageId === "svelte") {
		return node.type === "CallExpression" || node.type === "NewExpression";
	}
	return false;
}

function findTreeSitterSymbolNode(
	ast: TreeSitterAstLike,
	languageId: string,
	symbol: SymbolRecord,
): TreeSitterNodeLike | undefined {
	let result: TreeSitterNodeLike | undefined;
	const visit = (node: TreeSitterNodeLike) => {
		if (isTreeSitterCallableNode(languageId, node)) {
			const name = treeSitterNodeName(ast.source, node);
			const startLine = node.startPosition.row + 1;
			const endLine = node.endPosition.row + 1;
			if (
				name === symbol.name &&
				startLine <= symbol.range.start.line &&
				symbol.range.start.line <= endLine &&
				(!result ||
					endLine - startLine <
						result.endPosition.row + 1 - (result.startPosition.row + 1))
			) {
				result = node;
			}
		}
		for (const child of treeSitterChildren(node)) visit(child);
	};
	visit(ast.tree.rootNode);
	return result;
}

function lastIdentifierText(
	source: string,
	node: TreeSitterNodeLike,
): string | undefined {
	if (
		[
			"identifier",
			"constant",
			"type_identifier",
			"property_identifier",
			"field_identifier",
			"name",
		].includes(node.type)
	) {
		return treeSitterNodeText(source, node);
	}
	const children = treeSitterChildren(node);
	for (let index = children.length - 1; index >= 0; index -= 1) {
		const value = lastIdentifierText(source, children[index]);
		if (value) return value;
	}
	return undefined;
}

function calledNameFromTreeSitterNode(
	source: string,
	node: TreeSitterNodeLike,
): string | undefined {
	const expression =
		node.childForFieldName?.("function") ??
		node.childForFieldName?.("name") ??
		node.childForFieldName?.("type");
	if (expression) return lastIdentifierText(source, expression);

	const callableChildren = treeSitterChildren(node).filter(
		(child) =>
			![
				"argument_list",
				"arguments",
				"block",
				"do_block",
				"lambda",
				"token_tree",
			].includes(child.type),
	);
	const fallbackExpression = callableChildren[callableChildren.length - 1];
	return fallbackExpression
		? lastIdentifierText(source, fallbackExpression)
		: undefined;
}

function calledNamesInTreeSitter(
	parsed: ParsedFile,
	symbol: SymbolRecord,
): Set<string> {
	const ast = parsed.ast as TreeSitterAstLike;
	const names = new Set<string>();
	const symbolNode = findTreeSitterSymbolNode(ast, parsed.languageId, symbol);
	if (!symbolNode) return names;

	const visit = (node: TreeSitterNodeLike) => {
		if (node !== symbolNode && isTreeSitterCallNode(parsed.languageId, node)) {
			const calledName = calledNameFromTreeSitterNode(ast.source, node);
			if (calledName) names.add(calledName);
		}
		for (const child of treeSitterChildren(node)) visit(child);
	};
	visit(symbolNode);
	return names;
}

function calledReferencesInParsedFile(
	entry: ParsedFileCacheEntry,
	symbol: SymbolRecord,
): CalledReference[] {
	if (entry.plugin.id === "typescript") {
		return calledReferencesInTypeScript(
			entry.parsed.ast as TypeScriptSourceFile,
			symbol,
		);
	}
	return [...calledNamesInTreeSitter(entry.parsed, symbol)].map((name) => ({
		name,
	}));
}

function typeScriptMethodIsStatic(
	sourceFile: TypeScriptSourceFile,
	symbol: SymbolRecord,
): boolean | undefined {
	if (!symbol.containerName) return undefined;
	const method = sourceFile
		.getClasses()
		.find((classDeclaration) => classDeclaration.getName() === symbol.containerName)
		?.getMethods()
		.find(
			(candidate) =>
				candidate.getName() === symbol.name &&
				sourceFile.getLineAndColumnAtPos(candidate.getStart()).line ===
					symbol.range.start.line,
		);
	return method?.hasModifier(SyntaxKind.StaticKeyword);
}

function createCallGraphIndexes(
	repoRoot: string,
	symbols: SymbolRecord[],
	dependencies: DependencyRecord[],
): CallGraphIndexes {
	const callableSymbols = symbols.filter(isCallableSymbol);
	const classSymbols = symbols.filter((symbol) => symbol.kind === "class");
	const symbolsByFileAndName = new Map<string, Map<string, SymbolRecord[]>>();
	for (const symbol of callableSymbols) {
		let symbolsByName = symbolsByFileAndName.get(symbol.filePath);
		if (!symbolsByName) {
			symbolsByName = new Map<string, SymbolRecord[]>();
			symbolsByFileAndName.set(symbol.filePath, symbolsByName);
		}
		const sameNameSymbols = symbolsByName.get(symbol.name) ?? [];
		sameNameSymbols.push(symbol);
		symbolsByName.set(symbol.name, sameNameSymbols);
	}
	const internalImportsByFile = new Map<string, Set<string>>();
	const internalImportersByFile = new Map<string, Set<string>>();
	for (const dependency of dependencies) {
		if (dependency.dependencyType !== "internal" || !dependency.toPath)
			continue;
		const imports =
			internalImportsByFile.get(dependency.fromPath) ?? new Set<string>();
		imports.add(dependency.toPath);
		internalImportsByFile.set(dependency.fromPath, imports);

		const importers =
			internalImportersByFile.get(dependency.toPath) ?? new Set<string>();
		importers.add(dependency.fromPath);
		internalImportersByFile.set(dependency.toPath, importers);
	}
	const languagePlugins = createDefaultLanguagePlugins();
	const fileCache = new Map<string, ParsedFileCacheEntry>();
	const calleesByCaller = new Map<string, SymbolRecord[]>();
	const callersByCallee = new Map<string, SymbolRecord[]>();
	const processedCallers = new Set<string>();

	const calleeMatchesReference = async (
		reference: CalledReference,
		callee: SymbolRecord,
		candidateFiles: string[],
		callerFilePath: string,
	): Promise<boolean> => {
		if (!reference.receiver) return true;
		const receiver = reference.receiver;
		if (receiver.kind === "this") {
			if (
				callee.filePath !== callerFilePath ||
				callee.containerName !== receiver.className
			) {
				return false;
			}
		} else {
			const matchingClasses = classSymbols.filter(
				(symbol) =>
					symbol.name === receiver.className &&
					candidateFiles.includes(symbol.filePath),
			);
			// Without import/type resolution, a duplicated class name is ambiguous.
			if (
				matchingClasses.length !== 1 ||
				callee.filePath !== matchingClasses[0].filePath ||
				callee.containerName !== receiver.className
			) {
				return false;
			}
		}

		const calleeEntry = await getParsedFile(
			repoRoot,
			languagePlugins,
			fileCache,
			callee.filePath,
		);
		if (calleeEntry.plugin.id !== "typescript") return false;
		const calleeIsStatic = typeScriptMethodIsStatic(
			calleeEntry.parsed.ast as TypeScriptSourceFile,
			callee,
		);
		if (calleeIsStatic === undefined) return false;
		if (receiver.kind === "this") {
			return calleeIsStatic === receiver.isStatic;
		}
		return receiver.kind === "class" ? calleeIsStatic : !calleeIsStatic;
	};

	const processCaller = async (caller: SymbolRecord): Promise<void> => {
		if (processedCallers.has(caller.id)) return;
		processedCallers.add(caller.id);
		const parsedEntry = await getParsedFile(
			repoRoot,
			languagePlugins,
			fileCache,
			caller.filePath,
		);
		const calledReferences = calledReferencesInParsedFile(parsedEntry, caller);
		const importedFiles =
			internalImportsByFile.get(caller.filePath) ?? new Set<string>();
		const candidateFiles = [caller.filePath, ...importedFiles];
		const callees: SymbolRecord[] = [];
		const callerFilePath = caller.filePath;
		for (const reference of calledReferences) {
			for (const candidateFile of candidateFiles) {
				const candidates = symbolsByFileAndName
					.get(candidateFile)
					?.get(reference.name);
				if (!candidates) continue;

				for (const callee of candidates) {
					if (callee.id === caller.id) continue;
					if (
						!(await calleeMatchesReference(
							reference,
							callee,
							candidateFiles,
							callerFilePath,
						))
					)
						continue;

					callees.push(callee);
					const callers = callersByCallee.get(callee.id) ?? [];
					callers.push(caller);
					callersByCallee.set(callee.id, callers);
				}
			}
		}
		calleesByCaller.set(caller.id, callees);
	};

	const processCallersForCallee = async (
		callee: SymbolRecord,
	): Promise<void> => {
		const candidateFiles = new Set([
			callee.filePath,
			...(internalImportersByFile.get(callee.filePath) ?? []),
		]);
		for (const caller of callableSymbols) {
			if (!candidateFiles.has(caller.filePath)) continue;
			await processCaller(caller);
		}
	};

	return {
		callableSymbols,
		calleesByCaller,
		callersByCallee,
		processedCallers,
		processCaller,
		processCallersForCallee,
	};
}

function formatImportEdge(
	edge: DependencyEdge,
	prefix: "<-" | "->",
	showEdges: boolean,
): string {
	const depth = edge.depth > 1 ? ` d=${edge.depth}` : "";
	if (!showEdges || !edge.via) return `${prefix} ${edge.path}${depth}`;
	const via = compactSpecifier(edge.via);
	const kind = edge.kind ? ` kind=${edge.kind}` : "";
	return `${prefix} ${edge.path}${depth} via=${via}${kind}`;
}

function sectionCountLabel(
	edges: Array<{ depth: number }>,
	depth: number,
): string {
	if (depth <= 1) return `direct=${edges.length}`;
	const direct = edges.filter((edge) => edge.depth === 1).length;
	return `direct=${direct} total=${edges.length}`;
}

function riskLevel(
	importedBy: number,
	imports: number,
): "low" | "med" | "high" {
	if (importedBy >= 5 || imports >= 12) return "high";
	if (importedBy >= 2 || imports >= 6) return "med";
	return "low";
}

function appendUniqueEdge(
	edges: DependencyEdge[],
	seen: Set<string>,
	edge: DependencyEdge,
): void {
	const key = `${edge.path}\0${edge.depth}`;
	if (seen.has(key)) return;
	seen.add(key);
	edges.push(edge);
}

function toImportedByEdge(
	dep: DependencyRecord,
	depth: number,
): DependencyEdge {
	return {
		path: dep.fromPath,
		via: dep.toSpecifier,
		kind: dep.kind,
		depth,
	};
}

function toImportsEdge(
	dep: DependencyRecord,
	depth: number,
): DependencyEdge | null {
	if (dep.dependencyType !== "internal" || !dep.toPath) return null;
	return {
		path: dep.toPath,
		via: dep.toSpecifier,
		kind: dep.kind,
		depth,
	};
}

export function registerDepsCommand(program: Command): void {
	program
		.command("deps <path>")
		.description("Show module import dependencies or symbol call dependencies")
		.option(
			"--mode <mode>",
			"dependency mode: modules/module-imports or calls/call-graph",
			"modules",
		)
		.option(
			"--direction <dir>",
			"callers/imported-by, callees/imports, or both",
			"both",
		)
		.option("--depth <n>", "traversal depth (default: 1)", "1")
		.option(
			"--show-edges",
			"show import specifier or call reasons for dependency edges",
		)
		.option("--tests", "show nearest/impacted tests and suggested verification")
		.action(
			async (
				targetPath: string,
				options?: {
					mode?: string;
					direction?: string;
					depth?: string;
					showEdges?: boolean;
					tests?: boolean;
				},
			) => {
				let resolvedProjectPath: string;
				try {
					const resolved = resolveInitializedProjectRoot();
					resolvedProjectPath = resolved.projectRoot;
					if (resolved.notice) {
						console.log(resolved.notice);
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`Error: ${message}`);
					process.exitCode = 1;
					return;
				}
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");

				initLogger(dataDir);
				config.load(dataDir);

				const metadata = new SqliteMetadataStore(dbPath);

				try {
					await metadata.initialize();
					const indexResult = await ensureIndexed(
						metadata,
						resolvedProjectPath,
						{
							silent: !process.stderr.isTTY,
						},
					);
					console.log(formatAutoIndexResult(indexResult));
					if (indexResult.status === "failed") {
						process.exitCode = 1;
						return;
					}

					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error("No completed snapshot found.");
					}

					const mode = normalizeMode(options?.mode);
					const direction = normalizeDirection(options?.direction ?? "both");
					const depth = Math.max(
						1,
						Math.min(5, parseInt(options?.depth ?? "1", 10)),
					);
					const showEdges = options?.showEdges === true;
					const includeTests = options?.tests === true;

					const target = parseTarget(targetPath);
					const normalizedPath = target.path;
					const matchedFiles = await metadata.listFiles(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						{ pathPrefix: normalizedPath },
					);

					if (matchedFiles.length === 0) {
						throw new Error(
							`Module "${normalizedPath}" not found in index. Run "indexer-cli index" to update.`,
						);
					}

					const seedPaths = matchedFiles.map((file) => file.path);

					if (mode === "calls") {
						const allSymbols = await metadata.listSymbols(
							DEFAULT_PROJECT_ID,
							snapshot.id,
						);
						let seedSymbols = allSymbols.filter(
							(symbol) =>
								seedPaths.includes(symbol.filePath) && isCallableSymbol(symbol),
						);

						if (target.symbolName) {
							seedSymbols = seedSymbols.filter((symbol) =>
								symbolMatchesName(symbol, target.symbolName!),
							);
						}

						if (seedSymbols.length === 0) {
							throw new Error(
								target.symbolName
									? `Callable symbol "${target.symbolName}" not found in ${normalizedPath}.`
									: `No callable symbols found in ${normalizedPath}.`,
							);
						}

						const allDependencies = await metadata.listDependencies(
							DEFAULT_PROJECT_ID,
							snapshot.id,
						);
						const callGraph = createCallGraphIndexes(
							resolvedProjectPath,
							allSymbols,
							allDependencies,
						);
						const { calleesByCaller, callersByCallee } = callGraph;
						const calledBy: CallEdge[] = [];
						const calls: CallEdge[] = [];

						if (direction === "callers" || direction === "both") {
							const visited = new Set<string>();
							let queue = seedSymbols;
							const seenEdges = new Set<string>();
							for (let d = 0; d < depth && queue.length > 0; d++) {
								const next: SymbolRecord[] = [];
								for (const symbol of queue) {
									if (visited.has(symbol.id)) continue;
									visited.add(symbol.id);
									await callGraph.processCallersForCallee(symbol);
									for (const caller of callersByCallee.get(symbol.id) ?? []) {
										if (visited.has(caller.id)) continue;
										appendUniqueCallEdge(calledBy, seenEdges, {
											symbol: caller,
											via: symbol.name,
											depth: d + 1,
										});
										next.push(caller);
									}
								}
								queue = next;
							}
							calledBy.sort((a, b) =>
								symbolDisplayName(a.symbol).localeCompare(
									symbolDisplayName(b.symbol),
								),
							);
						}

						if (direction === "callees" || direction === "both") {
							const visited = new Set<string>();
							let queue = seedSymbols;
							const seenEdges = new Set<string>();
							for (let d = 0; d < depth && queue.length > 0; d++) {
								const next: SymbolRecord[] = [];
								for (const symbol of queue) {
									if (visited.has(symbol.id)) continue;
									visited.add(symbol.id);
									await callGraph.processCaller(symbol);
									for (const callee of calleesByCaller.get(symbol.id) ?? []) {
										if (visited.has(callee.id)) continue;
										appendUniqueCallEdge(calls, seenEdges, {
											symbol: callee,
											via: callee.name,
											depth: d + 1,
										});
										next.push(callee);
									}
								}
								queue = next;
							}
							calls.sort((a, b) =>
								symbolDisplayName(a.symbol).localeCompare(
									symbolDisplayName(b.symbol),
								),
							);
						}

						const targetLabel = target.symbolName
							? `${normalizedPath}::${target.symbolName}`
							: normalizedPath;
						console.log(`M ${targetLabel} mode=call-graph`);

						if (direction === "callers" || direction === "both") {
							if (calledBy.length === 0) {
								console.log("\ncalled-by (Callers): none");
							} else {
								console.log(
									`\ncalled-by (Callers) ${sectionCountLabel(calledBy, depth)}:`,
								);
								for (const caller of calledBy) {
									console.log(formatCallEdge(caller, "<-", showEdges));
								}
							}
						}

						if (direction === "callees" || direction === "both") {
							if (calls.length === 0) {
								console.log("\ncalls (Callees): none");
							} else {
								console.log(
									`\ncalls (Callees) ${sectionCountLabel(calls, depth)}:`,
								);
								for (const callee of calls) {
									console.log(formatCallEdge(callee, "->", showEdges));
								}
							}
						}

						const risk = riskLevel(calledBy.length, calls.length);
						console.log(
							`\nRisk: ${risk} called-by=${calledBy.length} calls=${calls.length} mode=call-graph`,
						);

						if (includeTests) {
							const allFiles = await metadata.listFiles(
								DEFAULT_PROJECT_ID,
								snapshot.id,
								{},
							);
							const testHints = findNearestTests({
								targetPaths: seedPaths,
								files: allFiles,
								dependencies: allDependencies,
								maxTests: 3,
							});
							const testLines = formatTestHints(testHints);
							if (testLines.length > 0) {
								console.log("");
								for (const line of testLines) {
									console.log(line);
								}
								const verify = formatSuggestedVerification(testHints);
								if (verify) console.log(verify);
							} else {
								console.log("\nTests: none");
								console.log("Verify: inspect package scripts");
							}
						}
						return;
					}

					const result: {
						path: string;
						importedBy: DependencyEdge[];
						imports: DependencyEdge[];
					} = {
						path: normalizedPath,
						importedBy: [],
						imports: [],
					};

					// BFS traversal
					if (direction === "callers" || direction === "both") {
						const visited = new Set<string>();
						const queue = [...seedPaths];
						const seenEdges = new Set<string>();
						for (let d = 0; d < depth && queue.length > 0; d++) {
							const next: string[] = [];
							for (const p of queue) {
								if (visited.has(p)) continue;
								visited.add(p);
								const dependents = await metadata.getDependents(
									DEFAULT_PROJECT_ID,
									snapshot.id,
									p,
								);
								for (const dep of dependents) {
									if (!visited.has(dep.fromPath)) {
										appendUniqueEdge(
											result.importedBy,
											seenEdges,
											toImportedByEdge(dep, d + 1),
										);
										next.push(dep.fromPath);
									}
								}
							}
							queue.splice(0, queue.length, ...next);
						}
						result.importedBy.sort((a, b) => a.path.localeCompare(b.path));
					}

					if (direction === "callees" || direction === "both") {
						const visited = new Set<string>();
						const queue = [...seedPaths];
						const seenEdges = new Set<string>();
						for (let d = 0; d < depth && queue.length > 0; d++) {
							const next: string[] = [];
							for (const p of queue) {
								if (visited.has(p)) continue;
								visited.add(p);
								const deps = await metadata.listDependencies(
									DEFAULT_PROJECT_ID,
									snapshot.id,
									p,
								);
								for (const dep of deps) {
									const edge = toImportsEdge(dep, d + 1);
									if (edge && !visited.has(edge.path)) {
										appendUniqueEdge(result.imports, seenEdges, edge);
										next.push(edge.path);
									}
								}
							}
							queue.splice(0, queue.length, ...next);
						}
						result.imports.sort((a, b) => a.path.localeCompare(b.path));
					}

					console.log(`M ${result.path} mode=module-imports`);

					if (direction === "callers" || direction === "both") {
						if (result.importedBy.length === 0) {
							console.log("\nimported-by (Callers): none");
						} else {
							console.log(
								`\nimported-by (Callers) ${sectionCountLabel(result.importedBy, depth)}:`,
							);
							for (const caller of result.importedBy) {
								console.log(formatImportEdge(caller, "<-", showEdges));
							}
						}
					}

					if (direction === "callees" || direction === "both") {
						if (result.imports.length === 0) {
							console.log("\nimports (Callees): none");
						} else {
							console.log(
								`\nimports (Callees) ${sectionCountLabel(result.imports, depth)}:`,
							);
							for (const callee of result.imports) {
								console.log(formatImportEdge(callee, "->", showEdges));
							}
						}
					}

					const risk = riskLevel(
						result.importedBy.length,
						result.imports.length,
					);
					console.log(
						`\nRisk: ${risk} imported-by=${result.importedBy.length} imports=${result.imports.length} mode=module-imports`,
					);

					if (includeTests) {
						const [allFiles, allDependencies] = await Promise.all([
							metadata.listFiles(DEFAULT_PROJECT_ID, snapshot.id, {}),
							metadata.listDependencies(DEFAULT_PROJECT_ID, snapshot.id),
						]);
						const testHints = findNearestTests({
							targetPaths: seedPaths,
							files: allFiles,
							dependencies: allDependencies,
							maxTests: 3,
						});
						const testLines = formatTestHints(testHints);
						if (testLines.length > 0) {
							console.log("");
							for (const line of testLines) {
								console.log(line);
							}
							const verify = formatSuggestedVerification(testHints);
							if (verify) console.log(verify);
						} else {
							console.log("\nTests: none");
							console.log("Verify: inspect package scripts");
						}
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`Error: ${message}`);
					process.exitCode = 1;
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
