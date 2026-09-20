import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyKnowledgeManifest, declarationForSource, exportKnowledgeManifest, isManifestAuthoritativeEntry, normalizeManifestDeclarations, parseKnowledgeManifest } from "../../../src/knowledge/manifest.js";
import { writeManifestExport } from "../../../src/cli/commands/wiki-manifest.js";
import type { KnowledgeEntry, KnowledgeRelation, KnowledgeStore } from "../../../src/core/types.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { KnowledgeService } from "../../../src/knowledge/service.js";

describe("knowledge manifest", () => {
	const dirs: string[] = [];
	afterEach(async () => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
	function temp(): string { const dir = mkdtempSync(path.join(os.tmpdir(), "idx-manifest-")); dirs.push(dir); return dir; }
	const example = { version: 1 as const, knowledge: [{ id: "login", source: "docs/login.md", classification: "spec" as const, behaviorType: "as-is" as const, lifecycle: "active" as const, summary: "Login behaviour", topics: ["auth"], implements: [{ id: "login-implementation", target: "src/login.ts" }], tests: [{ id: "login-test", target: "tests/login.test.ts" }] }] };

	it("round trips metadata and declared relations without verification", async () => {
		const root = temp(); await mkdir(path.join(root, "docs")); await mkdir(path.join(root, "src")); await mkdir(path.join(root, "tests"));
		await Promise.all([writeFile(path.join(root, "docs/login.md"), "mentions `src/other.ts` but is not authoritative"), writeFile(path.join(root, "src/login.ts"), "export {}"), writeFile(path.join(root, "src/other.ts"), "export {}"), writeFile(path.join(root, "tests/login.test.ts"), "")]);
		const parsed = parseKnowledgeManifest(example); expect(parsed.valid).toBe(true);
		const store = new SqliteMetadataStore(path.join(root, "fresh.sqlite")); await store.initialize();
		await applyKnowledgeManifest(root, "p", store, parsed.manifest!);
		const entry = await store.getKnowledgeEntry("p", "docs/login.md"); expect(entry?.summary).toBe("Login behaviour"); expect(entry?.verifiedAt).toBeUndefined();
		const relations = await store.listKnowledgeRelations("p", { sourcePath: "docs/login.md" }); expect(relations.map((r) => `${r.relationKind}:${r.targetPath}`)).toEqual(["implements:src/login.ts", "tests:tests/login.test.ts"]);
		const exported = await exportKnowledgeManifest("p", store); expect(exported).toEqual(example); await store.close();
	});

	it("keeps exact-byte drift visible for unattested manifest entries", async () => {
		const root = temp(); await mkdir(path.join(root, "docs"));
		await writeFile(path.join(root, "docs/login.md"), "# Login");
		const store = new SqliteMetadataStore(path.join(root, "db.sqlite")); await store.initialize();
		try {
			await applyKnowledgeManifest(root, "p", store, { ...example, knowledge: [{ ...example.knowledge[0], implements: [], tests: [] }] });
			const entry = (await store.getKnowledgeEntry("p", "docs/login.md"))!;
			expect(entry.metadata?.indexedSourceHashFormat).toBe("sha256-exact-v1");
			await writeFile(path.join(root, "docs/login.md"), "# Login\n");
			const service = new KnowledgeService("p", root, store, store);
			expect((await service.getStatus(entry)).status).toBe("spec-changed");
			expect((await service.discover()).some((candidate) => candidate.path === entry.path)).toBe(true);
		} finally { await store.close(); }
	});

	it("exports existing recorded metadata for a fresh clone without promoting inferred evidence", async () => {
		const root = temp(); await mkdir(path.join(root, "docs")); await mkdir(path.join(root, "src"));
		await writeFile(path.join(root, "docs/login.md"), "# Login\n`src/login.ts`\n");
		await writeFile(path.join(root, "src/login.ts"), "export {};");
		const source = new SqliteMetadataStore(path.join(root, "source.sqlite"));
		const clone = new SqliteMetadataStore(path.join(root, "clone.sqlite"));
		await source.initialize(); await clone.initialize();
		try {
			await new KnowledgeService("p", root, source, source).record({ path: "docs/login.md", classification: "spec", behaviorType: "as-is", lifecycle: "active", summary: "Login behaviour" });
			await source.upsertKnowledgeRelation({ projectId: "p", sourcePath: "docs/login.md", targetPath: "src/guess.ts", targetKind: "code", relationKind: "implements", provenance: "inferred" });
			const exported = await exportKnowledgeManifest("p", source);
			expect(exported.knowledge).toHaveLength(1);
			expect(exported.knowledge[0].implements?.map((edge) => edge.target)).toEqual(["src/login.ts"]);
			expect(await exportKnowledgeManifest("p", source)).toEqual(exported);
			expect(parseKnowledgeManifest(exported).valid).toBe(true);
			await applyKnowledgeManifest(root, "p", clone, exported);
			expect((await clone.getKnowledgeEntry("p", "docs/login.md"))?.verifiedAt).toBeUndefined();
		} finally { await source.close(); await clone.close(); }
	});

	it("diagnoses duplicate targets, cycles, traversal, and symlinks", async () => {
		const invalid = parseKnowledgeManifest({ ...example, knowledge: [...example.knowledge, { ...example.knowledge[0], source: "docs/login.md", supersedes: [{ id: "cycle", target: "login" }] }] });
		expect(invalid.valid).toBe(false); expect(invalid.diagnostics.some((d) => /duplicate|cycle/.test(d.message))).toBe(true);
		const root = temp(); await mkdir(path.join(root, "docs")); await mkdir(path.join(root, "src")); await writeFile(path.join(root, "docs/login.md"), ""); await writeFile(path.join(root, "src/login.ts"), ""); await writeFile(path.join(root, "outside.md"), ""); await symlink(path.join(root, "outside.md"), path.join(root, "docs/link.md"));
		const store = new SqliteMetadataStore(path.join(root, "db.sqlite")); await store.initialize();
		await expect(applyKnowledgeManifest(root, "p", store, { ...example, knowledge: [{ ...example.knowledge[0], source: "docs/link.md", tests: [] }] })).rejects.toThrow(/Symlink/);
		await store.close();
	});

	it("rejects export destinations and parents that escape through symlinks", async () => {
		const root = temp(); const outside = temp();
		await mkdir(path.join(root, "output"));
		const outsideFile = path.join(outside, "manifest.json");
		await writeFile(outsideFile, "outside");
		await symlink(outsideFile, path.join(root, "destination.json"));
		await expect(writeManifestExport(root, "destination.json", "replacement\n")).rejects.toThrow(/destination must not be a symlink/);
		expect(await readFile(outsideFile, "utf8")).toBe("outside");

		rmSync(path.join(root, "output"), { recursive: true, force: true });
		await symlink(outside, path.join(root, "output"));
		await expect(writeManifestExport(root, "output/manifest.json", "replacement\n")).rejects.toThrow(/parent escapes project root/);
	});

	it("reconciles real SQLite edges and keeps prose mentions out of declaration dependencies", async () => {
		const root = temp();
		for (const directory of ["docs", "src", "tests"]) await mkdir(path.join(root, directory));
		await Promise.all([
			writeFile(path.join(root, "docs/login.md"), "# Login\nA mention of `src/other.ts` is not evidence."),
			writeFile(path.join(root, "src/login.ts"), "export {}"),
			writeFile(path.join(root, "src/other.ts"), "export {}"),
			writeFile(path.join(root, "tests/login.test.ts"), ""),
		]);
		const store = new SqliteMetadataStore(path.join(root, "db.sqlite"));
		await store.initialize();
		try {
			await applyKnowledgeManifest(root, "p", store, example);
			const service = new KnowledgeService("p", root, store, store);
			await service.record({ path: "docs/login.md", classification: "spec" });
			expect((await store.listKnowledgeRelations("p")).map((relation) => relation.targetPath)).not.toContain("src/other.ts");
			await store.upsertKnowledgeRelation({ projectId: "p", sourcePath: "docs/login.md", targetPath: "src/login.ts",
				targetKind: "code", relationKind: "implements", provenance: "inferred" });
			await applyKnowledgeManifest(root, "p", store, { ...example, knowledge: [{ ...example.knowledge[0], implements: [] }] });
			const implementation = (await store.listKnowledgeRelations("p")).filter((relation) => relation.targetPath === "src/login.ts");
			expect(implementation).toHaveLength(1);
			expect(implementation[0].provenance).toBe("inferred");
			expect((await exportKnowledgeManifest("p", store)).knowledge[0].implements).toBeUndefined();
		} finally { await store.close(); }
	});

	it("canonicalizes aliases and rejects reverse supersession cycles and opaque evidence", () => {
		const aliases = parseKnowledgeManifest({ ...example, knowledge: [{ ...example.knowledge[0], source: "./docs/login.md" }, { ...example.knowledge[0], id: "other", source: "docs/login.md", implements: [] }] });
		expect(aliases.valid).toBe(false); expect(aliases.diagnostics.some((d) => /alias/.test(d.message))).toBe(true);
		const cycle = parseKnowledgeManifest({ version: 1, knowledge: [
			{ ...example.knowledge[0], id: "a", source: "docs/a.md", implements: [], "superseded-by": [{ id: "a-by-b", target: "b" }] },
			{ ...example.knowledge[0], id: "b", source: "docs/b.md", implements: [], supersedes: [{ id: "b-over-a", target: "a" }] },
		] });
		expect(cycle.valid).toBe(false); expect(cycle.diagnostics.some((d) => /cycle/.test(d.message))).toBe(true);
		const evidence = parseKnowledgeManifest({ ...example, knowledge: [{ ...example.knowledge[0], implements: [{ id: "x", target: "src/login.ts", evidence: { selector: "login" } }] }] });
		expect(evidence.valid).toBe(false);
		const nestedUnknown = parseKnowledgeManifest({ ...example, knowledge: [{ ...example.knowledge[0], implements: [{ id: "x", target: "src/login.ts", evidence: { selector: { kind: "code-symbol", value: "login", extra: true } } }] }] });
		expect(nestedUnknown.valid).toBe(false); expect(nestedUnknown.diagnostics.some((d) => d.path.endsWith("selector.extra") && /unknown/.test(d.message))).toBe(true);
	});

	it("replaces only this manifest's declarations and exposes the record integration marker", async () => {
		const root = temp(); await mkdir(path.join(root, "docs")); await mkdir(path.join(root, "src")); await mkdir(path.join(root, "tests"));
		await Promise.all([writeFile(path.join(root, "docs/login.md"), ""), writeFile(path.join(root, "src/login.ts"), ""), writeFile(path.join(root, "src/other.ts"), ""), writeFile(path.join(root, "tests/login.test.ts"), "")]);
		const entries = new Map<string, KnowledgeEntry>(); const relations: KnowledgeRelation[] = [];
		const store = {
			async upsertKnowledgeEntry(entry: KnowledgeEntry) { entries.set(entry.path, entry); }, async getKnowledgeEntry(_: string, p: string) { return entries.get(p) ?? null; }, async listKnowledgeEntries() { return [...entries.values()]; }, async deleteKnowledgeEntry() {},
			async upsertKnowledgeRelation(relation: KnowledgeRelation) { const index = relations.findIndex((r) => r.sourcePath === relation.sourcePath && r.targetPath === relation.targetPath && r.targetKind === relation.targetKind && r.relationKind === relation.relationKind && r.provenance === relation.provenance); if (index < 0) relations.push(relation); else relations[index] = relation; }, async listKnowledgeRelations(_: string, options?: { sourcePath?: string }) { return relations.filter((r) => !options?.sourcePath || r.sourcePath === options.sourcePath); }, async deleteKnowledgeRelation() { return 0; }, async upsertKnowledgeVerifiedInput() {}, async listKnowledgeVerifiedInputs() { return []; }, async deleteKnowledgeVerifiedInput() {}, async replaceKnowledgeVerifiedInputs() {}, async clearKnowledgeVerification(_: string, p: string) { const entry = entries.get(p); if (entry) { delete entry.verifiedAt; delete entry.verifiedSourceHash; delete entry.verifiedRelationsHash; delete entry.verificationReceipt; } }, async commitKnowledgeVerification() {}, async replaceKnowledgeChunks() {}, async listKnowledgeChunks() { return []; },
			async applyKnowledgeManifestAtomically(_: string, operations: Array<{ sourcePath: string; manifestId: string; classification: KnowledgeEntry["classification"]; behaviorType: KnowledgeEntry["behaviorType"]; lifecycle: KnowledgeEntry["lifecycle"]; owner?: string; summary: string; topics: string[]; indexedSourceHash: string; title: string; relations: KnowledgeRelation[] }>) { const staleDeclarations: string[] = []; for (const operation of operations) { const prior = entries.get(operation.sourcePath); entries.set(operation.sourcePath, { projectId: "p", path: operation.sourcePath, classification: operation.classification, behaviorType: operation.behaviorType, lifecycle: operation.lifecycle, confidence: prior?.confidence ?? "unknown", title: prior?.title ?? operation.title, summary: operation.summary, topics: operation.topics, indexedSourceHash: operation.indexedSourceHash, indexedAt: 1, metadata: { ...(prior?.metadata ?? {}), manifest: { id: operation.manifestId, authoritative: true, ...(operation.owner ? { owner: operation.owner } : {}) } } }); if ((operation.classification !== "spec" && operation.classification !== "spec-like") && (prior?.classification === "spec" || prior?.classification === "spec-like")) await this.clearKnowledgeVerification("p", operation.sourcePath); const desired = new Set(operation.relations.map((r) => `${r.targetPath}\0${r.targetKind}\0${r.relationKind}`)); for (let index = relations.length - 1; index >= 0; index--) { const marker = relations[index].metadata?.manifest as { id?: string } | undefined; if (relations[index].sourcePath === operation.sourcePath && marker?.id === operation.manifestId) { if (!desired.has(`${relations[index].targetPath}\0${relations[index].targetKind}\0${relations[index].relationKind}`)) staleDeclarations.push(`${operation.sourcePath}:${relations[index].relationKind}:${relations[index].targetPath}`); relations.splice(index, 1); } } relations.push(...operation.relations); } return { staleDeclarations }; },
		} as unknown as KnowledgeStore;
		relations.push({ projectId: "p", sourcePath: "docs/login.md", targetPath: "src/login.ts", targetKind: "code", relationKind: "implements", provenance: "inferred" });
		const parsed = parseKnowledgeManifest(example); await applyKnowledgeManifest(root, "p", store, parsed.manifest!);
		Object.assign(entries.get("docs/login.md")!, { verifiedAt: 1, verifiedSourceHash: "old" });
		const next = { ...parsed.manifest!, knowledge: [{ ...parsed.manifest!.knowledge[0], classification: "guide" as const, implements: [] }] }; const result = await applyKnowledgeManifest(root, "p", store, next);
		expect(result.staleDeclarations).toEqual(["docs/login.md:implements:src/login.ts"]);
		expect(relations.filter((r) => r.provenance === "inferred")).toHaveLength(1);
		const declarations = await normalizeManifestDeclarations(root, next); expect(declarationForSource(declarations, "docs/login.md")?.relations).toEqual([{ assertionId: "login-test", targetPath: "tests/login.test.ts", targetKind: "code", relationKind: "tests" }]);
		expect(isManifestAuthoritativeEntry(entries.get("docs/login.md")!)).toBe(true);
		expect(entries.get("docs/login.md")?.verifiedAt).toBeUndefined();
	});

	it("rolls back all SQLite changes when a later declaration collides", async () => {
		const root = temp(); await mkdir(path.join(root, "docs")); await mkdir(path.join(root, "src"));
		await Promise.all([writeFile(path.join(root, "docs/a.md"), "a"), writeFile(path.join(root, "docs/b.md"), "b"), writeFile(path.join(root, "src/a.ts"), ""), writeFile(path.join(root, "src/b.ts"), "")]);
		const store = new SqliteMetadataStore(path.join(root, "db.sqlite")); await store.initialize();
		try {
			await store.upsertKnowledgeEntry({ projectId: "p", path: "docs/a.md", classification: "spec", behaviorType: "as-is", lifecycle: "active", confidence: "high", title: "old", summary: "old", topics: [], indexedSourceHash: "old", indexedAt: 1, verifiedSourceHash: "verified", verifiedRelationsHash: "relations", verifiedAt: 1 });
			await store.upsertKnowledgeVerifiedInput({ projectId: "p", sourcePath: "docs/a.md", inputPath: "src/a.ts", inputHash: "input", verifiedAt: 1 });
			await store.upsertKnowledgeRelation({ projectId: "p", sourcePath: "docs/b.md", targetPath: "src/b.ts", targetKind: "code", relationKind: "implements", provenance: "explicit", metadata: { other: true } });
			const manifest = { version: 1 as const, knowledge: [
				{ id: "a", source: "docs/a.md", classification: "guide" as const, behaviorType: "as-is" as const, lifecycle: "active" as const, summary: "new", implements: [{ id: "a-edge", target: "src/a.ts" }] },
				{ id: "b", source: "docs/b.md", classification: "spec" as const, behaviorType: "as-is" as const, lifecycle: "active" as const, summary: "new", implements: [{ id: "b-edge", target: "src/b.ts" }] },
			] };
			await expect(applyKnowledgeManifest(root, "p", store, { ...manifest, knowledge: [manifest.knowledge[1], manifest.knowledge[0]] })).rejects.toThrow(/collides/);
			expect(await store.getKnowledgeEntry("p", "docs/b.md")).toBeNull();
			await expect(applyKnowledgeManifest(root, "p", store, manifest)).rejects.toThrow(/collides/);
			const entry = await store.getKnowledgeEntry("p", "docs/a.md"); expect(entry?.classification).toBe("spec"); expect(entry?.verifiedAt).toBe(1); expect(entry?.summary).toBe("old");
			expect(await store.listKnowledgeVerifiedInputs("p", "docs/a.md")).toEqual([{ projectId: "p", sourcePath: "docs/a.md", inputPath: "src/a.ts", inputHash: "input", verifiedAt: 1 }]);
			expect(await store.getKnowledgeEntry("p", "docs/b.md")).toBeNull();
			expect(await store.listKnowledgeRelations("p", { sourcePath: "docs/a.md" })).toEqual([]);
			expect((await store.listKnowledgeRelations("p", { sourcePath: "docs/b.md" }))[0].metadata).toEqual({ other: true });
		} finally { await store.close(); }
	});
});
