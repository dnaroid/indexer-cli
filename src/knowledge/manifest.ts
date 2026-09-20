/** Portable, declarative knowledge metadata. Declarations, never prose, are authoritative. */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
	KnowledgeBehaviorType, KnowledgeClassification, KnowledgeEntry, KnowledgeLifecycle,
	KnowledgeRelation, KnowledgeRelationKind, KnowledgeStore, ProjectId,
} from "../core/types.js";

export const KNOWLEDGE_MANIFEST_VERSION = 1;
const classifications = new Set<KnowledgeClassification>(["spec", "spec-like", "meta-index", "design-only", "guide", "other"]);
const behaviorTypes = new Set<KnowledgeBehaviorType>(["as-is", "change", "mixed", "unknown"]);
const lifecycles = new Set<KnowledgeLifecycle>(["active", "proposed", "historical", "superseded", "unknown"]);
const relationKinds = ["implements", "tests", "related", "supersedes", "superseded-by"] as const;
const selectorKinds = new Set(["code-symbol", "json-pointer", "document-section"]);

export interface ManifestEvidence { selector?: { kind: "code-symbol" | "json-pointer" | "document-section"; value: string } }
type ManifestSelector = NonNullable<ManifestEvidence["selector"]>;
export interface ManifestRelation { id: string; target: string; evidence?: ManifestEvidence }
export interface KnowledgeManifestEntry {
	id: string; source: string; classification: KnowledgeClassification; behaviorType: KnowledgeBehaviorType;
	lifecycle: KnowledgeLifecycle; owner?: string; summary: string; topics?: string[];
	implements?: ManifestRelation[]; tests?: ManifestRelation[]; related?: ManifestRelation[];
	supersedes?: ManifestRelation[]; "superseded-by"?: ManifestRelation[];
}
export interface KnowledgeManifest { version: 1; knowledge: KnowledgeManifestEntry[] }
export interface ManifestDiagnostic { severity: "error" | "warning"; path: string; message: string }
export interface ManifestValidation { manifest?: KnowledgeManifest; diagnostics: ManifestDiagnostic[]; valid: boolean }

export interface NormalizedKnowledgeDeclaration {
	sourcePath: string; manifestId: string;
	relations: Array<{ assertionId: string; targetPath: string; targetKind: "code" | "knowledge"; relationKind: KnowledgeRelationKind; evidence?: ManifestEvidence }>;
}

/** Metadata persisted on entries. KnowledgeService.record can use this marker to
 * skip prose relation extraction and obtain declarations via declarationForSource(). */
export interface ManifestEntryMetadata { manifest: { id: string; authoritative: true; owner?: string } }
export function isManifestAuthoritativeEntry(entry: Pick<KnowledgeEntry, "metadata">): boolean {
	const manifest = entry.metadata?.manifest;
	return !!manifest && typeof manifest === "object" && (manifest as Record<string, unknown>).authoritative === true;
}
export function declarationForSource(declarations: readonly NormalizedKnowledgeDeclaration[], sourcePath: string): NormalizedKnowledgeDeclaration | undefined {
	return declarations.find((declaration) => declaration.sourcePath === sourcePath);
}

/** A fully prepared manifest write. Implementations must apply the complete
 * array in one durable transaction, including entry verification clearing. */
export interface ManifestApplyOperation {
	sourcePath: string;
	manifestId: string;
	classification: KnowledgeClassification;
	behaviorType: KnowledgeBehaviorType;
	lifecycle: KnowledgeLifecycle;
	owner?: string;
	summary: string;
	topics: string[];
	indexedSourceHash: string;
	title: string;
	relations: KnowledgeRelation[];
}

/** Optional storage capability required by apply. It replaces only relations
 * owned by each manifest ID and leaves inferred/other explicit rows intact. */
export interface ManifestAtomicApplyStore {
	applyKnowledgeManifestAtomically?(projectId: ProjectId, operations: ManifestApplyOperation[]): Promise<{ staleDeclarations: string[] }>;
}

function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function stableId(value: unknown): value is string { return nonEmpty(value) && /^[a-z][a-z0-9._-]{0,127}$/i.test(value); }
function addIssue(diagnostics: ManifestDiagnostic[], at: string, message: string): void { diagnostics.push({ severity: "error", path: at, message }); }
function normalizedPath(value: string): string | undefined {
	if (!value || path.isAbsolute(value) || value.split(/[\\/]+/).includes("..")) return undefined;
	const result = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\.\//, "");
	return result && result !== "." ? result : undefined;
}

function parseRelation(value: unknown, at: string, diagnostics: ManifestDiagnostic[]): ManifestRelation | undefined {
	if (!isObject(value)) { addIssue(diagnostics, at, "must be an object"); return; }
	for (const key of Object.keys(value)) if (key !== "id" && key !== "target" && key !== "evidence") addIssue(diagnostics, `${at}.${key}`, "unknown field");
	if (!stableId(value.id) || !nonEmpty(value.target)) { addIssue(diagnostics, at, "must have a stable id and non-empty target"); return; }
	let evidence: ManifestEvidence | undefined;
	if (value.evidence !== undefined) {
		if (!isObject(value.evidence)) addIssue(diagnostics, `${at}.evidence`, "must be an object");
		else {
			for (const key of Object.keys(value.evidence)) if (key !== "selector") addIssue(diagnostics, `${at}.evidence.${key}`, "unknown field");
			const selector = value.evidence.selector;
			if (isObject(selector)) for (const key of Object.keys(selector)) if (key !== "kind" && key !== "value") addIssue(diagnostics, `${at}.evidence.selector.${key}`, "unknown field");
			if (!isObject(selector) || !selectorKinds.has(selector.kind as string) || !nonEmpty(selector.value)) addIssue(diagnostics, `${at}.evidence.selector`, "must have selector kind and non-empty value");
			else evidence = { selector: { kind: selector.kind as ManifestSelector["kind"], value: selector.value } };
		}
	}
	return { id: value.id, target: value.target, ...(evidence ? { evidence } : {}) };
}

/** Parses a small strict JSON contract. Paths are canonicalized before duplicate checks. */
export function parseKnowledgeManifest(value: unknown): ManifestValidation {
	const diagnostics: ManifestDiagnostic[] = [];
	if (!isObject(value)) { addIssue(diagnostics, "$", "must be an object"); return { diagnostics, valid: false }; }
	for (const key of Object.keys(value)) if (key !== "version" && key !== "knowledge") addIssue(diagnostics, `$.${key}`, "unknown field");
	if (value.version !== 1) addIssue(diagnostics, "$.version", "must be 1");
	if (!Array.isArray(value.knowledge)) addIssue(diagnostics, "$.knowledge", "must be an array");
	const entries: KnowledgeManifestEntry[] = [];
	for (const [index, raw] of (Array.isArray(value.knowledge) ? value.knowledge : []).entries()) {
		const at = `$.knowledge[${index}]`;
		if (!isObject(raw)) { addIssue(diagnostics, at, "must be an object"); continue; }
		const allowed = new Set(["id", "source", "classification", "behaviorType", "lifecycle", "owner", "summary", "topics", ...relationKinds]);
		for (const key of Object.keys(raw)) if (!allowed.has(key)) addIssue(diagnostics, `${at}.${key}`, "unknown field");
		const source = nonEmpty(raw.source) ? normalizedPath(raw.source) : undefined;
		if (!stableId(raw.id)) addIssue(diagnostics, `${at}.id`, "must be a stable identifier");
		if (!source) addIssue(diagnostics, `${at}.source`, "must be a repository-relative path without traversal");
		if (!classifications.has(raw.classification as KnowledgeClassification)) addIssue(diagnostics, `${at}.classification`, "invalid classification");
		if (!behaviorTypes.has(raw.behaviorType as KnowledgeBehaviorType)) addIssue(diagnostics, `${at}.behaviorType`, "invalid behaviorType");
		if (!lifecycles.has(raw.lifecycle as KnowledgeLifecycle)) addIssue(diagnostics, `${at}.lifecycle`, "invalid lifecycle");
		if (!nonEmpty(raw.summary)) addIssue(diagnostics, `${at}.summary`, "must be non-empty");
		if (raw.owner !== undefined && !nonEmpty(raw.owner)) addIssue(diagnostics, `${at}.owner`, "must be non-empty");
		if (raw.topics !== undefined && (!Array.isArray(raw.topics) || !raw.topics.every(nonEmpty))) addIssue(diagnostics, `${at}.topics`, "must be an array of non-empty strings");
		const entry = { id: String(raw.id), source: source ?? String(raw.source), classification: raw.classification as KnowledgeClassification, behaviorType: raw.behaviorType as KnowledgeBehaviorType, lifecycle: raw.lifecycle as KnowledgeLifecycle, summary: String(raw.summary), ...(nonEmpty(raw.owner) ? { owner: raw.owner } : {}), ...(Array.isArray(raw.topics) ? { topics: raw.topics.filter(nonEmpty) } : {}) } as KnowledgeManifestEntry;
		for (const kind of relationKinds) {
			if (raw[kind] === undefined) continue;
			if (!Array.isArray(raw[kind])) { addIssue(diagnostics, `${at}.${kind}`, "must be an array"); continue; }
			const parsed = raw[kind].map((relation, relationIndex) => parseRelation(relation, `${at}.${kind}[${relationIndex}]`, diagnostics)).filter((relation): relation is ManifestRelation => !!relation);
			(entry as unknown as Record<string, unknown>)[kind] = parsed;
			if (kind === "implements" || kind === "tests") for (const relation of parsed) { const target = normalizedPath(relation.target); if (!target) addIssue(diagnostics, relation.id, "code target must be a repository-relative path without traversal"); else relation.target = target; }
		}
		entries.push(entry);
	}
	const ids = new Set<string>(), sources = new Set<string>(), assertionIds = new Set<string>();
	for (const entry of entries) {
		if (ids.has(entry.id)) addIssue(diagnostics, entry.id, "duplicate knowledge id"); ids.add(entry.id);
		if (sources.has(entry.source)) addIssue(diagnostics, entry.source, "duplicate source path or alias"); sources.add(entry.source);
		const identities = new Set<string>();
		for (const kind of relationKinds) for (const relation of entry[kind] ?? []) {
			if (assertionIds.has(relation.id)) addIssue(diagnostics, relation.id, "duplicate assertion id"); assertionIds.add(relation.id);
			const identity = `${kind}\0${relation.target}`;
			if (identities.has(identity)) addIssue(diagnostics, relation.id, "duplicate relation identity"); identities.add(identity);
		}
	}
	for (const entry of entries) for (const kind of ["related", "supersedes", "superseded-by"] as const) for (const relation of entry[kind] ?? []) if (!ids.has(relation.target)) addIssue(diagnostics, relation.id, `missing knowledge target: ${relation.target}`);
	const edges = new Map(entries.map((entry) => [entry.id, [...(entry.supersedes ?? []).map((relation) => relation.target), ...(entry["superseded-by"] ?? []).map((relation) => relation.target)]]));
	const visiting = new Set<string>(), visited = new Set<string>();
	const walk = (node: string): void => { if (visiting.has(node)) { addIssue(diagnostics, node, "supersession cycle"); return; } if (visited.has(node)) return; visiting.add(node); for (const next of edges.get(node) ?? []) walk(next); visiting.delete(node); visited.add(node); };
	for (const entry of entries) walk(entry.id);
	for (const entry of entries) if (entry.lifecycle === "superseded" && !entries.some((other) => (other.supersedes ?? []).some((relation) => relation.target === entry.id) || (entry["superseded-by"] ?? []).some((relation) => relation.target === entry.id))) diagnostics.push({ severity: "warning", path: entry.id, message: "superseded lifecycle has no superseding declaration" });
	return { manifest: diagnostics.some((diagnostic) => diagnostic.severity === "error") ? undefined : { version: 1, knowledge: entries }, diagnostics, valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error") };
}

async function safeFile(root: string, value: string): Promise<string> {
	const normalized = normalizedPath(value); if (!normalized) throw new Error(`Path escapes project root: ${value}`);
	const rootReal = await realpath(root), candidate = path.resolve(rootReal, normalized), resolved = await realpath(candidate), relative = path.relative(rootReal, resolved);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !(await stat(resolved)).isFile()) throw new Error(`Path is not a project file: ${value}`);
	if (candidate !== resolved) throw new Error(`Symlink paths are not allowed: ${value}`);
	return relative.replace(/\\/g, "/");
}

export async function loadKnowledgeManifest(repoRoot: string, manifestPath: string): Promise<ManifestValidation> {
	try { const full = await safeFile(repoRoot, manifestPath); const parsed = parseKnowledgeManifest(JSON.parse(await readFile(path.join(await realpath(repoRoot), full), "utf8"))); if (parsed.manifest) await normalizeManifestDeclarations(repoRoot, parsed.manifest); return parsed; }
	catch (error) { return { valid: false, diagnostics: [{ severity: "error", path: manifestPath, message: error instanceof Error ? error.message : String(error) }] }; }
}

export async function normalizeManifestDeclarations(repoRoot: string, manifest: KnowledgeManifest): Promise<NormalizedKnowledgeDeclaration[]> {
	const sourceById = new Map<string, string>();
	for (const entry of manifest.knowledge) sourceById.set(entry.id, await safeFile(repoRoot, entry.source));
	const declarations = await Promise.all(manifest.knowledge.map(async (entry) => ({ sourcePath: sourceById.get(entry.id)!, manifestId: entry.id, relations: await Promise.all(relationKinds.flatMap((kind) => (entry[kind] ?? []).map(async (relation) => ({ assertionId: relation.id, targetPath: kind === "implements" || kind === "tests" ? await safeFile(repoRoot, relation.target) : sourceById.get(relation.target)!, targetKind: kind === "implements" || kind === "tests" ? "code" as const : "knowledge" as const, relationKind: kind, ...(relation.evidence ? { evidence: relation.evidence } : {}) })))) })));
	return declarations.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function relationRow(projectId: ProjectId, declaration: NormalizedKnowledgeDeclaration, relation: NormalizedKnowledgeDeclaration["relations"][number]): KnowledgeRelation {
	return { projectId, sourcePath: declaration.sourcePath, targetPath: relation.targetPath, targetKind: relation.targetKind, relationKind: relation.relationKind, provenance: "explicit", metadata: { manifest: { id: declaration.manifestId, assertionId: relation.assertionId, ...(relation.evidence ? { evidence: relation.evidence } : {}) } } };
}
function ownedBy(relation: KnowledgeRelation, manifestId: string): boolean { const manifest = relation.metadata?.manifest; return !!manifest && typeof manifest === "object" && (manifest as Record<string, unknown>).id === manifestId; }

export async function applyKnowledgeManifest(repoRoot: string, projectId: ProjectId, store: KnowledgeStore, manifest: KnowledgeManifest): Promise<{ recorded: number; relationsAdded: number; staleDeclarations: string[] }> {
	const apply = (store as ManifestAtomicApplyStore).applyKnowledgeManifestAtomically;
	if (!apply) throw new Error("Store must implement applyKnowledgeManifestAtomically; manifest apply requires whole-manifest atomicity");
	const declarations = await normalizeManifestDeclarations(repoRoot, manifest);
	const entries = new Map(manifest.knowledge.map((entry) => [entry.id, entry]));
	const root = await realpath(repoRoot);
	const operations = await Promise.all(declarations.map(async (declaration) => {
		const item = entries.get(declaration.manifestId)!;
		const content = await readFile(path.join(root, declaration.sourcePath));
		return { sourcePath: declaration.sourcePath, manifestId: declaration.manifestId, classification: item.classification,
			behaviorType: item.behaviorType, lifecycle: item.lifecycle, ...(item.owner ? { owner: item.owner } : {}),
			summary: item.summary, topics: [...new Set(item.topics ?? [])].sort(), title: path.basename(item.source),
			indexedSourceHash: createHash("sha256").update(content).digest("hex"), relations: declaration.relations.map((relation) => relationRow(projectId, declaration, relation)) };
	}));
	const result = await apply.call(store, projectId, operations);
	return { recorded: operations.length, relationsAdded: operations.reduce((sum, operation) => sum + operation.relations.length, 0), staleDeclarations: result.staleDeclarations.sort() };
}

function generatedId(source: string): string { return `generated-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`; }
export async function exportKnowledgeManifest(projectId: ProjectId, store: KnowledgeStore): Promise<KnowledgeManifest> {
	const entries = await store.listKnowledgeEntries(projectId);
	const idByPath = new Map(entries.map((entry) => {
		const declaration = entry.metadata?.manifest as Record<string, unknown> | undefined;
		return [entry.path, typeof declaration?.id === "string" ? declaration.id : generatedId(entry.path)];
	}));
	const relations = await store.listKnowledgeRelations(projectId);
	return { version: 1, knowledge: entries.sort((left, right) => left.path.localeCompare(right.path)).map((entry) => {
		const metadata = (entry.metadata?.manifest ?? {}) as Record<string, unknown>;
		const result: KnowledgeManifestEntry = { id: idByPath.get(entry.path) ?? generatedId(entry.path), source: entry.path, classification: entry.classification, behaviorType: entry.behaviorType, lifecycle: entry.lifecycle, summary: entry.summary || entry.path, ...(entry.topics.length ? { topics: [...entry.topics].sort() } : {}), ...(typeof metadata.owner === "string" ? { owner: metadata.owner } : {}) };
		for (const relation of relations.filter((candidate) => candidate.sourcePath === entry.path &&
			(isManifestAuthoritativeEntry(entry) ? ownedBy(candidate, result.id) : candidate.provenance === "explicit"))
			.sort((left, right) => `${left.relationKind}:${left.targetPath}`.localeCompare(`${right.relationKind}:${right.targetPath}`))) {
			const target = relation.targetKind === "knowledge" ? idByPath.get(relation.targetPath) : relation.targetPath; if (!target) continue;
			const manifestMetadata = (relation.metadata?.manifest ?? {}) as Record<string, unknown>;
			const list = (result[relation.relationKind as keyof KnowledgeManifestEntry] ?? []) as ManifestRelation[];
			const assertionId = typeof manifestMetadata.assertionId === "string" ? manifestMetadata.assertionId : generatedId(`${entry.path}:${relation.relationKind}:${relation.targetPath}`);
			list.push({ id: assertionId, target, ...(typeof manifestMetadata.evidence === "object" ? { evidence: manifestMetadata.evidence as ManifestEvidence } : {}) });
			(result as unknown as Record<string, unknown>)[relation.relationKind] = list;
		}
		return result;
	}) };
}
