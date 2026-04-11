import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID, type SymbolRecord } from "../../core/types.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { isJsonOutput } from "../output-mode.js";
import { ensureIndexed } from "./ensure-indexed.js";

type TreeNode = {
	files: Set<string>;
	directories: Map<string, TreeNode>;
};

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

function collectDescendantFiles(
	node: TreeNode,
	prefix: string,
	symbolsByFile: Map<string, SymbolRecord[]>,
	fileCounter?: { printed: number; hidden: number },
	maxFiles?: number,
): Array<{
	name: string;
	path: string;
	symbols: Array<{ name: string; kind: string; exported: boolean }>;
}> {
	const entries: Array<{
		name: string;
		path: string;
		symbols: Array<{ name: string; kind: string; exported: boolean }>;
	}> = [];
	const directoryEntries = Array.from(node.directories.entries()).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	const fileEntries = Array.from(node.files).sort((a, b) => a.localeCompare(b));

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
		entries.push({
			name: fileName,
			path: filePath,
			symbols: (symbolsByFile.get(filePath) ?? []).map((symbol) => ({
				name: symbol.name,
				kind: symbol.kind,
				exported: symbol.exported,
			})),
		});
	}

	for (const [directoryName, childNode] of directoryEntries) {
		if (
			maxFiles !== undefined &&
			fileCounter &&
			fileCounter.printed >= maxFiles
		) {
			fileCounter.hidden += countFiles(childNode);
			continue;
		}

		const childPrefix = prefix ? `${prefix}/${directoryName}` : directoryName;
		entries.push(
			...collectDescendantFiles(
				childNode,
				childPrefix,
				symbolsByFile,
				fileCounter,
				maxFiles,
			),
		);
	}

	return entries;
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
): void {
	if (maxDepth !== undefined && depth >= maxDepth) {
		if (node.files.size > 0) {
			const summary = summarizeHiddenChildren(node);
			if (summary !== "... (0 children)") {
				console.log(`${indent}${summary}`);
			}
			return;
		}

		for (const file of collectDescendantFiles(
			node,
			prefix,
			symbolsByFile,
			fileCounter,
			maxFiles,
		)) {
			console.log(`${indent}${file.path}`);
			for (const symbol of file.symbols) {
				const exported = symbol.exported ? ", exported" : "";
				console.log(`${indent}  ${symbol.name} (${symbol.kind}${exported})`);
			}
			if (file.symbols.length === 0) {
				console.log(`${indent}  (no symbols)`);
			}
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

		const nextPrefix = prefix ? `${prefix}/${directoryName}` : directoryName;
		console.log(`${indent}${directoryName}/`);
		printTree(
			childNode,
			`${indent}  `,
			nextPrefix,
			symbolsByFile,
			depth + 1,
			maxDepth,
			fileCounter,
			maxFiles,
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
		console.log(`${indent}${fileName}`);
		if (fileCounter) {
			fileCounter.printed += 1;
		}

		const symbols = symbolsByFile.get(filePath) ?? [];
		if (symbols.length > 0) {
			for (const symbol of symbols) {
				const exported = symbol.exported ? ", exported" : "";
				console.log(`${indent}  ${symbol.name} (${symbol.kind}${exported})`);
			}
		} else {
			console.log(`${indent}  (no symbols)`);
		}
	}
}

function treeToJson(
	node: TreeNode,
	prefix: string,
	symbolsByFile: Map<string, SymbolRecord[]>,
	depth: number,
	maxDepth?: number,
	fileCounter?: { printed: number; hidden: number },
	maxFiles?: number,
): object[] {
	if (maxDepth !== undefined && depth >= maxDepth) {
		if (node.files.size > 0) {
			const summary = summarizeHiddenChildren(node);
			return summary === "... (0 children)"
				? []
				: [{ type: "summary", name: summary }];
		}

		return collectDescendantFiles(
			node,
			prefix,
			symbolsByFile,
			fileCounter,
			maxFiles,
		).map((file) => ({
			type: "file",
			name: file.name,
			path: file.path,
			symbols: file.symbols,
		}));
	}

	const entries: object[] = [];
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

		const childPrefix = prefix ? `${prefix}/${directoryName}` : directoryName;
		const children = treeToJson(
			childNode,
			childPrefix,
			symbolsByFile,
			depth + 1,
			maxDepth,
			fileCounter,
			maxFiles,
		);
		if (maxFiles !== undefined && children.length === 0) {
			continue;
		}

		entries.push({
			type: "directory",
			name: directoryName,
			children,
		});
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
		const symbols = (symbolsByFile.get(filePath) ?? []).map((s) => ({
			name: s.name,
			kind: s.kind,
			exported: s.exported,
		}));
		if (fileCounter) {
			fileCounter.printed += 1;
		}
		entries.push({ type: "file", name: fileName, path: filePath, symbols });
	}

	return entries;
}

function narrowJsonTreeToPathPrefix(
	entries: object[],
	pathPrefix?: string,
): object[] {
	if (!pathPrefix) {
		return entries;
	}

	const parts = pathPrefix.split("/").filter(Boolean);
	let current = entries;

	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		const file = current.find(
			(
				entry,
			): entry is {
				type: string;
				name: string;
				path: string;
			} =>
				typeof entry === "object" &&
				entry !== null &&
				"type" in entry &&
				"name" in entry &&
				"path" in entry &&
				(entry as { type: string; name: string }).type === "file" &&
				(entry as { type: string; name: string }).name === part,
		);
		if (file) {
			return index === parts.length - 1 ? [file] : [];
		}

		const dir = current.find(
			(
				entry,
			): entry is {
				type: string;
				name: string;
				children?: object[];
			} =>
				typeof entry === "object" &&
				entry !== null &&
				"type" in entry &&
				"name" in entry &&
				(entry as { type: string; name: string }).type === "directory" &&
				(entry as { type: string; name: string }).name === part,
		);

		if (!dir) {
			return [];
		}

		current = dir.children ?? [];
	}

	return current;
}

export function registerStructureCommand(program: Command): void {
	program
		.command("structure")
		.description("Print indexed file and symbol structure")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option("--path-prefix <string>", "limit output to a path prefix")
		.option("--kind <string>", "filter symbols by kind")
		.option(
			"--max-depth <number>",
			"limit directory traversal depth in the rendered tree",
		)
		.option("--max-files <number>", "limit number of files shown in output")
		.option("--txt", "output results as human-readable text")
		.action(
			async (options?: {
				pathPrefix?: string;
				kind?: string;
				maxDepth?: string;
				maxFiles?: string;
				txt?: boolean;
			}) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");
				const isJson = isJsonOutput(options);

				initLogger(dataDir);
				config.load(dataDir);

				const metadata = new SqliteMetadataStore(dbPath);

				try {
					const maxDepth = parseMaxDepth(options?.maxDepth);
					const maxFiles = parseMaxFiles(options?.maxFiles);
					const fileCounter =
						maxFiles !== undefined ? { printed: 0, hidden: 0 } : undefined;

					await metadata.initialize();
					await ensureIndexed(metadata, resolvedProjectPath, {
						silent: isJson,
					});
					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error(
							"Auto-indexing did not produce a completed snapshot.",
						);
					}

					const files = await metadata.listFiles(
						DEFAULT_PROJECT_ID,
						snapshot.id,
						{
							pathPrefix: options?.pathPrefix,
						},
					);
					const allSymbols = await metadata.listSymbols(
						DEFAULT_PROJECT_ID,
						snapshot.id,
					);
					const symbolsByFile = new Map<string, SymbolRecord[]>();

					for (const symbol of allSymbols) {
						if (options?.kind && symbol.kind !== options.kind) {
							continue;
						}
						if (
							options?.pathPrefix &&
							!symbol.filePath.startsWith(options.pathPrefix)
						) {
							continue;
						}
						const current = symbolsByFile.get(symbol.filePath) ?? [];
						current.push(symbol);
						symbolsByFile.set(symbol.filePath, current);
					}

					if (files.length === 0) {
						if (isJson) {
							console.log("[]");
						} else {
							console.log("No indexed files found for the requested filters.");
						}
						return;
					}

					const root = createNode();
					for (const file of files) {
						insertPath(root, file.path);
					}

					if (isJson) {
						let tree = treeToJson(
							root,
							"",
							symbolsByFile,
							0,
							maxDepth,
							fileCounter,
							maxFiles,
						);

						tree = narrowJsonTreeToPathPrefix(tree, options?.pathPrefix);

						if (fileCounter && fileCounter.hidden > 0) {
							tree.push({ type: "truncated", hiddenFiles: fileCounter.hidden });
						}
						console.log(JSON.stringify(tree, null, 2));
					} else {
						printTree(
							root,
							"",
							"",
							symbolsByFile,
							0,
							maxDepth,
							fileCounter,
							maxFiles,
						);
						if (fileCounter && fileCounter.hidden > 0) {
							console.log(
								`\n... and ${fileCounter.hidden} more files (use --max-files to see more)`,
							);
						}
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (isJson) {
						console.error(JSON.stringify({ error: message }, null, 2));
					} else {
						console.error(`Structure command failed: ${message}`);
					}
					process.exitCode = 1;
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
