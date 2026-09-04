import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { TypeScriptPlugin } from "../../languages/typescript.js";
import { PythonPlugin } from "../../languages/python.js";
import { CSharpPlugin } from "../../languages/csharp.js";
import { GDScriptPlugin } from "../../languages/gdscript.js";
import { RubyPlugin } from "../../languages/ruby.js";
import { RustPlugin } from "../../languages/rust.js";
import { SveltePlugin } from "../../languages/svelte.js";
import type { LanguagePlugin } from "../../languages/plugin.js";
import { resolveInitializedProjectRoot } from "../project-root.js";

type AstCommandOptions = {
	maxDepth?: string;
	maxNodes?: string;
	cursor?: string;
	includeText?: boolean;
};

type AstNodeView = {
	kind: string;
	startLine: number;
	endLine: number;
	text?: string;
	children: AstNodeView[];
};

type TsMorphNodeLike = {
	getKindName(): string;
	getStartLineNumber(): number;
	getEndLineNumber(): number;
	getText(): string;
	forEachChild(callback: (node: TsMorphNodeLike) => void): void;
};

type TreeSitterPoint = {
	row: number;
};

type TreeSitterNodeLike = {
	type: string;
	startPosition: TreeSitterPoint;
	endPosition: TreeSitterPoint;
	startIndex: number;
	endIndex: number;
	namedChildren?: TreeSitterNodeLike[];
	children?: TreeSitterNodeLike[];
};

type TreeSitterAstLike = {
	source: string;
	tree: {
		rootNode: TreeSitterNodeLike;
	};
};

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_NODES = 120;
const MAX_TEXT_LENGTH = 90;

function parseNonNegativeInteger(
	value: string | undefined,
	optionName: string,
	fallback: number,
): number {
	if (!value) {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${optionName} must be a non-negative integer`);
	}

	return parsed;
}

function parsePositiveInteger(
	value: string | undefined,
	optionName: string,
	fallback: number,
): number {
	if (!value) {
		return fallback;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${optionName} must be a positive integer`);
	}

	return parsed;
}

function createLanguagePlugins(): LanguagePlugin[] {
	return [
		new TypeScriptPlugin(),
		new PythonPlugin(),
		new CSharpPlugin(),
		new GDScriptPlugin(),
		new RubyPlugin(),
		new RustPlugin(),
		new SveltePlugin(),
	];
}

function findPlugin(filePath: string): LanguagePlugin | undefined {
	const extension = path.extname(filePath).toLowerCase();
	return createLanguagePlugins().find((plugin) =>
		plugin.fileExtensions.includes(extension),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTsMorphNode(value: unknown): value is TsMorphNodeLike {
	return (
		isRecord(value) &&
		typeof value.getKindName === "function" &&
		typeof value.getStartLineNumber === "function" &&
		typeof value.getEndLineNumber === "function" &&
		typeof value.getText === "function" &&
		typeof value.forEachChild === "function"
	);
}

function isTreeSitterAst(value: unknown): value is TreeSitterAstLike {
	if (!isRecord(value) || typeof value.source !== "string") {
		return false;
	}
	const tree = value.tree;
	return isRecord(tree) && isRecord(tree.rootNode);
}

function compactText(text: string): string | undefined {
	const firstLine = text.trim().split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) {
		return undefined;
	}
	return firstLine.length > MAX_TEXT_LENGTH
		? `${firstLine.slice(0, MAX_TEXT_LENGTH - 1)}…`
		: firstLine;
}

function tsMorphToView(node: TsMorphNodeLike, depth: number): AstNodeView {
	const children: AstNodeView[] = [];
	if (depth > 0) {
		node.forEachChild((child) => {
			children.push(tsMorphToView(child, depth - 1));
		});
	}

	return {
		kind: node.getKindName(),
		startLine: node.getStartLineNumber(),
		endLine: node.getEndLineNumber(),
		text: compactText(node.getText()),
		children,
	};
}

function treeSitterNodeText(
	source: string,
	node: TreeSitterNodeLike,
): string | undefined {
	return compactText(source.slice(node.startIndex, node.endIndex));
}

function treeSitterToView(
	source: string,
	node: TreeSitterNodeLike,
	depth: number,
): AstNodeView {
	const rawChildren = node.namedChildren ?? node.children ?? [];
	const children =
		depth > 0
			? rawChildren.map((child) => treeSitterToView(source, child, depth - 1))
			: [];

	return {
		kind: node.type,
		startLine: node.startPosition.row + 1,
		endLine: node.endPosition.row + 1,
		text: treeSitterNodeText(source, node),
		children,
	};
}

function flattenTree(
	node: AstNodeView,
): Array<{ node: AstNodeView; depth: number }> {
	const result: Array<{ node: AstNodeView; depth: number }> = [];
	const visit = (current: AstNodeView, depth: number) => {
		result.push({ node: current, depth });
		for (const child of current.children) {
			visit(child, depth + 1);
		}
	};
	visit(node, 0);
	return result;
}

function formatNodeLine(
	entry: { node: AstNodeView; depth: number },
	includeText: boolean,
): string {
	const indent = "  ".repeat(entry.depth);
	const range =
		entry.node.startLine === entry.node.endLine
			? `${entry.node.startLine}`
			: `${entry.node.startLine}-${entry.node.endLine}`;
	const suffix = includeText && entry.node.text ? ` — ${entry.node.text}` : "";
	return `${indent}${entry.node.kind}:${range}${suffix}`;
}

function quotePathForNext(value: string): string {
	return /\s/.test(value) ? JSON.stringify(value) : value;
}

export function registerAstCommand(program: Command): void {
	program
		.command("ast <file>")
		.description("Print a compact AST outline for one source file")
		.option(
			"--max-depth <number>",
			"limit AST traversal depth",
			String(DEFAULT_MAX_DEPTH),
		)
		.option(
			"--max-nodes <number>",
			"limit number of AST nodes shown",
			String(DEFAULT_MAX_NODES),
		)
		.option("--cursor <number>", "continue output from a previous TRUNC cursor")
		.option("--no-include-text", "hide compact first-line snippets")
		.action(async (file: string, options?: AstCommandOptions) => {
			try {
				const resolved = resolveInitializedProjectRoot();
				if (resolved.notice) {
					console.log(resolved.notice);
				}
				const projectRoot = resolved.projectRoot;
				const requestedPath = file.replace(/\\/g, "/").replace(/^\.\//, "");
				const absolutePath = path.isAbsolute(file)
					? file
					: path.join(projectRoot, requestedPath);
				const relativePath = path
					.relative(projectRoot, absolutePath)
					.replace(/\\/g, "/");
				const plugin = findPlugin(relativePath);

				if (!plugin) {
					throw new Error(`No supported parser for '${relativePath}'.`);
				}

				const maxDepth = parseNonNegativeInteger(
					options?.maxDepth,
					"--max-depth",
					DEFAULT_MAX_DEPTH,
				);
				const maxNodes = parsePositiveInteger(
					options?.maxNodes,
					"--max-nodes",
					DEFAULT_MAX_NODES,
				);
				const cursor = parseNonNegativeInteger(options?.cursor, "--cursor", 0);
				const content = fs.readFileSync(absolutePath, "utf8");
				const parsed = plugin.parse({
					path: relativePath,
					content,
					projectRoot,
				});

				let root: AstNodeView;
				if (isTsMorphNode(parsed.ast)) {
					root = tsMorphToView(parsed.ast, maxDepth);
				} else if (isTreeSitterAst(parsed.ast)) {
					root = treeSitterToView(
						parsed.ast.source,
						parsed.ast.tree.rootNode,
						maxDepth,
					);
				} else {
					throw new Error(
						`Parser for '${plugin.id}' does not expose a traversable AST.`,
					);
				}

				const flattened = flattenTree(root);
				const page = flattened.slice(cursor, cursor + maxNodes);
				console.log(
					`AST ${relativePath} language=${plugin.id} nodes=${flattened.length} maxDepth=${maxDepth}`,
				);
				for (const entry of page) {
					console.log(formatNodeLine(entry, options?.includeText !== false));
				}

				const nextCursor = cursor + page.length;
				const hidden = Math.max(0, flattened.length - nextCursor);
				if (hidden > 0) {
					console.log(`\nTRUNC hidden=${hidden} cursor=${nextCursor}`);
					const nextParts = [
						"idx ast",
						quotePathForNext(relativePath),
						`--max-depth ${maxDepth}`,
						`--max-nodes ${maxNodes}`,
						`--cursor ${nextCursor}`,
					];
					if (options?.includeText === false) {
						nextParts.push("--no-include-text");
					}
					console.log(`NEXT ${nextParts.join(" ")}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`AST command failed: ${message}`);
				process.exitCode = 1;
			}
		});
}
