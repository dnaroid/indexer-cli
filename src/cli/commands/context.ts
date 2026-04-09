import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import { SimpleGitOperations } from "../../engine/git.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { ensureIndexed } from "./ensure-indexed.js";

type ArchitectureSnapshot = {
	file_stats?: Record<string, number>;
	entrypoints?: string[];
	dependency_map?: {
		internal?: Record<string, string[]>;
		external?: Record<string, string[]>;
	};
};

type ContextData = {
	architecture: {
		fileStats: Record<string, number>;
		entrypoints: string[];
	};
	modules: Array<{
		path: string;
		summary: string | null;
	}>;
	symbols: Array<{
		file: string;
		name: string;
		kind: string;
		signature?: string;
		description: string | null;
	}>;
	dependencies: Record<string, string[]>;
};

function formatPlain(data: ContextData): void {
	// Architecture overview
	console.log("## Architecture\n");
	const stats = Object.entries(data.architecture.fileStats)
		.sort((a, b) => b[1] - a[1])
		.map(([lang, count]) => `${lang}: ${count}`)
		.join(", ");
	if (stats) console.log(`Files: ${stats}`);

	if (data.architecture.entrypoints.length > 0) {
		console.log(
			`Entry points: ${data.architecture.entrypoints.slice(0, 5).join(", ")}`,
		);
	}

	// Module summaries
	const enrichedModules = data.modules.filter((m) => m.summary);
	if (enrichedModules.length > 0) {
		console.log("\n## Module Summaries\n");
		for (const mod of enrichedModules) {
			console.log(`${mod.path}`);
			console.log(`  ${mod.summary}`);
		}
	} else {
		console.log(
			"\n(No module summaries yet. Run `indexer-cli enrich` to generate them.)",
		);
	}

	// Key symbols
	const enrichedSymbols = data.symbols.filter((s) => s.description);
	if (enrichedSymbols.length > 0) {
		console.log("\n## Key Symbols\n");
		for (const sym of enrichedSymbols) {
			const sig = sym.signature ? ` — ${sym.signature}` : "";
			console.log(`${sym.file}::${sym.name} (${sym.kind})${sig}`);
			console.log(`  ${sym.description}`);
		}
	}

	// Dependency graph (internal)
	const depEntries = Object.entries(data.dependencies)
		.sort((a, b) => a[0].localeCompare(b[0]))
		.slice(0, 30);
	if (depEntries.length > 0) {
		console.log("\n## Module Dependencies\n");
		for (const [from, to] of depEntries) {
			console.log(`${from} -> ${to.join(", ")}`);
		}
	}
}

export function registerContextCommand(program: Command): void {
	program
		.command("context")
		.description(
			"Output dense project context aggregated from the enriched index",
		)
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option("--format <format>", "output format: plain or json", "plain")
		.option(
			"--scope <scope>",
			"scope: all or changed (uncommitted changes)",
			"all",
		)
		.option("--json", "output as JSON (shorthand for --format=json)")
		.action(
			async (options?: {
				format?: string;
				scope?: string;
				json?: boolean;
			}) => {
				const resolvedProjectPath = process.cwd();
				const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
				const dbPath = path.join(dataDir, "db.sqlite");
				const isJson = options?.json || options?.format === "json";

				initLogger(dataDir);
				config.load(dataDir);

				const metadata = new SqliteMetadataStore(dbPath);

				try {
					await metadata.initialize();
					await ensureIndexed(metadata, resolvedProjectPath, {
						silent: isJson,
					});

					const snapshot =
						await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
					if (!snapshot) {
						throw new Error(
							"No completed snapshot found.",
						);
					}

					// Determine scope
					let scopeFilePaths: Set<string> | null = null;
					if (options?.scope === "changed") {
						const git = new SimpleGitOperations();
						const changes = await git.getWorkingTreeChanges(
							resolvedProjectPath,
						);
						scopeFilePaths = new Set([
							...changes.added,
							...changes.modified,
						]);
					}

					// Fetch data in parallel
					const [files, archArtifact, fileEnrichments, symbolEnrichments] =
						await Promise.all([
							metadata.listFiles(DEFAULT_PROJECT_ID, snapshot.id),
							metadata.getArtifact(
								DEFAULT_PROJECT_ID,
								snapshot.id,
								"architecture_snapshot",
								"project",
							),
							metadata.listFileEnrichments(DEFAULT_PROJECT_ID),
							metadata.listSymbolEnrichments(DEFAULT_PROJECT_ID),
						]);

					const enrichmentByPath = new Map(
						fileEnrichments.map((e) => [e.filePath, e]),
					);
					const symbolEnrichmentMap = new Map(
						symbolEnrichments.map((e) => [`${e.filePath}::${e.symbolName}`, e]),
					);

					// Filter by scope if needed
					const filteredFiles =
						scopeFilePaths !== null
							? files.filter((f) => scopeFilePaths!.has(f.path))
							: files;

					const arch = archArtifact
						? (JSON.parse(archArtifact.dataJson) as ArchitectureSnapshot)
						: null;

					const contextData: ContextData = {
						architecture: {
							fileStats: arch?.file_stats ?? {},
							entrypoints: arch?.entrypoints ?? [],
						},
						modules: filteredFiles.map((f) => ({
							path: f.path,
							summary: enrichmentByPath.get(f.path)?.moduleSummary ?? null,
						})),
						symbols: [],
						dependencies: arch?.dependency_map?.internal ?? {},
					};

					// Gather enriched symbols for the scoped files
					const filePathSet = new Set(filteredFiles.map((f) => f.path));
					for (const [key, enrichment] of symbolEnrichmentMap) {
						const filePath = enrichment.filePath;
						if (scopeFilePaths !== null && !filePathSet.has(filePath)) continue;

						// Look up symbol kind/signature from the snapshot
						contextData.symbols.push({
							file: filePath,
							name: enrichment.symbolName,
							kind: "symbol",
							description: enrichment.description,
						});
					}

					// Enrich symbols with kind/signature from DB
					if (contextData.symbols.length > 0) {
						const allSymbols = await metadata.listSymbols(
							DEFAULT_PROJECT_ID,
							snapshot.id,
						);
						const symbolMeta = new Map(
							allSymbols.map((s) => [`${s.filePath}::${s.name}`, s]),
						);
						for (const sym of contextData.symbols) {
							const meta = symbolMeta.get(`${sym.file}::${sym.name}`);
							if (meta) {
								sym.kind = meta.kind;
								sym.signature = meta.signature;
							}
						}
					}

					if (isJson) {
						console.log(JSON.stringify(contextData, null, 2));
					} else {
						formatPlain(contextData);
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (isJson) {
						console.error(JSON.stringify({ error: message }));
					} else {
						console.error(`Context command failed: ${message}`);
					}
					process.exitCode = 1;
				} finally {
					await metadata.close().catch(() => undefined);
				}
			},
		);
}
