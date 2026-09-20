import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import type { KnowledgeImpactOptions, KnowledgeImpactResult } from "../../knowledge/impact.js";
import { isKnowledgeReviewResolved, KnowledgeReviewService, type KnowledgeReviewBinding, type KnowledgeReviewInput, type ReviewPathState } from "../../knowledge/review.js";
import { SqliteKnowledgeReviewStore, type KnowledgeReviewResolution } from "../../storage/knowledge-reviews.js";

export interface WikiReviewRuntime {
	projectId: string;
	projectRoot: string;
	dbPath: string;
	impact(options: KnowledgeImpactOptions): Promise<KnowledgeImpactResult>;
	/** Current source, relation, and evidence state for contracts named by impact. */
	contractState?(paths: string[]): Promise<Record<string, { sourceHash: string | null; relationsHash: string; evidenceHash?: string }>>;
	/** Override for non-git runtimes. It must identify the exact base used for impact. */
	baseIdentity?(base: string, paths?: string[]): Promise<string>;
}
export type WithWikiReviewRuntime = <T>(action: (runtime: WikiReviewRuntime) => Promise<T>) => Promise<T>;
const resolutions = new Set<KnowledgeReviewResolution>(["updated-contract", "new-contract", "relations-updated", "no-impact", "needs-human"]);
const execFileAsync = promisify(execFile);
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function normalizedPaths(paths: string[] | undefined): string[] | undefined {
	if (!paths?.length) return undefined;
	return [...new Set(paths.map((item) => {
		const normalized = path.posix.normalize(item.replaceAll("\\", "/"));
		if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) throw new Error(`Review path escapes project root: ${item}`);
		return normalized;
	}))].sort();
}
function scope(paths: string[] | undefined, base: string, supplied?: string) {
	return supplied ?? `review:${digest(JSON.stringify({ paths: paths ?? null, base }))}`;
}
async function baseIdentity(runtime: WikiReviewRuntime, base: string, paths: string[] | undefined): Promise<string> {
	if (runtime.baseIdentity) return runtime.baseIdentity(base, paths);
	try {
		const result = await execFileAsync("git", ["-C", runtime.projectRoot, "rev-parse", `${base}^{commit}`]);
		return result.stdout.trim();
	} catch {
		throw new Error(`Cannot identify review base ${base}; provide WikiReviewRuntime.baseIdentity for this runtime.`);
	}
}
function inside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
/** Hashes exact file bytes. Missing and unreadable/unsafe paths are intentionally distinct. */
export async function collectReviewPathStates(root: string, impact: KnowledgeImpactResult): Promise<ReviewPathState[]> {
	const realRoot = await realpath(root);
	return Promise.all(impact.changedPaths.map(async (filePath) => {
		const full = path.resolve(root, filePath);
		if (!inside(root, full)) return { path:filePath, hash:null, state:"unreadable" as const };
		try {
			const realFile = await realpath(full);
			if (!inside(realRoot, realFile) || !(await stat(realFile)).isFile()) return { path:filePath, hash:null, state:"unreadable" as const };
			return { path:filePath, hash:createHash("sha256").update(await readFile(realFile)).digest("hex"), state:"present" as const };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path:filePath, hash:null, state:"deleted" as const };
			return { path:filePath, hash:null, state:"unreadable" as const };
		}
	}));
}
/** Builds the complete, persisted review binding; wiki impact integrations may call this directly. */
export async function collectWikiReviewInput(runtime: WikiReviewRuntime, paths: string[] | undefined, options: { base?: string; scope?: string }): Promise<KnowledgeReviewInput> {
	const selectedPaths = normalizedPaths(paths);
	const base = options.base ?? "HEAD";
	const impact = await runtime.impact({ paths: selectedPaths, base });
	const contracts = [...new Set([...impact.knownAffected.map((x) => x.path), ...impact.missingTrackedSpecs, ...impact.changedDocuments.filter((x) => x.knownClassification).map((x) => x.path)])];
	const binding: KnowledgeReviewBinding = { paths: selectedPaths, base, baseIdentity: await baseIdentity(runtime, base, selectedPaths) };
	return { projectId:runtime.projectId, taskScope:scope(selectedPaths, base, options.scope), impact, pathStates:await collectReviewPathStates(runtime.projectRoot, impact), contractStates:runtime.contractState ? await runtime.contractState(contracts) : undefined, binding };
}
function print(value: unknown, json?: boolean) { if (json) console.log(JSON.stringify(value, null, 2)); else for (const o of value as Array<{ id:string; kind:string; contractPath?:string; paths:string[]; resolution?:KnowledgeReviewResolution }>) { const state = o.resolution === "needs-human" ? "OPEN/NEEDS-HUMAN" : isKnowledgeReviewResolved(o) ? "resolved" : "OPEN"; console.log(`${state} ${o.kind} ${o.contractPath ?? o.paths.join(",")} (${o.id})`); } }

/** Registration is isolated so wiki.ts can supply its existing initialized runtime without a cycle. */
export function registerWikiReviewCommands(wiki: Command, withWikiRuntime: WithWikiReviewRuntime): void {
	const review = wiki.command("review").description("Collect and resolve durable knowledge review obligations");
	review.command("collect [paths...]").option("--base <ref>", "Git base", "HEAD").option("--scope <name>", "independent task scope").option("--json").action(async (paths: string[] | undefined, options: {base?:string;scope?:string;json?:boolean}) => {
		try { await withWikiRuntime(async runtime => { const store = new SqliteKnowledgeReviewStore(runtime.dbPath); try { const obligations = await new KnowledgeReviewService(store).collect(await collectWikiReviewInput(runtime, paths, options)); print(obligations, options.json); } finally { await store.close(); } }); } catch (e) { console.error(`Wiki review failed: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
	});
	review.command("list").option("--scope <name>").option("--json").action(async (options: {scope?:string;json?:boolean}) => {
		try { await withWikiRuntime(async runtime => { const store = new SqliteKnowledgeReviewStore(runtime.dbPath); try { print(await new KnowledgeReviewService(store).list(runtime.projectId, options.scope), options.json); } finally { await store.close(); } }); } catch (e) { console.error(`Wiki review failed: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
	});
	review.command("resolve <id>").requiredOption("--resolution <resolution>").requiredOption("--reviewer <name>").requiredOption("--rationale <text>").requiredOption("--evidence <text>").option("--json").action(async (id: string, options: {resolution:string;reviewer:string;rationale:string;evidence:string;json?:boolean}) => {
		try { if (!resolutions.has(options.resolution as KnowledgeReviewResolution)) throw new Error(`--resolution must be one of: ${[...resolutions].join(", ")}`); await withWikiRuntime(async runtime => { const store = new SqliteKnowledgeReviewStore(runtime.dbPath); try { const service = new KnowledgeReviewService(store); const saved = await service.get(id); if (!saved || !saved.relevant) throw new Error(`Relevant review obligation not found: ${id}`); const binding = (saved.evidence as { binding?: KnowledgeReviewBinding }).binding; if (!binding) throw new Error(`Review obligation has no persisted input binding: ${id}`); await service.collect(await collectWikiReviewInput(runtime, binding.paths, { base:binding.base, scope:saved.taskScope })); const current = await service.get(id); if (!current?.relevant || current.fingerprint !== saved.fingerprint) throw new Error(`Review obligation is stale: ${id}. Recollect and review the current change set.`); const obligation = await service.resolve(id, current.fingerprint, options as {resolution:KnowledgeReviewResolution;reviewer:string;rationale:string;evidence:string}); print([obligation], options.json); } finally { await store.close(); } }); } catch (e) { console.error(`Wiki review failed: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
	});
	wiki.command("check [paths...]").description("CI gate: reconcile current change state and fail unresolved review obligations").option("--base <ref>", "Git base", "HEAD").option("--scope <name>").option("--json").action(async (paths: string[] | undefined, options: {base?:string;scope?:string;json?:boolean}) => {
		try { await withWikiRuntime(async runtime => { const store = new SqliteKnowledgeReviewStore(runtime.dbPath); try { const result = await new KnowledgeReviewService(store).check(await collectWikiReviewInput(runtime, paths, options)); if (options.json) console.log(JSON.stringify(result, null, 2)); else { print(result.obligations, false); console.log(result.ok ? "knowledge review check passed" : `${result.unresolved.length} unresolved knowledge review obligation(s)`); } if (!result.ok) process.exitCode = 1; } finally { await store.close(); } }); } catch (e) { console.error(`Wiki check failed: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
	});
}
