import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { DEFAULT_PROJECT_ID, type KnowledgeStore } from "../../core/types.js";
import {
	applyKnowledgeManifest,
	exportKnowledgeManifest,
	loadKnowledgeManifest,
} from "../../knowledge/manifest.js";

/** The host owns opening/indexing the wiki runtime.  Keeping this callback
 * injected makes this optional command usable without changing wiki.ts. */
export type WithWikiManifestRuntime = <T>(action: (runtime: {
	projectRoot: string;
	metadata: KnowledgeStore;
	projectId?: string;
}) => Promise<T>) => Promise<T>;

function fail(error: unknown): void {
	console.error(`Wiki manifest failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}

function isWithin(root: string, target: string): boolean {
	return target === root || target.startsWith(`${root}${path.sep}`);
}

export async function writeManifestExport(projectRoot: string, file: string, content: string): Promise<string> {
	const lexicalRoot = path.resolve(projectRoot);
	const destination = path.resolve(lexicalRoot, file);
	if (!isWithin(lexicalRoot, destination) || destination === lexicalRoot) {
		throw new Error("Export path escapes project root");
	}

	const [resolvedRoot, resolvedParent] = await Promise.all([
		realpath(lexicalRoot),
		realpath(path.dirname(destination)),
	]);
	if (!isWithin(resolvedRoot, resolvedParent)) {
		throw new Error("Export path parent escapes project root");
	}
	try {
		if ((await lstat(destination)).isSymbolicLink()) {
			throw new Error("Export destination must not be a symlink");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const handle = await open(
		destination,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
	);
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close();
	}
	return destination;
}

export function registerWikiManifestCommand(wiki: Command, withWikiRuntime: WithWikiManifestRuntime): void {
	const manifest = wiki.command("manifest").description("Validate, export, or explicitly apply portable knowledge declarations");
	manifest.command("validate").requiredOption("--file <path>").option("--json").action(async (options: { file: string; json?: boolean }) => {
		try { await withWikiRuntime(async ({ projectRoot }) => { const result = await loadKnowledgeManifest(projectRoot, options.file); if (options.json) console.log(JSON.stringify(result, null, 2)); else for (const d of result.diagnostics) console.log(`${d.severity}: ${d.path}: ${d.message}`); if (result.valid) console.log("manifest valid"); else process.exitCode = 1; }); } catch (error) { fail(error); }
	});
	manifest.command("export").requiredOption("--file <path>").action(async (options: { file: string }) => {
		try { await withWikiRuntime(async ({ projectRoot, metadata, projectId }) => { const output = await exportKnowledgeManifest(projectId ?? DEFAULT_PROJECT_ID, metadata); const destination = await writeManifestExport(projectRoot, options.file, `${JSON.stringify(output, null, 2)}\n`); console.log(`exported manifest: ${path.relative(projectRoot, destination)}`); }); } catch (error) { fail(error); }
	});
	manifest.command("apply").requiredOption("--file <path>").option("--json").action(async (options: { file: string; json?: boolean }) => {
		try { await withWikiRuntime(async ({ projectRoot, metadata, projectId }) => { const parsed = await loadKnowledgeManifest(projectRoot, options.file); if (!parsed.valid || !parsed.manifest) { for (const d of parsed.diagnostics) console.error(`${d.severity}: ${d.path}: ${d.message}`); process.exitCode = 1; return; } const result = await applyKnowledgeManifest(projectRoot, projectId ?? DEFAULT_PROJECT_ID, metadata, parsed.manifest); if (options.json) console.log(JSON.stringify(result, null, 2)); else console.log(`applied ${result.recorded} knowledge declarations; added ${result.relationsAdded} relations`); }); } catch (error) { fail(error); }
	});
}
