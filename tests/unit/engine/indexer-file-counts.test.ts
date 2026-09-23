import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, DEFAULT_CONFIG } from "../../../src/core/config.js";
import type {
	EmbeddingProvider,
	GitDiff,
	GitOperations,
} from "../../../src/core/types.js";
import { IndexerEngine } from "../../../src/engine/indexer.js";
import { TypeScriptPlugin } from "../../../src/languages/typescript.js";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { SqliteVecVectorStore } from "../../../src/storage/vectors.js";

class FakeEmbeddingProvider implements EmbeddingProvider {
	readonly id = "fake";
	async initialize(): Promise<void> {}
	async close(): Promise<void> {}
	getDimension(): number {
		return 3;
	}
	async embed(texts: string[]): Promise<number[][]> {
		if (texts.some((text) => text.includes("BROKEN_DOCUMENT"))) {
			throw new Error("document embedding failed");
		}
		return texts.map((text) => [1, 1 + text.length % 17, 1]);
	}
}

const emptyDiff = (): GitDiff => ({ added: [], modified: [], deleted: [] });
const projectId = "file-counts";

describe("IndexerEngine file counts across code and documents", () => {
	const resources: Array<{ root: string; engine: IndexerEngine }> = [];

	beforeEach(() => {
		const values = {
			...DEFAULT_CONFIG,
			embeddingProvider: "fake",
			vectorSize: 3,
			indexBatchSize: 1,
		};
		vi.spyOn(config, "get").mockImplementation((key) => values[key]);
	});

	afterEach(async () => {
		for (const { root, engine } of resources.splice(0)) {
			await engine.close();
			rmSync(root, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	async function createProject(files: Record<string, string>) {
		const root = mkdtempSync(join(tmpdir(), "idx-file-counts-"));
		const write = (filePath: string, content: string) => {
			mkdirSync(dirname(join(root, filePath)), { recursive: true });
			writeFileSync(join(root, filePath), content);
		};
		for (const [filePath, content] of Object.entries(files)) {
			write(filePath, content);
		}
		const dbPath = join(root, "db.sqlite");
		const metadata = new SqliteMetadataStore(dbPath);
		const vectors = new SqliteVecVectorStore({ dbPath, vectorSize: 3 });
		const git: GitOperations = {
			getHeadCommit: async () => "head",
			isDirty: async () => false,
			getChangedFiles: async () => emptyDiff(),
			getWorkingTreeChanges: async () => emptyDiff(),
			getChurnByFile: async () => ({}),
		};
		const engine = new IndexerEngine({
			projectId,
			repoRoot: root,
			metadata,
			knowledgeStore: metadata,
			vectors,
			embedder: new FakeEmbeddingProvider(),
			git,
			languagePlugins: [new TypeScriptPlugin()],
		});
		resources.push({ root, engine });
		await engine.initialize();
		return { root, engine, metadata, vectors, write };
	}

	function callbacks() {
		return {
			onProgress: vi.fn<(processed: number, total: number) => void>(),
			onFileStart:
				vi.fn<(filePath: string, current: number, total: number) => void>(),
		};
	}

	async function expectCompleted(
		metadata: SqliteMetadataStore,
		snapshotId: string,
		total: number,
		observed: ReturnType<typeof callbacks>,
	) {
		expect(await metadata.getSnapshot(snapshotId)).toMatchObject({
			status: "completed",
			processedFiles: total,
			totalFiles: total,
		});
		const storedFiles = [
			...(await metadata.listFiles(projectId, snapshotId)),
			...(await metadata.listFiles(projectId, snapshotId, { domain: "document" })),
		];
		expect(storedFiles).toHaveLength(total);
		const progress = observed.onProgress.mock.calls;
		expect(progress.at(-1)).toEqual([total, total]);
		for (const [index, [processed, reportedTotal]] of progress.entries()) {
			expect(reportedTotal).toBe(total);
			expect(processed).toBeGreaterThanOrEqual(
				index === 0 ? 0 : progress[index - 1]![0],
			);
			expect(processed).toBeLessThanOrEqual(total);
		}
	}

	it("counts code and documents in a full run and reports both per-file callbacks", async () => {
		const { engine, metadata } = await createProject({
			"src/main.ts": "export const value = 1;",
			"README.md": "# Project\n\nProject overview.",
			"docs/usage.md": "# Usage\n\nRun the project.",
		});
		const observed = callbacks();
		const result = await engine.indexProject({
			isFullReindex: true,
			...observed,
		});
		expect(result).toMatchObject({ filesIndexed: 3, errors: [] });
		expect(observed.onFileStart.mock.calls.map(([file]) => file).sort()).toEqual([
			"README.md",
			"docs/usage.md",
			"src/main.ts",
		]);
		expect(
			observed.onFileStart.mock.calls.map(([, current, total]) => [current, total]),
		).toEqual([
			[1, 3],
			[2, 3],
			[3, 3],
		]);
		await expectCompleted(metadata, result.snapshotId, 3, observed);
	});

	it("counts a documentation-only project and advances progress for every document", async () => {
		const { engine, metadata } = await createProject({
			"README.md": "# Project\n\nOverview.",
			"docs/usage.txt": "Use this project.",
		});
		const observed = callbacks();
		const result = await engine.indexProject({
			isFullReindex: true,
			...observed,
		});
		expect(result).toMatchObject({ filesIndexed: 2, errors: [] });
		expect(
			observed.onFileStart.mock.calls.map(([, current, total]) => [current, total]),
		).toEqual([
			[1, 2],
			[2, 2],
		]);
		expect(observed.onProgress.mock.calls).toContainEqual([1, 2]);
		await expectCompleted(metadata, result.snapshotId, 2, observed);
	});

	it("reports zero progress without file starts for an empty full run", async () => {
		const { engine, metadata } = await createProject({});
		const observed = callbacks();
		const result = await engine.indexProject({ isFullReindex: true, ...observed });
		expect(result.filesIndexed).toBe(0);
		expect(observed.onFileStart).not.toHaveBeenCalled();
		expect(observed.onProgress.mock.calls).toEqual([[0, 0]]);
		await expectCompleted(metadata, result.snapshotId, 0, observed);
	});

	it("counts only changed code and documents while progress includes carried files", async () => {
		const { engine, metadata, write } = await createProject({
			"src/main.ts": "export const value = 1;",
			"src/stable.ts": "export const stable = true;",
			"docs/changed.md": "# Changed\n\nBefore.",
			"docs/stable.md": "# Stable\n\nUnchanged.",
		});
		await engine.indexProject({ isFullReindex: true });
		write("src/main.ts", "export const value = 2;");
		write("docs/changed.md", "# Changed\n\nAfter.");
		const observed = callbacks();
		const result = await engine.indexProject({
			isFullReindex: false,
			changedFiles: {
				...emptyDiff(),
				modified: ["src/main.ts", "docs/changed.md"],
			},
			...observed,
		});
		expect(result).toMatchObject({ filesIndexed: 2, errors: [] });
		expect(observed.onFileStart.mock.calls.map(([file]) => file).sort()).toEqual([
			"docs/changed.md",
			"src/main.ts",
		]);
		expect(observed.onProgress.mock.calls).toEqual([[3, 4], [4, 4]]);
		expect(
			observed.onFileStart.mock.calls.map(([, current, total]) => [current, total]),
		).toEqual([
			[3, 4],
			[4, 4],
		]);
		await expectCompleted(metadata, result.snapshotId, 4, observed);
		expect(
			await metadata.getFile(projectId, result.snapshotId, "src/main.ts"),
		).toMatchObject({
			sha256: createHash("sha256")
				.update("export const value = 2;")
				.digest("hex"),
		});
		expect(
			await metadata.getFile(projectId, result.snapshotId, "docs/changed.md", {
				domain: "document",
			}),
		).toMatchObject({
			sha256: createHash("sha256").update("# Changed\n\nAfter.").digest("hex"),
		});
		expect(
			(await metadata.listKnowledgeChunks(
				projectId,
				result.snapshotId,
				"docs/changed.md",
			))
				.map((chunk) => chunk.metadata?.searchText)
				.join("\n"),
		).toContain("After.");
		expect(
			await metadata.listKnowledgeChunks(
				projectId,
				result.snapshotId,
				"docs/stable.md",
			),
		).not.toEqual([]);
	});

	it("reports one indexed file for a document-only change in a mixed project", async () => {
		const { engine, metadata, write } = await createProject({
			"src/a.ts": "export const a = 1;",
			"src/b.ts": "export const b = 2;",
			"README.md": "# Before",
		});
		await engine.indexProject({ isFullReindex: true });
		write("README.md", "# After");
		const observed = callbacks();
		const result = await engine.indexProject({
			isFullReindex: false,
			changedFiles: { ...emptyDiff(), modified: ["README.md"] },
			...observed,
		});
		expect(result.filesIndexed).toBe(1);
		expect(observed.onFileStart.mock.calls).toEqual([["README.md", 3, 3]]);
		await expectCompleted(metadata, result.snapshotId, 3, observed);
	});

	it("counts additions but not deletions, and excludes deleted files from the total", async () => {
		const { root, engine, metadata, write } = await createProject({
			"src/old.ts": "export const old = 1;",
			"src/stable.ts": "export const stable = 1;",
			"docs/old.md": "# Old",
			"docs/stable.md": "# Stable",
		});
		await engine.indexProject({ isFullReindex: true });
		rmSync(join(root, "src/old.ts"));
		rmSync(join(root, "docs/old.md"));
		write("src/new.ts", "export const added = 2;");
		write("docs/new.md", "# New");
		const observed = callbacks();
		const result = await engine.indexProject({
			isFullReindex: false,
			changedFiles: {
				added: ["src/new.ts", "docs/new.md"],
				modified: [],
				deleted: ["src/old.ts", "docs/old.md"],
			},
			...observed,
		});
		expect(result.filesIndexed).toBe(2);
		await expectCompleted(metadata, result.snapshotId, 4, observed);
		expect(
			(await metadata.listFiles(projectId, result.snapshotId)).map(
				(file) => file.path,
			),
		).toEqual(["src/new.ts", "src/stable.ts"]);
		expect(
			(await metadata.listFiles(projectId, result.snapshotId, {
				domain: "document",
			})).map((file) => file.path),
		).toEqual(["docs/new.md", "docs/stable.md"]);
	});

	it.each(["unchanged", "unsupported", "deletion"])(
		"reports zero new indexed files for an %s-only incremental run",
		async (kind) => {
			const { root, engine, metadata, write } = await createProject({
				"src/main.ts": "export const value = 1;",
				"README.md": "# Project",
			});
			await engine.indexProject({ isFullReindex: true });
			const changedFiles = emptyDiff();
			if (kind === "unsupported") {
				write("image.svg", "<svg />");
				changedFiles.added.push("image.svg");
			} else if (kind === "deletion") {
				rmSync(join(root, "README.md"));
				changedFiles.deleted.push("README.md");
			}
			const observed = callbacks();
			const result = await engine.indexProject({
				isFullReindex: false,
				changedFiles,
				...observed,
			});
			expect(result.filesIndexed).toBe(0);
			expect(observed.onFileStart).not.toHaveBeenCalled();
			expect(observed.onProgress.mock.calls).toEqual([
				[kind === "deletion" ? 1 : 2, kind === "deletion" ? 1 : 2],
			]);
			await expectCompleted(
				metadata,
				result.snapshotId,
				kind === "deletion" ? 1 : 2,
				observed,
			);
		},
	);

	it("does not include a document whose embedding failed in filesIndexed", async () => {
		const { engine } = await createProject({
			"src/main.ts": "export const value = 1;",
			"docs/broken.md": "# BROKEN_DOCUMENT\n\nEmbedding must fail.",
			"docs/working.md": "# Working\n\nEmbedding succeeds.",
		});
		const result = await engine.indexProject({ isFullReindex: true });
		expect(result.filesIndexed).toBe(2);
		expect(result.errors).toEqual([
			"document: docs/broken.md: document embedding failed",
		]);
	});
});
