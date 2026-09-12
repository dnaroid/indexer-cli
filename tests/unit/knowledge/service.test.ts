import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";

describe("KnowledgeService", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(): string {
		const dir = mkdtempSync(path.join(os.tmpdir(), "idx-knowledge-service-"));
		tempDirs.push(dir);
		return dir;
	}

	async function setup(): Promise<{
		root: string;
		store: SqliteMetadataStore;
		service: KnowledgeService;
	}> {
		const root = tempDir();
		const store = new SqliteMetadataStore(path.join(root, "db.sqlite"));
		await store.initialize();
		return {
			root,
			store,
			service: new KnowledgeService("project", root, store, store),
		};
	}

	it("keeps record separate from verify and detects source/input/relation drift", async () => {
		const { root, store, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/session.ts"), "export const retry = 1;\n");
		await writeFile(
			path.join(root, "docs/session.md"),
			"# Session contract\n\n## Behavior\nRetry once.\n\n## Related files\n- `src/session.ts`\n",
		);

		await service.record({
			path: "docs/session.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			confidence: "high",
			summary: "Session retry contract.",
			topics: ["session", "retry"],
		});
		expect((await service.audit()).unverifiedCount).toBe(1);

		await service.verify("docs/session.md");
		expect((await service.audit()).freshCount).toBe(1);

		await writeFile(path.join(root, "src/session.ts"), "export const retry = 2;\n");
		expect((await service.listStatuses())[0]).toMatchObject({
			status: "inputs-changed",
		});

		await service.verify("docs/session.md");
		await writeFile(path.join(root, "src/worker.ts"), "export const worker = true;\n");
		await service.relate({
			sourcePath: "docs/session.md",
			targetPath: "src/worker.ts",
			targetKind: "code",
			relationKind: "implements",
			action: "add",
		});
		expect((await service.listStatuses())[0]).toMatchObject({
			status: "inputs-changed",
			reasons: expect.arrayContaining(["relations:changed"]),
		});

		await store.close();
	});

	it("re-extracts explicit relations on record and preserves inferred ones", async () => {
		const { root, store, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/a.ts"), "export {}\n");
		await writeFile(path.join(root, "src/b.ts"), "export {}\n");
		await writeFile(
			path.join(root, "docs/a.md"),
			"# A\n\n## Behavior\nA.\n\n`src/a.ts`\n",
		);
		await service.record({
			path: "docs/a.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "A contract.",
		});
		await service.relate({
			sourcePath: "docs/a.md",
			targetPath: "src/b.ts",
			targetKind: "code",
			relationKind: "implements",
			action: "add",
		});

		await writeFile(path.join(root, "docs/a.md"), "# A\n\n## Behavior\nA changed.\n");
		await service.record({
			path: "docs/a.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "A changed contract.",
		});
		const relations = await store.listKnowledgeRelations("project", {
			sourcePath: "docs/a.md",
		});
		expect(relations).toEqual([
			expect.objectContaining({
				targetPath: "src/b.ts",
				provenance: "inferred",
			}),
		]);
		await store.close();
	});

	it("does not duplicate an explicit semantic edge with an inferred one", async () => {
		const { root, store, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/a.ts"), "export {}\n");
		await writeFile(path.join(root, "docs/a.md"), "# A\n\n`src/a.ts`\n");
		await service.record({
			path: "docs/a.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "A contract.",
		});
		await service.verify("docs/a.md");

		const before = await service.relate({
			sourcePath: "docs/a.md",
			targetPath: "src/a.ts",
			targetKind: "code",
			relationKind: "implements",
			action: "add",
		});
		expect(before.status).toBe("fresh");
		expect(
			await store.listKnowledgeRelations("project", { sourcePath: "docs/a.md" }),
		).toEqual([
			expect.objectContaining({
				targetPath: "src/a.ts",
				relationKind: "implements",
				provenance: "explicit",
			}),
		]);

		await store.upsertKnowledgeRelation({
			projectId: "project",
			sourcePath: "docs/a.md",
			targetPath: "src/a.ts",
			targetKind: "code",
			relationKind: "implements",
			provenance: "inferred",
		});
		await expect(service.verify("docs/a.md")).resolves.toMatchObject({
			path: "docs/a.md",
		});
		expect(
			await store.listKnowledgeVerifiedInputs("project", "docs/a.md"),
		).toHaveLength(1);
		await store.close();
	});

	it.each(["changed", "deleted"])(
		"ignores a gitignored legacy verified input when it is %s",
		async (change) => {
			const { root, store, service } = await setup();
			await mkdir(path.join(root, "docs"), { recursive: true });
			await mkdir(path.join(root, ".pi"), { recursive: true });
			await writeFile(path.join(root, ".gitignore"), ".pi/\n");
			await writeFile(path.join(root, ".pi/tasks.jsonc"), "{\"version\":1}\n");
			await writeFile(path.join(root, "docs/tasks.md"), "# Tasks\n\n## Behavior\nTasks.\n");
			await service.record({
				path: "docs/tasks.md",
				classification: "spec",
				behaviorType: "as-is",
				lifecycle: "active",
				summary: "Task state contract.",
			});
			await store.upsertKnowledgeRelation({
				projectId: "project",
				sourcePath: "docs/tasks.md",
				targetPath: ".pi/tasks.jsonc",
				targetKind: "code",
				relationKind: "implements",
				provenance: "inferred",
			});
			await service.verify("docs/tasks.md");
			await store.upsertKnowledgeVerifiedInput({
				projectId: "project",
				sourcePath: "docs/tasks.md",
				inputPath: ".pi/tasks.jsonc",
				inputHash: "legacy-hash",
				verifiedAt: Date.now(),
			});

			if (change === "changed") {
				await writeFile(path.join(root, ".pi/tasks.jsonc"), "{\"version\":2}\n");
			} else {
				rmSync(path.join(root, ".pi/tasks.jsonc"));
			}

			const entry = await store.getKnowledgeEntry("project", "docs/tasks.md");
			expect(entry).not.toBeNull();
			expect(await service.getStatus(entry!)).toMatchObject({
				status: "fresh",
				reasons: [],
			});
			await store.close();
		},
	);

	it("skips gitignored relation targets during verify but rejects missing tracked inputs", async () => {
		const { root, store, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(path.join(root, ".gitignore"), "dist/\n");
		await writeFile(path.join(root, "docs/build.md"), "# Build\n\n## Behavior\nBuild.\n");
		await service.record({
			path: "docs/build.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "Build contract.",
		});
		await store.upsertKnowledgeRelation({
			projectId: "project",
			sourcePath: "docs/build.md",
			targetPath: "dist/main.js",
			targetKind: "code",
			relationKind: "implements",
			provenance: "inferred",
		});

		await expect(service.verify("docs/build.md")).resolves.toMatchObject({
			path: "docs/build.md",
		});
		expect(
			await store.listKnowledgeVerifiedInputs("project", "docs/build.md"),
		).toEqual([]);

		await store.upsertKnowledgeRelation({
			projectId: "project",
			sourcePath: "docs/build.md",
			targetPath: "src/missing.ts",
			targetKind: "code",
			relationKind: "implements",
			provenance: "inferred",
		});
		await expect(service.verify("docs/build.md")).rejects.toThrow(
			"Tracked input is missing or unreadable: src/missing.ts",
		);
		await store.close();
	});

	it("stores gitignored code relations and returns a freshness warning", async () => {
		const { root, store, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "dist"), { recursive: true });
		await writeFile(path.join(root, ".gitignore"), "dist/\n");
		await writeFile(path.join(root, "dist/main.js"), "export {};\n");
		await writeFile(path.join(root, "docs/build.md"), "# Build\n\n## Behavior\nBuild.\n");
		await service.record({
			path: "docs/build.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "Build contract.",
		});

		const status = await service.relate({
			sourcePath: "docs/build.md",
			targetPath: "dist/main.js",
			targetKind: "code",
			relationKind: "implements",
			action: "add",
		});
		expect(status.warnings).toEqual([
			"dist/main.js is gitignored and will not participate in freshness tracking.",
		]);
		expect(
			await store.listKnowledgeRelations("project", { sourcePath: "docs/build.md" }),
		).toEqual([
			expect.objectContaining({
				targetPath: "dist/main.js",
				targetKind: "code",
			}),
		]);
		await store.close();
	});

	it("can remove an inferred relation after its target file has already been deleted", async () => {
		const { root, store, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/worker.ts"), "export {}\n");
		await writeFile(path.join(root, "docs/a.md"), "# A\n\n## Behavior\nA.\n");
		await service.record({
			path: "docs/a.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "A contract.",
		});
		await service.relate({
			sourcePath: "docs/a.md",
			targetPath: "src/worker.ts",
			targetKind: "code",
			relationKind: "implements",
			action: "add",
		});
		rmSync(path.join(root, "src/worker.ts"));

		await expect(
			service.relate({
				sourcePath: "docs/a.md",
				targetPath: "src/worker.ts",
				targetKind: "code",
				relationKind: "implements",
				action: "remove",
			}),
		).resolves.toMatchObject({ path: "docs/a.md" });
		expect(
			await store.listKnowledgeRelations("project", { sourcePath: "docs/a.md" }),
		).toEqual([]);
		await store.close();
	});

	it("requires explicit primary semantics when promoting a non-primary document", async () => {
		const { root, store, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(path.join(root, "docs/info.md"), "# Info\n\nUsage notes.\n");
		await service.record({
			path: "docs/info.md",
			classification: "guide",
			summary: "Usage notes.",
		});

		await expect(
			service.record({
				path: "docs/info.md",
				classification: "spec",
				summary: "Now a contract.",
			}),
		).rejects.toThrow("requires --type");
		await store.close();
	});

	it("clears primary verification and relations on downgrade", async () => {
		const { root, store, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/a.ts"), "export {}\n");
		await writeFile(path.join(root, "docs/a.md"), "# A\n\n`src/a.ts`\n");
		await service.record({
			path: "docs/a.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "A.",
		});
		await service.verify("docs/a.md");
		await service.record({
			path: "docs/a.md",
			classification: "guide",
			summary: "Guide.",
		});
		const entry = await store.getKnowledgeEntry("project", "docs/a.md");
		expect(entry).toMatchObject({
			classification: "guide",
			verifiedSourceHash: undefined,
		});
		expect(await store.listKnowledgeRelations("project", { sourcePath: "docs/a.md" })).toEqual([]);
		await store.close();
	});

	it("discovers high-signal docs normally and low-signal docs in deep mode", async () => {
		const { root, store, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await mkdir(path.join(root, "notes"), { recursive: true });
		await writeFile(
			path.join(root, "docs/session-contract.md"),
			"# Session contract\n\n## Behavior\nRetry once.\n",
		);
		await writeFile(path.join(root, "notes/capture.txt"), "Duplicate capture returns original result.\n");

		expect((await service.discover()).map((item) => item.path)).toEqual([
			"docs/session-contract.md",
		]);
		expect(
			(await service.discover({ allUnclassified: true })).map((item) => item.path),
		).toEqual(["docs/session-contract.md", "notes/capture.txt"]);
		await store.close();
	});

	it("writes a compact catalog artifact and blocks direct symlink escape", async () => {
		const { root, store, service } = await setup();
		await mkdir(path.join(root, "docs"), { recursive: true });
		await writeFile(path.join(root, "docs/a.md"), "# A\n\n## Behavior\nA.\n");
		await service.record({
			path: "docs/a.md",
			classification: "spec",
			behaviorType: "as-is",
			lifecycle: "active",
			summary: "A contract.",
			topics: ["a"],
		});
		const audit = await service.audit();
		expect(audit.uncoveredActiveAsIsSpecs).toEqual(["docs/a.md"]);
		expect(audit.uncoveredActiveAsIsCount).toBe(1);
		const snapshot = await store.createSnapshot("project", {
			indexedAt: Date.now(),
			headCommit: "head",
		});
		const rendered = await service.renderCatalog(snapshot.id);
		expect(rendered).toContain("docs/a.md");
		expect(
			await store.getArtifact("project", snapshot.id, "knowledge_catalog", "project"),
		).not.toBeNull();

		const outside = tempDir();
		await writeFile(path.join(outside, "outside.md"), "# Outside\n");
		await symlink(path.join(outside, "outside.md"), path.join(root, "docs/escape.md"));
		await expect(
			service.record({
				path: "docs/escape.md",
				classification: "spec",
				behaviorType: "as-is",
				lifecycle: "active",
				summary: "No.",
			}),
		).rejects.toThrow("outside project root");
		await store.close();
	});
});

