import path from "node:path";
import type { Command } from "commander";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID, type SymbolRecord } from "../../core/types.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { ensureIndexed } from "./ensure-indexed.js";

type TreeNode = {
	files: Set<string>;
	directories: Map<string, TreeNode>;
};

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

function printTree(
	node: TreeNode,
	indent: string,
	prefix: string,
	symbolsByFile: Map<string, SymbolRecord[]>,
): void {
	const directoryEntries = Array.from(node.directories.entries()).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	const fileEntries = Array.from(node.files).sort((a, b) => a.localeCompare(b));

	for (const [directoryName, childNode] of directoryEntries) {
		const nextPrefix = prefix ? `${prefix}/${directoryName}` : directoryName;
		console.log(`${indent}${directoryName}/`);
		printTree(childNode, `${indent}  `, nextPrefix, symbolsByFile);
	}

	for (const fileName of fileEntries) {
		const filePath = prefix ? `${prefix}/${fileName}` : fileName;
		console.log(`${indent}${fileName}`);

		const symbols = symbolsByFile.get(filePath) ?? [];
		for (const symbol of symbols) {
			const exported = symbol.exported ? ", exported" : "";
			console.log(`${indent}  ${symbol.name} (${symbol.kind}${exported})`);
		}
	}
}

function treeToJson(
	node: TreeNode,
	prefix: string,
	symbolsByFile: Map<string, SymbolRecord[]>,
): object[] {
	const entries: object[] = [];
	const directoryEntries = Array.from(node.directories.entries()).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	const fileEntries = Array.from(node.files).sort((a, b) => a.localeCompare(b));

	for (const [directoryName, childNode] of directoryEntries) {
		const childPrefix = prefix ? `${prefix}/${directoryName}` : directoryName;
		entries.push({
			type: "directory",
			name: directoryName,
			children: treeToJson(childNode, childPrefix, symbolsByFile),
		});
	}

	for (const fileName of fileEntries) {
		const filePath = prefix ? `${prefix}/${fileName}` : fileName;
		const symbols = (symbolsByFile.get(filePath) ?? []).map((s) => ({
			name: s.name,
			kind: s.kind,
			exported: s.exported,
		}));
		entries.push({ type: "file", name: fileName, path: filePath, symbols });
	}

	return entries;
}

export function registerStructureCommand(program: Command): void {
	program
		.command("structure")
		.description("Print indexed file and symbol structure")
		.option("--path-prefix <string>", "limit output to a path prefix")
		.option("--kind <string>", "filter symbols by kind")
		.option("--json", "output results as JSON")
		.action(
			async (options?: {
				pathPrefix?: string;
				kind?: string;
				json?: boolean;
			}) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");

				initLogger(dataDir);

				const metadata = new SqliteMetadataStore(dbPath);

				try {
					await metadata.initialize();
					await ensureIndexed(metadata, resolvedProjectPath);
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
						if (options?.json) {
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

					if (options?.json) {
						console.log(
							JSON.stringify(treeToJson(root, "", symbolsByFile), null, 2),
						);
					} else {
						printTree(root, "", "", symbolsByFile);
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
