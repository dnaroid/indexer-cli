import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { scanProjectDocuments } from "./document-scanner.js";
import { getDocumentMetadata } from "./document-metadata.js";
import type { DocumentMetadata, DocumentReference } from "./document-metadata-types.js";
import { config } from "../core/config.js";

export interface AuditMatch {
	path: string;
	group: "explicit-active-spec" | "explicit-other" | "possible";
	classification: Pick<DocumentMetadata, "kind" | "status" | "kindSource" | "statusSource">;
	reasons: Array<{ changedPath: string; role: DocumentReference["role"]; symbol?: string; basis: "explicit-declaration" | "ordinary-mention" | "dependency" | "hybrid-retrieval" }>;
}
export interface AuditReport {
	changedPaths: string[];
	matches: AuditMatch[];
	unresolvedPaths: Array<{ document: string; path: string; symbol?: string; reason?: string }>;
	uncoveredPaths: string[];
	warnings: string[];
}
export interface AuditOptions {
	noSemantic?: boolean;
	search?: (query: string) => Promise<string[]>;
	dependencies?: Array<{ fromPath: string; toPath?: string }>;
	symbols?: Array<{ filePath: string; name: string }>;
}

function inside(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** Audits only the supplied task paths. Retrieval is advisory; declarations are source-based. */
export async function auditTask(rootPath: string, changed: string[], options: AuditOptions = {}): Promise<AuditReport> {
	if (!changed.length) throw new Error("audit requires at least one changed path");
	const root = await realpath(rootPath);
	const normalizedChanged: string[] = [];
	for (const input of changed) {
		if (!input.trim() || /[\x00-\x1f\x7f]/.test(input) || /^(?:[\\/]|[A-Za-z]:|~)/.test(input)) throw new Error("Changed paths must be project-relative file paths");
		const absolute = path.resolve(root, input);
		if (!inside(root, absolute) || absolute === root) throw new Error(`Changed path escapes project root: ${input}`);
		// Resolve the deepest existing ancestor to detect symlinked parents even for deleted paths.
		const parts = path.relative(root, absolute).split(path.sep);
		for (let i = parts.length; i > 0; i--) {
			try {
				const ancestor = await realpath(path.join(root, ...parts.slice(0, i)));
				if (!inside(root, ancestor)) throw new Error(`Changed path escapes project root: ${input}`);
				break;
			} catch (error) { if (error instanceof Error && error.message.includes("escapes project root")) throw error; }
		}
		normalizedChanged.push(path.relative(root, absolute).split(path.sep).join("/"));
	}
	const changedPaths = [...new Set(normalizedChanged)].sort();
	const warnings: string[] = [];
	const documents = await scanProjectDocuments(root, { onWarning: (w) => warnings.push(`${w.path}: ${w.message}`) });
	const rows: Array<{ path: string; metadata: DocumentMetadata }> = [];
	for (const doc of documents) {
		const abs = path.resolve(root, doc);
		try { if (!inside(root, await realpath(abs))) { warnings.push(`${doc}: resolved outside project root; skipped`); continue; } }
		catch { continue; }
		try {
			if ((await stat(abs)).size > config.get("documentMaxBytes")) { warnings.push(`${doc}: exceeds document size limit; not inspected`); continue; }
			const content = await readFile(abs, "utf8");
			const metadata = await getDocumentMetadata(root, doc, content);
			rows.push({ path: doc, metadata });
			warnings.push(...metadata.warnings.map(warning => `${doc}: ${warning}`));
		} catch { warnings.push(`${doc}: unable to read document`); }
	}
	const matches = new Map<string, AuditMatch>();
	const unresolvedPaths: AuditReport["unresolvedPaths"] = [];
	for (const { path: doc, metadata } of rows) {
		for (const ref of metadata.references) {
			const target = path.posix.normalize(ref.path.replace(/\\/g, "/").replace(/^\.\//, ""));
			if (target === ".." || target.startsWith("../") || /^(?:\/|[A-Za-z]:)/.test(target)) { unresolvedPaths.push({ document: doc, path: ref.path, symbol: ref.symbol, reason: "outside project" }); continue; }
			const validPath = await existsInside(root, target);
			if (ref.role !== "mention") {
				if (!validPath) unresolvedPaths.push({ document: doc, path: ref.path, symbol: ref.symbol, reason: "missing or outside project" });
				else if (ref.symbol && options.symbols && !options.symbols.some(symbol => symbol.filePath === target && symbol.name === ref.symbol)) unresolvedPaths.push({ document: doc, path: ref.path, symbol: ref.symbol, reason: "symbol not indexed" });
				else if (ref.symbol && !options.symbols) warnings.push(`${doc}: symbol resolution unavailable for ${target}::${ref.symbol}`);
			}
			const relatedChanges = changedPaths.filter(changedPath => (options.dependencies ?? []).some(dependency =>
				(dependency.fromPath === changedPath && dependency.toPath === target) || (dependency.toPath === changedPath && dependency.fromPath === target)));
			if (!changedPaths.includes(target) && !relatedChanges.length) continue;
			const basis = ref.role === "mention" ? "ordinary-mention" : "explicit-declaration";
			const explicitlyClassified = metadata.kindSource === "explicit" && metadata.statusSource === "explicit";
			const direct = changedPaths.includes(target);
			const group = direct && ref.role !== "mention" && explicitlyClassified && metadata.kind === "spec" && metadata.status === "active" ? "explicit-active-spec" : direct && ref.role !== "mention" && explicitlyClassified ? "explicit-other" : "possible";
			const row = matches.get(doc) ?? { path: doc, group, classification: { kind: metadata.kind, status: metadata.status, kindSource: metadata.kindSource, statusSource: metadata.statusSource }, reasons: [] };
			if (group === "explicit-active-spec" || (group === "explicit-other" && row.group === "possible")) row.group = group;
			if (direct) row.reasons.push({ changedPath: target, role: ref.role, symbol: ref.symbol, basis });
			for (const changedPath of relatedChanges) row.reasons.push({ changedPath, role: ref.role, symbol: ref.symbol, basis: "dependency" });
			matches.set(doc, row);
		}
	}
	if (!options.noSemantic && options.search) {
		for (const target of changedPaths) {
			let found: string[];
			try { found = await options.search(target); } catch { warnings.push(`semantic retrieval failed for ${target}`); continue; }
			for (const doc of found) {
			const item = rows.find((r) => r.path === doc); if (!item) continue;
			const row = matches.get(doc) ?? { path: doc, group: "possible" as const, classification: { kind: item.metadata.kind, status: item.metadata.status, kindSource: item.metadata.kindSource, statusSource: item.metadata.statusSource }, reasons: [] };
			if (!row.reasons.some((r) => r.changedPath === target && r.basis === "hybrid-retrieval")) row.reasons.push({ changedPath: target, role: "mention", basis: "hybrid-retrieval" });
			matches.set(doc, row);
			}
		}
	} else if (!options.noSemantic) warnings.push("semantic retrieval unavailable; audit used declarations and mentions only");
	const covered = new Set([...matches.values()].flatMap((m) => m.reasons.map((r) => r.changedPath)));
	return { changedPaths, matches: [...matches.values()].sort((a,b) => a.path.localeCompare(b.path)), unresolvedPaths, uncoveredPaths: changedPaths.filter((p) => !covered.has(p)), warnings };
}
async function existsInside(root: string, relativePath: string): Promise<boolean> {
	try { return inside(root, await realpath(path.resolve(root, relativePath))); } catch { return false; }
}
