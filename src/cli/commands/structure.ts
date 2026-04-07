import path from "node:path";
import type { Command } from "commander";
import { setLogLevel } from "../../core/logger.js";
import type { Project, SymbolRecord } from "../../core/types.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";

type TreeNode = {
	files: Set<string>;
	directories: Map<string, TreeNode>;
};

type CliColors = {
	green(text: string): string;
	red(text: string): string;
	gray(text: string): string;
};

async function loadChalk(): Promise<CliColors> {
	return (await import("chalk")).default as unknown as CliColors;
}

async function loadProject(
	metadata: SqliteMetadataStore,
	repoRoot: string,
): Promise<Project> {
	const project = (await metadata.listProjects()).find(
		(entry) =>
			path.resolve(entry.workdir) === repoRoot ||
			path.resolve(entry.repoRoot) === repoRoot,
	);

	if (!project) {
		throw new Error("Project not initialized. Run `indexer init` first.");
	}

	return project;
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

function printTree(
	node: TreeNode,
	indent: string,
	prefix: string,
	symbolsByFile: Map<string, SymbolRecord[]>,
	chalk: CliColors,
): void {
	const directoryEntries = Array.from(node.directories.entries()).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	const fileEntries = Array.from(node.files).sort((a, b) => a.localeCompare(b));

	for (const [directoryName, childNode] of directoryEntries) {
		const nextPrefix = prefix ? `${prefix}/${directoryName}` : directoryName;
		console.log(`${indent}${chalk.green(`${directoryName}/`)}`);
		printTree(childNode, `${indent}  `, nextPrefix, symbolsByFile, chalk);
	}

	for (const fileName of fileEntries) {
		const filePath = prefix ? `${prefix}/${fileName}` : fileName;
		console.log(`${indent}${fileName}`);

		const symbols = symbolsByFile.get(filePath) ?? [];
		for (const symbol of symbols) {
			console.log(
				`${indent}  ${symbol.name} ${chalk.gray(`(${symbol.kind}${symbol.exported ? ", exported" : ""})`)}`,
			);
		}
	}
}

export function registerStructureCommand(program: Command): void {
	program
		.command("structure")
		.description("Print indexed file and symbol structure")
		.option("--path-prefix <string>", "limit output to a path prefix")
		.option("--kind <string>", "filter symbols by kind")
		.action(async (options?: { pathPrefix?: string; kind?: string }) => {
			const chalk = await loadChalk();
			const resolvedProjectPath = process.cwd();
			const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
			const dbPath = path.join(dataDir, "db.sqlite");

			setLogLevel("error");

			const metadata = new SqliteMetadataStore(dbPath);

			try {
				await metadata.initialize();
				const project = await loadProject(metadata, resolvedProjectPath);
				const snapshot = await metadata.getLatestCompletedSnapshot(project.id);

				if (!snapshot) {
					throw new Error(
						"No completed snapshot found. Run `indexer index` first.",
					);
				}

				const files = await metadata.listFiles(project.id, snapshot.id, {
					pathPrefix: options?.pathPrefix,
				});
				const allSymbols = await metadata.listSymbols(project.id, snapshot.id);
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
					console.log(
						chalk.gray("No indexed files found for the requested filters."),
					);
					return;
				}

				const root = createNode();
				for (const file of files) {
					insertPath(root, file.path);
				}

				printTree(root, "", "", symbolsByFile, chalk);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Structure command failed: ${message}`));
				process.exitCode = 1;
			} finally {
				await metadata.close().catch(() => undefined);
			}
		});
}
