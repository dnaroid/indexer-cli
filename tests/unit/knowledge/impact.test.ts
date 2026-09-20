import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitOperations, KnowledgeVerificationReceipt } from "../../../src/core/types.js";
import { KnowledgeImpactEngine } from "../../../src/knowledge/impact.js";
import type { KnowledgeSearchResult } from "../../../src/knowledge/search.js";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";

class EmptyGit implements GitOperations {
	async getHeadCommit(): Promise<string | null> {
		return "head";
	}
	async isDirty(): Promise<boolean> {
		return false;
	}
	async getChangedFiles() {
		return { added: [], modified: [], deleted: [] };
	}
	async getWorkingTreeChanges() {
		return { added: [], modified: [], deleted: [] };
	}
	async getChurnByFile(): Promise<Record<string, number>> {
		return {};
	}
}

describe("KnowledgeImpactEngine", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), "idx-knowledge-impact-"));
		tempDirs.push(dir);
		return dir;
	}

	async function setup() {
		const root = tempDir();
		const store = new SqliteMetadataStore(path.join(root, "db.sqlite"));
		await store.initialize();
		const snapshot = await store.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "head",
		});
		const service = new KnowledgeService("project", root, store, store);
		return { root, store, snapshot, service };
	}

	async function verify(service: KnowledgeService, path: string) {
		const prepared = await service.prepareVerification(path);
		const receipt: KnowledgeVerificationReceipt = {
			version: 1,
			sourcePath: prepared.sourcePath,
			sourceHash: prepared.sourceHash,
			relationsHash: prepared.relationsHash,
			inputs: prepared.inputs,
			preparedAt: 1,
			reviewer: "impact-test",
			rationale: "The recorded assertion was reviewed against the prepared source.",
			assertionReferences: ["recorded assertion"],
			evidenceReferences: ["prepared source"],
			assertionBindings: [{ path: prepared.sourcePath, hash: prepared.sourceHash, assertion: "recorded assertion" }],
			evidenceBindings: [{ path: prepared.sourcePath, hash: prepared.sourceHash }],
			limitations: ["No command was executed."],
			...(prepared.inputs.length === 0 ? { zeroTrackedInputsAcknowledged: true } : {}),
		};
		return service.verify(path, receipt);
	}

	it("surfaces uncovered implementation paths, graph context, and semantic candidates without persisting them", async () => {
		const { root, store, snapshot, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/session.ts"), "export const session = true;\n");
		await writeFile(
			path.join(root, "src/refresh-worker.ts"),
			"import './session.js'; export const refresh = true;\n",
		);
		await writeFile(
			path.join(root, "docs/session.md"),
			"# Session\n\n## Behavior\nRefresh retries once.\n\n`src/session.ts`\n",
		);
		await service.record({
			path: "docs/session.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "Session refresh retry contract.",
		});
		await verify(service, "docs/session.md");
		await store.replaceDependencies("project", snapshot.id, "src/refresh-worker.ts", [
			{
				id: "dep",
				toSpecifier: "./session.js",
				toPath: "src/session.ts",
				kind: "import",
				dependencyType: "internal",
			},
		]);

		const searchCalls: string[] = [];
		const searcher = {
			search: async (query: string): Promise<KnowledgeSearchResult[]> => {
				searchCalls.push(query);
				return [
					{
						path: "docs/session.md",
						title: "Session",
						authority: "registered",
						classification: "spec",
						behaviorType: "as-is",
						lifecycle: "active",
						status: "fresh",
						trust: "verified",
						score: 9,
						semanticScore: 0.9,
						lexicalScore: 0,
						summary: "Session refresh retry contract.",
						topics: [],
						reasonCodes: ["semantic"],
						bestRanges: [],
					},
				];
			},
		};
		const impact = new KnowledgeImpactEngine(
			"project",
			root,
			snapshot.id,
			store,
			store,
			service,
			new EmptyGit(),
			searcher,
		);
		const result = await impact.impact({ paths: ["src/refresh-worker.ts"] });
		expect(result.knownAffected).toEqual([]);
		expect(result.uncoveredPaths).toEqual(["src/refresh-worker.ts"]);
		expect(result.graphContext[0]).toMatchObject({
			path: "src/refresh-worker.ts",
			imports: ["src/session.ts"],
		});
		expect(result.semanticCandidates[0]?.candidates[0]?.path).toBe(
			"docs/session.md",
		);
		expect(searchCalls[0]).toContain("session.ts");
		expect(
			(await store.listKnowledgeRelations("project", { sourcePath: "docs/session.md" })).map(
				(relation) => relation.targetPath,
			),
		).toEqual(["src/session.ts"]);
		await store.close();
	});

	it("surfaces an untracked helper imported by a tracked input without inventing coverage", async () => {
		const { root, store, snapshot, service } = await setup();
		await mkdir(path.join(root, "docs"));
		await mkdir(path.join(root, "src"));
		await writeFile(path.join(root, "src/session.ts"), "import './helper.js';\n");
		await writeFile(path.join(root, "src/helper.ts"), "export const retries = 2;\n");
		await writeFile(path.join(root, "docs/session.md"), "# Session\nRetry once.\n`src/session.ts`\n");
		await service.record({ path: "docs/session.md", classification: "spec", behaviorType: "as-is", lifecycle: "active", summary: "Retry contract." });
		await store.replaceDependencies("project", snapshot.id, "src/session.ts", [{
			id: "helper-import", toSpecifier: "./helper.js", toPath: "src/helper.ts", kind: "import", dependencyType: "internal",
		}]);
		const engine = new KnowledgeImpactEngine("project", root, snapshot.id, store, store, service, new EmptyGit());
		const result = await engine.impact({ paths: ["src/helper.ts"] });
		expect(result.knownAffected).toEqual([expect.objectContaining({
			path: "docs/session.md", matchedChanges: ["src/helper.ts"],
			reasons: expect.arrayContaining(["untracked-dependency:src/helper.ts"]),
		})]);
		expect(result.uncoveredPaths).toEqual(["src/helper.ts"]);
		expect(result.semanticSweepRequired).toBe(true);
		expect((await store.listKnowledgeRelations("project")).map((relation) => relation.targetPath)).toEqual(["src/session.ts"]);
		await store.close();
	});

	it("shows every changed document even when its discovery score is zero", async () => {
		const { root, store, snapshot, service } = await setup();
		await mkdir(path.join(root, "notes"), { recursive: true });
		await writeFile(
			path.join(root, "notes/capture.txt"),
			"Duplicate capture returns the original result.\n",
		);
		const impact = new KnowledgeImpactEngine(
			"project",
			root,
			snapshot.id,
			store,
			store,
			service,
			new EmptyGit(),
		);
		const result = await impact.impact({ paths: ["notes/capture.txt"] });
		expect(result.changedDocuments).toMatchObject([
			{
				path: "notes/capture.txt",
				score: 0,
				requiresClassification: true,
			},
		]);
		expect(result.uncoveredPaths).toEqual([]);
		expect(result.semanticSweepRequired).toBe(true);
		await store.close();
	});

	it("detects moved primary sources and requires reclassification of a new path", async () => {
		const { root, store, snapshot, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "contracts"), { recursive: true });
		await writeFile(path.join(root, "docs/job.md"), "# Job\n\n## Behavior\nCancel.\n");
		await service.record({
			path: "docs/job.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "Job cancellation.",
		});
		await rename(path.join(root, "docs/job.md"), path.join(root, "contracts/job.md"));
		const impact = new KnowledgeImpactEngine(
			"project",
			root,
			snapshot.id,
			store,
			store,
			service,
			new EmptyGit(),
		);
		const result = await impact.impact({
			paths: ["docs/job.md", "contracts/job.md"],
		});
		expect(result.missingTrackedSpecs).toEqual(["docs/job.md"]);
		expect(result.changedDocuments).toEqual([
			expect.objectContaining({
				path: "contracts/job.md",
				requiresClassification: true,
			}),
		]);
		await store.close();
	});

	it("requires reclassification when a previously non-primary changed document may have become a contract", async () => {
		const { root, store, snapshot, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(path.join(root, "docs/info.md"), "# Info\n\nUsage guide.\n");
		await service.record({
			path: "docs/info.md",
			classification: "guide",
			summary: "Guide.",
		});
		await writeFile(
			path.join(root, "docs/info.md"),
			"# Request contract\n\n## Behavior\nDuplicate requests are idempotent.\n",
		);
		const impact = new KnowledgeImpactEngine(
			"project",
			root,
			snapshot.id,
			store,
			store,
			service,
			new EmptyGit(),
		);
		const result = await impact.impact({ paths: ["docs/info.md"] });
		expect(result.changedDocuments[0]).toMatchObject({
			knownClassification: "guide",
			requiresReclassification: true,
		});
		expect(result.semanticSweepRequired).toBe(true);
		await store.close();
	});

	it("does not read a document symlink that resolves outside the project", async () => {
		const { root, store, snapshot, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		const outside = tempDir();
		await writeFile(path.join(outside, "secret.md"), "# Secret\n\n## Behavior\nOutside.\n");
		await symlink(path.join(outside, "secret.md"), path.join(root, "docs/escape.md"));

		const impact = new KnowledgeImpactEngine(
			"project",
			root,
			snapshot.id,
			store,
			store,
			service,
			new EmptyGit(),
		);
		const result = await impact.impact({ paths: ["docs/escape.md"] });
		expect(result.changedDocuments).toEqual([]);
		expect(result.uncoveredPaths).toEqual(["docs/escape.md"]);
		expect(result.semanticSweepRequired).toBe(true);
		await store.close();
	});
});
