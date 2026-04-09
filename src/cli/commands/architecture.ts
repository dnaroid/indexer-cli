import path from "node:path";
import type { Command } from "commander";
import { config } from "../../core/config.js";
import { initLogger } from "../../core/logger.js";
import { DEFAULT_PROJECT_ID } from "../../core/types.js";
import {
	filterArchitectureSnapshot,
	type ArchitectureSnapshot,
} from "../../engine/architecture.js";
import { SqliteMetadataStore } from "../../storage/sqlite.js";
import { PROJECT_ROOT_COMMAND_HELP } from "../help-text.js";
import { ensureIndexed } from "./ensure-indexed.js";

function summarizeExternalDependencies(
	values: Record<string, string[]>,
): Record<string, number> {
	const counts = new Map<string, number>();
	for (const dependencies of Object.values(values)) {
		for (const dependency of dependencies) {
			counts.set(dependency, (counts.get(dependency) ?? 0) + 1);
		}
	}
	return Object.fromEntries(
		Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0])),
	);
}

function formatPlain(architecture: ArchitectureSnapshot): void {
	console.log("File stats by language");
	const fileEntries = Object.entries(architecture.file_stats ?? {}).sort(
		(a, b) => a[0].localeCompare(b[0]),
	);
	if (fileEntries.length === 0) {
		console.log("  none");
	} else {
		for (const [key, value] of fileEntries) {
			console.log(`  ${key}: ${value}`);
		}
	}

	console.log("Entrypoints");
	const entrypoints = architecture.entrypoints ?? [];
	if (entrypoints.length === 0) {
		console.log("  none");
	} else {
		for (const value of entrypoints) {
			console.log(`  ${value}`);
		}
	}

	console.log("Module dependency graph");
	const internalEntries = Object.entries(
		architecture.dependency_map?.internal ?? {},
	).sort((a, b) => a[0].localeCompare(b[0]));
	if (internalEntries.length === 0) {
		console.log("  none");
	} else {
		for (const [from, to] of internalEntries) {
			console.log(`  ${from} -> ${to.join(", ")}`);
		}
	}

	console.log("External dependencies summary");
	const externalSummary = summarizeExternalDependencies(
		architecture.dependency_map?.external ?? {},
	);
	const extEntries = Object.entries(externalSummary).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	if (extEntries.length === 0) {
		console.log("  none");
	} else {
		for (const [key, value] of extEntries) {
			console.log(`  ${key}: ${value}`);
		}
	}

	console.log("Unresolved dependencies");
	const unresolvedEntries = Object.entries(
		architecture.dependency_map?.unresolved ?? {},
	).sort((a, b) => a[0].localeCompare(b[0]));
	if (unresolvedEntries.length === 0) {
		console.log("  none");
	} else {
		for (const [from, to] of unresolvedEntries) {
			console.log(`  ${from} -> ${to.join(", ")}`);
		}
	}
}

export function registerArchitectureCommand(program: Command): void {
	program
		.command("architecture")
		.description("Print the latest architecture snapshot")
		.addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
		.option("--json", "output results as JSON")
		.option("--include-fixtures", "include fixture/vendor paths in output")
		.action(async (options?: { json?: boolean; includeFixtures?: boolean }) => {
			const resolvedProjectPath = process.cwd();
			const dataDir = path.join(resolvedProjectPath, ".indexer-cli");
			const dbPath = path.join(dataDir, "db.sqlite");

			initLogger(dataDir);
			config.load(dataDir);

			const metadata = new SqliteMetadataStore(dbPath);

			try {
				await metadata.initialize();
				await ensureIndexed(metadata, resolvedProjectPath, {
					silent: Boolean(options?.json),
				});
				const snapshot =
					await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
				if (!snapshot) {
					throw new Error(
						"Auto-indexing did not produce a completed snapshot.",
					);
				}

				const artifact = await metadata.getArtifact(
					DEFAULT_PROJECT_ID,
					snapshot.id,
					"architecture_snapshot",
					"project",
				);

				if (!artifact) {
					throw new Error("Architecture snapshot unavailable after indexing.");
				}

				const architecture = JSON.parse(
					artifact.dataJson,
				) as ArchitectureSnapshot;
				const visibleArchitecture = options?.includeFixtures
					? architecture
					: filterArchitectureSnapshot(
							architecture,
							config.get("excludePaths"),
						);

				if (options?.json) {
					console.log(JSON.stringify(visibleArchitecture, null, 2));
				} else {
					formatPlain(visibleArchitecture);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Architecture command failed: ${message}`);
				process.exitCode = 1;
			} finally {
				await metadata.close().catch(() => undefined);
			}
		});
}
