import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EmbeddingProvider, KnowledgeVerificationReceipt } from "../../src/core/types.js";
import { TokenEstimator } from "../../src/utils/token-estimator.js";
import { formatKnowledgeContext } from "../../src/knowledge/context.js";
import { DocumentIndexer } from "../../src/knowledge/document-indexer.js";
import { KnowledgeImpactEngine } from "../../src/knowledge/impact.js";
import { KnowledgeSearchEngine } from "../../src/knowledge/search.js";
import { KnowledgeService } from "../../src/knowledge/service.js";
import { SqliteMetadataStore } from "../../src/storage/sqlite.js";
import { SqliteVecVectorStore } from "../../src/storage/vectors.js";

type Fixture = {
	positiveQueries: Array<{ query: string; expectedPath: string }>;
	negativeQueries: string[];
	contradictoryActiveContracts: Array<{ path: string; summary: string }>;
	expected: Record<string, number>;
};

/** Deliberately deterministic plumbing only; lexical assertions are the retrieval signal. */
class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly id = "knowledge-quality-fake";
	embedCalls = 0;
	async initialize(): Promise<void> {}
	async close(): Promise<void> {}
	getDimension(): number { return 3; }
	async embed(texts: string[]): Promise<number[][]> { this.embedCalls += texts.length; return texts.map((_, i) => [1, i + 1, 1]); }
}

const enabled = process.env.RUN_KNOWLEDGE_QUALITY_EVAL === "1";
const describeEval = enabled ? describe : describe.skip;
const content = {
	"docs/payments.md": "# Payment idempotency\n\nDuplicate payment requests preserve the original charge result.\n\n`src/payments.ts`\n",
	"docs/exports.md": "# Export cancellation\n\nCancel a running export job and ignore late completion.\n\n`src/exports.ts`\n",
	"docs/sessions.md": "# Session restoration\n\nRestore a paused user session after restart.\n\n`src/sessions.ts`\n",
	"docs/settlement-immediate.md": "# Settlement timing contract\n\nA payment settles immediately after authorization.\n",
	"docs/settlement-delayed.md": "# Settlement timing contract\n\nA payment settles only after the nightly batch.\n",
};

function receipt(prepared: Awaited<ReturnType<KnowledgeService["prepareVerification"]>>, reviewer = "offline-eval"): KnowledgeVerificationReceipt {
	return {
		version: 1, sourcePath: prepared.sourcePath, sourceHash: prepared.sourceHash,
		relationsHash: prepared.relationsHash, inputs: prepared.inputs, preparedAt: 1,
		reviewer, rationale: "Reviewed the assertion against prepared evidence.",
		assertionReferences: ["document assertion"], evidenceReferences: ["prepared source"],
		assertionBindings: [{ path: prepared.sourcePath, hash: prepared.sourceHash, assertion: "document assertion" }],
		evidenceBindings: [{ path: prepared.sourcePath, hash: prepared.sourceHash }],
		limitations: ["No command was executed by this service."],
		...(prepared.inputs.length === 0 ? { zeroTrackedInputsAcknowledged: true } : {}),
	};
}

describeEval("knowledge quality: deterministic, offline regression metrics", () => {
	let root = "";
	afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

	it("measures drift false-fresh, conservative review noise, and lexical retrieval", async () => {
		const truth = JSON.parse(await readFile(path.join(process.cwd(), "evals/knowledge/quality-scenarios.json"), "utf8")) as Fixture;
		root = mkdtempSync(path.join(os.tmpdir(), "idx-knowledge-quality-"));
		await Promise.all([mkdir(path.join(root, "docs")), mkdir(path.join(root, "src"))]);
		for (const [file, text] of Object.entries(content)) await writeFile(path.join(root, file), text);
		await Promise.all([
			writeFile(path.join(root, "src/payments.ts"), "export const charge = () => 'once';\n"),
			writeFile(path.join(root, "src/exports.ts"), "export const cancel = () => true;\n"),
			writeFile(path.join(root, "src/sessions.ts"), "export const restore = () => true;\n"),
			writeFile(path.join(root, "src/helper.ts"), "export const helper = true;\n"),
			writeFile(path.join(root, "src/relation.ts"), "export const relation = true;\n"),
		]);
		const dbPath = path.join(root, "db.sqlite");
		const store = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		await Promise.all([store.initialize(), vectors.initialize()]);
		try {
			const snapshot = await store.createSnapshot("project", { indexedAt: 1, headCommit: "quality" });
			const indexStarted = Date.now();
			const embeddings = new FakeEmbeddingProvider();
			const indexed = await new DocumentIndexer(root, store, store, vectors, embeddings).indexFull("project", snapshot.id);
			const indexMs = Date.now() - indexStarted;
			expect(indexed.errors).toEqual([]);
			const service = new KnowledgeService("project", root, store, store);
			for (const [file, summary] of Object.entries({ "docs/payments.md": "Duplicate payment idempotency.", "docs/exports.md": "Export cancellation.", "docs/sessions.md": "Session restoration." })) {
				await service.record({ path: file, classification: "spec", behaviorType: "as-is", lifecycle: "active", summary });
				const prepared = await service.prepareVerification(file);
				await service.verify(file, receipt(prepared));
			}
			// Deliberately contradictory prose is independent reviewed input, not semantic proof.
			for (const contract of truth.contradictoryActiveContracts) {
				await service.record({ path: contract.path, classification: "spec", behaviorType: "as-is", lifecycle: "active", summary: contract.summary });
				const prepared = await service.prepareVerification(contract.path);
				await service.verify(contract.path, receipt(prepared));
			}
			const contradictoryEntries = await Promise.all(truth.contradictoryActiveContracts.map((contract) => store.getKnowledgeEntry("project", contract.path)));
			expect(contradictoryEntries).toHaveLength(truth.expected.activeContradictoryContracts);
			expect(contradictoryEntries).toEqual(expect.arrayContaining(truth.contradictoryActiveContracts.map((contract) => expect.objectContaining({ path: contract.path, lifecycle: "active" }))));
			expect(await Promise.all(contradictoryEntries.map((entry) => service.getStatus(entry!)))).toEqual(expect.arrayContaining(truth.contradictoryActiveContracts.map((contract) => expect.objectContaining({ path: contract.path, status: "fresh", lifecycle: "active" }))));
			expect((await store.listKnowledgeRelations("project")).filter((relation) => relation.relationKind === "supersedes" || relation.relationKind === "superseded-by")).toEqual([]);

			// Declared drift truth set: source, input, relation map, moved source, unattested baseline, rejected evidence.
			await writeFile(path.join(root, "docs/payments.md"), `${content["docs/payments.md"]}\nChanged claim.\n`);
			const sourceStatus = await service.getStatus((await store.getKnowledgeEntry("project", "docs/payments.md"))!);
			await writeFile(path.join(root, "src/exports.ts"), "export const cancel = () => false;\n");
			const inputStatus = await service.getStatus((await store.getKnowledgeEntry("project", "docs/exports.md"))!);
			await service.relate({ sourcePath: "docs/exports.md", targetPath: "src/relation.ts", targetKind: "code", relationKind: "implements", action: "add" });
			const relationStatus = await service.getStatus((await store.getKnowledgeEntry("project", "docs/exports.md"))!);
			await rename(path.join(root, "docs/sessions.md"), path.join(root, "docs/sessions-moved.md"));
			const movedStatus = await service.getStatus((await store.getKnowledgeEntry("project", "docs/sessions.md"))!);
			await writeFile(path.join(root, "docs/legacy.md"), "# Legacy\n\nOld contract.\n");
			const legacy = await service.record({ path: "docs/legacy.md", classification: "spec", behaviorType: "as-is", lifecycle: "active", summary: "Old unattested contract." });
			const legacyStatus = await service.getStatus(legacy);
			await writeFile(path.join(root, "docs/no-evidence.md"), "# Evidence\n\nMust be evidenced.\n");
			const noEvidence = await service.record({ path: "docs/no-evidence.md", classification: "spec", behaviorType: "as-is", lifecycle: "active", summary: "Evidence requirement." });
			const noEvidencePrepared = await service.prepareVerification("docs/no-evidence.md");
			await expect(service.verify("docs/no-evidence.md", { ...receipt(noEvidencePrepared), evidenceReferences: [] })).rejects.toThrow("evidenceReferences");
			const noEvidenceStatus = await service.getStatus(noEvidence);
			const declared = [sourceStatus, inputStatus, relationStatus, movedStatus, legacyStatus, noEvidenceStatus];
			const falseFresh = declared.filter((status) => status.status === "fresh").length;
			expect(declared).toEqual(expect.arrayContaining([expect.objectContaining({ status: "spec-changed" }), expect.objectContaining({ status: "inputs-changed" }), expect.objectContaining({ status: "missing-source" }), expect.objectContaining({ status: "unverified" })]));
			expect(falseFresh).toBe(truth.expected.declaredFalseFresh);

			// Whole-file hashing intentionally requests review even when a selected behavior was not changed.
			await writeFile(path.join(root, "docs/noise.md"), "# Noise\n\n`src/noise.ts`\n");
			await writeFile(path.join(root, "src/noise.ts"), "export const behavior = true;\n");
			const noise = await service.record({ path: "docs/noise.md", classification: "spec", behaviorType: "as-is", lifecycle: "active", summary: "Noise control." });
			const noisePrepared = await service.prepareVerification("docs/noise.md");
			await service.verify("docs/noise.md", receipt(noisePrepared));
			await writeFile(path.join(root, "src/noise.ts"), "export const behavior = true;\n// unrelated formatting comment\n");
			const noiseStatus = await service.getStatus((await store.getKnowledgeEntry("project", noise.path))!);
			expect(noiseStatus.status).toBe("inputs-changed");

			const search = new KnowledgeSearchEngine("project", snapshot.id, store, store, vectors, null, service);
			const embedCallsBeforeContradictionSearch = embeddings.embedCalls;
			const contradictoryResults = await search.search("payment settlement timing", { mode: "lexical", limit: truth.expected.activeContradictoryContracts });
			expect(contradictoryResults.map((result) => result.path).sort()).toEqual(truth.contradictoryActiveContracts.map((contract) => contract.path).sort());
			expect(contradictoryResults).toEqual(expect.arrayContaining(truth.contradictoryActiveContracts.map((contract) => expect.objectContaining({ path: contract.path, lifecycle: "active", status: "fresh", semanticScore: truth.expected.contradictionSemanticProofClaims }))));
			expect(contradictoryResults.flatMap((result) => result.reasonCodes)).not.toContain("semantic");
			expect(search.getDiagnostics()).toMatchObject({ mode: "lexical", semanticAvailable: false });
			expect(embeddings.embedCalls).toBe(embedCallsBeforeContradictionSearch);
			const queryStarted = Date.now();
			let retrieved = 0;
			for (const item of truth.positiveQueries) if ((await search.search(item.query, { mode: "lexical", limit: 1 }))[0]?.path === item.expectedPath) retrieved++;
			let abstained = 0;
			for (const query of truth.negativeQueries) if ((await search.search(query, { mode: "lexical", limit: 3 })).length === 0) abstained++;
			const queryMs = Date.now() - queryStarted;
			const precision = retrieved / truth.positiveQueries.length;
			const recall = retrieved / truth.positiveQueries.length;
			const negativeAbstention = abstained / truth.negativeQueries.length;
			const contextTokens = new TokenEstimator().estimate(formatKnowledgeContext({ query: truth.positiveQueries[0].query, specs: await search.search(truth.positiveQueries[0].query, { mode: "lexical" }), implementation: [], tests: [], relations: [], warnings: [], readNext: [] }, 600));
			expect({ retrieved, abstained, precision, recall, negativeAbstention }).toEqual({ retrieved: truth.expected.retrievalPositive, abstained: truth.expected.retrievalNegative, precision: 1, recall: 1, negativeAbstention: 1 });

			await store.replaceDependencies("project", snapshot.id, "src/sessions.ts", [{ id: "helper", toSpecifier: "./helper.js", toPath: "src/helper.ts", kind: "import", dependencyType: "internal" }]);
			const impact = await new KnowledgeImpactEngine("project", root, snapshot.id, store, store, service, {} as never).impact({ paths: ["src/helper.ts"] });
			expect(impact.knownAffected).toEqual(expect.arrayContaining([expect.objectContaining({ path: "docs/sessions.md", reasons: expect.arrayContaining(["untracked-dependency:src/helper.ts"]) })]));
			expect(impact.uncoveredPaths).toContain("src/helper.ts");
			console.log(`KNOWLEDGE_QUALITY_EVAL declared_drift=${declared.length} false_fresh=${falseFresh} false_fresh_rate=${falseFresh}/${declared.length} review_noise=1 review_noise_fresh=0 lexical_precision=${precision.toFixed(2)} lexical_recall=${recall.toFixed(2)} negative_abstention=${negativeAbstention.toFixed(2)} llm_calls=0 index_ms=${indexMs} query_ms=${queryMs} context_tokens=${contextTokens}`);
		} finally { await vectors.close(); await store.close(); }
	}, 30_000);
});
