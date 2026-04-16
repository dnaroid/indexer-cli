import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID, type SymbolRecord } from "../../core/types.js";
import { matchesPathPatterns } from "../../engine/architecture.js";
import { isTestFile } from "../../engine/searcher.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { ensureIndexed } from "./ensure-indexed.js";
import { resolveInitializedProjectRoot } from "../project-root.js";

type TreeNode = {
	files: Set<string>;
	directories: Map<string, TreeNode>;
};

type CollapsedDirectory = {
	label: string;
	prefix: string;
	node: TreeNode;
	depth: number;
};

const SYMBOL_KIND_ORDER = [
	"class",
	"interface",
	"type",
	"function",
	"method",
	"variable",
	"signal",
	"module",
] as const;

const SYMBOL_KIND_RANK = new Map<string, number>(
	SYMBOL_KIND_ORDER.map(
		(kind, index) => [kind, index] satisfies [string, number],
	),
);

function parseMaxDepth(value?: string): number | undefined {
	if (!value) {
		return undefined;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error("--max-depth must be a non-negative integer");
	}

	return parsed;
}

function parseMaxFiles(value?: string): number | undefined {
	if (!value) {
		return undefined;
	}

	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error("--max-files must be a positive integer");
	}

	return parsed;
}

function createNode(): TreeNode {
	return { files: new Set<string>(), directories: new Map<string, TreeNode>() };
}

function insertPath(root: TreeNode, filePath: string): void {
	const parts = filePath.split("/");
	let current = root;

	for (let index = 0; index < parts.length - 1; index += 1) {
		const part = parts[index];
		if (!current.directories.has(part)) {
			current.directories.set(part, createNode());
		}
		current = current.directories.get(part)!;
	}

	current.files.add(parts[parts.length - 1]);
}

function countFiles(node: TreeNode): number {
	let total = node.files.size;

	for (const childNode of node.directories.values()) {
		total += countFiles(childNode);
	}

	return total;
}

function summarizeHiddenChildren(node: TreeNode): string {
	return `... (${node.directories.size + node.files.size} children)`;
}

function getSymbolKindRank(kind: string): number {
	return SYMBOL_KIND_RANK.get(kind) ?? SYMBOL_KIND_ORDER.length;
}

function sortSymbols(
	symbols: Array<{ name: string; kind: string; exported: boolean }>,
): Array<{ name: string; kind: string; exported: boolean }> {
	return [...symbols].sort((a, b) => {
		const kindRank = getSymbolKindRank(a.kind) - getSymbolKindRank(b.kind);
		if (kindRank !== 0) {
			return kindRank;
		}

		const kindName = a.kind.localeCompare(b.kind);
		if (kindName !== 0) {
			return kindName;
		}

		if (a.exported !== b.exported) {
			return a.exported ? -1 : 1;
		}

		return a.name.localeCompare(b.name);
	});
}

function formatSymbols(
	symbols: Array<{ name: string; kind: string; exported: boolean }>,
	includeInternal?: boolean,
): string | undefined {
	if (symbols.length === 0) {
		return undefined;
	}

	const groups = new Map<string, { label: string; names: string[] }>();

	for (const symbol of sortSymbols(symbols)) {
		const isInternal = includeInternal && !symbol.exported;
		const label = isInternal ? `${symbol.kind} (internal)` : symbol.kind;
		const key = `${symbol.kind}:${isInternal ? "internal" : "exported"}`;
		const group = groups.get(key);

		if (group) {
			group.names.push(symbol.name);
			continue;
		}

		groups.set(key, { label, names: [symbol.name] });
	}

	return Array.from(groups.values())
		.map((group) => `${group.label}: ${group.names.join(", ")}`)
		.join("; ");
}

function printFileLine(
	indent: string,
	fileLabel: string,
	symbols: Array<{ name: string; kind: string; exported: boolean }>,
	includeInternal?: boolean,
): void {
	const formattedSymbols = formatSymbols(symbols, includeInternal);
	console.log(
		formattedSymbols
			? `${indent}${fileLabel} — ${formattedSymbols}`
			: `${indent}${fileLabel}`,
	);
}

function collapseDirectoryChain(
	directoryName: string,
	childNode: TreeNode,
	prefix: string,
	depth: number,
	maxDepth?: number,
): CollapsedDirectory {
	const segments = [directoryName];
	let node = childNode;
	let currentDepth = depth + 1;

	while (
		node.files.size === 0 &&
		node.directories.size === 1 &&
		(maxDepth === undefined || currentDepth < maxDepth)
	) {
		const [nextName, nextNode] =
			Array.from(node.directories.entries())[0] ?? [];
		if (!nextName || !nextNode) {
			break;
		}
		segments.push(nextName);
		node = nextNode;
		currentDepth += 1;
	}

	const relativePath = segments.join("/");
	return {
		label: `${relativePath}/`,
		prefix: prefix ? `${prefix}/${relativePath}` : relativePath,
		node,
		depth: currentDepth,
	};
}

function printTree(
	node: TreeNode,
	indent: string,
	prefix: string,
	symbolsByFile: Map<string, SymbolRecord[]>,
	depth: number,
	maxDepth?: number,
	fileCounter?: { printed: number; hidden: number },
	maxFiles?: number,
	includeInternal?: boolean,
): void {
	if (maxDepth !== undefined && depth >= maxDepth) {
		for (const fileName of Array.from(node.files).sort()) {
			if (
				maxFiles !== undefined &&
				fileCounter &&
				fileCounter.printed >= maxFiles
			) {
				fileCounter.hidden += 1;
				continue;
			}
			if (fileCounter) {
				fileCounter.printed += 1;
			}
			const filePath = prefix ? `${prefix}/${fileName}` : fileName;
			printFileLine(
				indent,
				fileName,
				symbolsByFile.get(filePath) ?? [],
				includeInternal,
			);
		}

		for (const [dirName, childNode] of Array.from(
			node.directories.entries(),
		).sort((a, b) => a[0].localeCompare(b[0]))) {
			console.log(`${indent}${dirName}/ ${summarizeHiddenChildren(childNode)}`);
		}
		return;
	}

	const directoryEntries = Array.from(node.directories.entries()).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	const fileEntries = Array.from(node.files).sort((a, b) => a.localeCompare(b));

	for (const [directoryName, childNode] of directoryEntries) {
		if (
			maxFiles !== undefined &&
			fileCounter &&
			fileCounter.printed >= maxFiles
		) {
			fileCounter.hidden += countFiles(childNode);
			continue;
		}

		const collapsedDirectory = collapseDirectoryChain(
			directoryName,
			childNode,
			prefix,
			depth,
			maxDepth,
		);
		console.log(`${indent}${collapsedDirectory.label}`);
		printTree(
			collapsedDirectory.node,
			`${indent}  `,
			collapsedDirectory.prefix,
			symbolsByFile,
			collapsedDirectory.depth,
			maxDepth,
			fileCounter,
			maxFiles,
			includeInternal,
		);
	}

	for (const fileName of fileEntries) {
		if (
			maxFiles !== undefined &&
			fileCounter &&
			fileCounter.printed >= maxFiles
		) {
			fileCounter.hidden += 1;
			continue;
		}

		const filePath = prefix ? `${prefix}/${fileName}` : fileName;
		if (fileCounter) {
			fileCounter.printed += 1;
		}

		printFileLine(
			indent,
			fileName,
			symbolsByFile.get(filePath) ?? [],
			includeInternal,
		);
	}
}

export function registerStructureCommand(program: Command): void {
	program
		.command("structure")
		.description("Print indexed file and symbol structure")
		.option("--path-prefix <string>", "limit output to a path prefix")
		.option("--kind <string>", "filter symbols by kind")
		.option(
			"--max-depth <number>",
			"limit directory traversal depth in the rendered tree",
		)
		.option("--max-files <number>", "limit number of files shown in output")
		.option("--include-fixtures", "include fixture/vendor paths in output")
		.option(
			"--include-internal",
			"include non-exported symbols (methods, private members)",
		)
		.option("--no-tests", "exclude test files from output")
		.action(
			async (options?: {
				pathPrefix?: string;
				kind?: string;
				maxDepth?: string;
				maxFiles?: string;
				includeFixtures?: boolean;
				includeInternal?: boolean;
				tests?: boolean;
			}) => {
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
					console.error(`Structure command failed: ${message}`);
					process.exitCode = 1;
					return;
				}
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");

				initLogger(dataDir);
				config.load(dataDir);

				const metadata = new SqliteMetadataStore(dbPath);

				try {
					let maxDepth = parseMaxDepth(options?.maxDepth);
					const maxFiles = parseMaxFiles(options?.maxFiles);
					const fileCounter =
						maxFiles !== undefined ? { printed: 0, hidden: 0 } : undefined;

					await metadata.initialize();
					await ensureIndexed(metadata, resolvedProjectPath, {
						silent: !process.stderr.isTTY,
					});
					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error(
							"Auto-indexing did not produce a completed snapshot.",
						);
					}

					let effectivePathPrefix = options?.pathPrefix;
					let files = await metadata.listFiles(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						{
							pathPrefix: effectivePathPrefix,
						},
					);

					if (effectivePathPrefix && files.length === 0) {
						console.log(
							`Path '${effectivePathPrefix}' not found in indexed files. Showing results for the entire project instead.`,
						);
						effectivePathPrefix = undefined;
						files = await metadata.listFiles(
							DEFAULT_PROJECT_ID,
							snapshot.id,
							{},
						);
						if (options?.maxDepth === undefined) {
							maxDepth = 1;
						}
					}

					const excludePatterns = options?.includeFixtures
						? []
						: config.get("excludePaths");
					const visibleFiles =
						excludePatterns.length === 0
							? files
							: files.filter(
									(file) => !matchesPathPatterns(file.path, excludePatterns),
								);
					const filteredFiles =
						options?.tests === false
							? visibleFiles.filter((file) => !isTestFile(file.path))
							: visibleFiles;
					const visibleFilePaths = new Set(
						filteredFiles.map((file) => file.path),
					);
					const allSymbols = await metadata.listSymbols(
						DEFAULT_PROJECT_ID,
						snapshot.id,
					);
					const symbolsByFile = new Map<string, SymbolRecord[]>();

					for (const symbol of allSymbols) {
						if (!visibleFilePaths.has(symbol.filePath)) {
							continue;
						}
						if (options?.kind && symbol.kind !== options.kind) {
							continue;
						}
						if (
							effectivePathPrefix &&
							!symbol.filePath.startsWith(effectivePathPrefix)
						) {
							continue;
						}
						if (!options?.includeInternal && !symbol.exported) {
							continue;
						}
						const current = symbolsByFile.get(symbol.filePath) ?? [];
						current.push(symbol);
						symbolsByFile.set(symbol.filePath, current);
					}

					if (filteredFiles.length === 0) {
						console.log("No indexed files found for the requested filters.");
						return;
					}

					const root = createNode();
					const stripPrefix = effectivePathPrefix
						? effectivePathPrefix.replace(/\/+$/, "") + "/"
						: "";
					for (const file of filteredFiles) {
						const relativePath = stripPrefix
							? file.path.slice(stripPrefix.length)
							: file.path;
						insertPath(root, relativePath);
					}

					printTree(
						root,
						"",
						stripPrefix.replace(/\/$/, ""),
						symbolsByFile,
						0,
						maxDepth,
						fileCounter,
						maxFiles,
						options?.includeInternal,
					);
					if (fileCounter && fileCounter.hidden > 0) {
						console.log(
							`\n... and ${fileCounter.hidden} more files (use --max-files to see more)`,
						);
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`Structure command failed: ${message}`);
					process.exitCode = 1;
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
