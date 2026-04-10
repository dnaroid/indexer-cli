import { describe, expect, it, vi } from "vitest";
import {
	ContextPackBuilder,
	buildContextPackProfile,
	inferContextPackConfidenceBand,
	normalizeContextPackIntent,
	scoreContextPackModules,
} from "../../../src/engine/context-pack.js";
import type {
	ArtifactRecord,
	FileRecord,
	GitOperations,
	MetadataStore,
	SymbolRecord,
} from "../../../src/core/types.js";

function createMetadataMock(args: {
	files: FileRecord[];
	symbols: SymbolRecord[];
	artifact: ArtifactRecord;
}): MetadataStore {
	return {
		initialize: vi.fn(),
		close: vi.fn(),
		transaction: vi.fn(),
		createSnapshot: vi.fn(),
		getSnapshot: vi.fn(),
		getLatestSnapshot: vi.fn(),
		getLatestCompletedSnapshot: vi.fn(),
		listSnapshots: vi.fn(),
		updateSnapshotStatus: vi.fn(),
		updateSnapshotProgress: vi.fn(),
		upsertFile: vi.fn(),
		listFiles: vi.fn().mockResolvedValue(args.files),
		getFile: vi.fn(),
		replaceChunks: vi.fn(),
		listChunks: vi.fn(),
		replaceSymbols: vi.fn(),
		listSymbols: vi.fn().mockResolvedValue(args.symbols),
		searchSymbols: vi.fn(),
		replaceDependencies: vi.fn(),
		listDependencies: vi.fn(),
		getDependents: vi.fn(),
		upsertFileMetrics: vi.fn(),
		getFileMetrics: vi.fn(),
		listFileMetrics: vi.fn(),
		upsertArtifact: vi.fn(),
		getArtifact: vi.fn().mockResolvedValue(args.artifact),
		listArtifacts: vi.fn(),
		copyUnchangedFileData: vi.fn(),
		clearProjectMetadata: vi.fn(),
	};
}

describe("context-pack helpers", () => {
	it("normalizes task intent", () => {
		expect(normalizeContextPackIntent("fix changed scope output")).toBe(
			"bugfix",
		);
		expect(
			normalizeContextPackIntent("add context-pack skill generation"),
		).toBe("feature");
		expect(normalizeContextPackIntent("refactor ranking heuristics")).toBe(
			"refactor",
		);
		expect(normalizeContextPackIntent("look into skill refresh flow")).toBe(
			"investigation",
		);
		expect(normalizeContextPackIntent("context pack")).toBe("unknown");
	});

	it("builds profile defaults and parses scopes", () => {
		const defaults = buildContextPackProfile();
		expect(defaults.profile).toBe("balanced");
		expect(defaults.budget).toBe(1500);
		expect(defaults.maxModules).toBe(3);

		const routingFromBudget = buildContextPackProfile({ budget: 800 });
		expect(routingFromBudget.profile).toBe("routing");
		expect(routingFromBudget.maxFiles).toBe(4);

		const deep = buildContextPackProfile({
			profile: "deep",
			budget: 2500,
			maxFiles: 5,
			scope: "path-prefix:src/engine",
		});
		expect(deep.profile).toBe("deep");
		expect(deep.maxFiles).toBe(5);
		expect(deep.scope).toEqual({ kind: "path-prefix", value: "src/engine" });

		expect(() =>
			buildContextPackProfile({ budget: 800, profile: "deep" }),
		).toThrow("--budget 800 only matches the routing profile");
		expect(() => buildContextPackProfile({ scope: "path-prefix:" })).toThrow(
			"requires a non-empty path",
		);
	});

	it("scores modules from semantic and changed-file signals", () => {
		const scored = scoreContextPackModules([
			{
				module: "src/engine",
				maxSemanticScore: 0.92,
				hitCount: 2,
				symbolOverlap: 0.7,
				dependencyProximity: 0.6,
				pathPrior: 0.9,
				changedBoost: 1,
				fileCount: 3,
				reasons: ["semantic hits clustered in src/engine"],
			},
			{
				module: "src/cli",
				maxSemanticScore: 0.4,
				hitCount: 1,
				symbolOverlap: 0.2,
				dependencyProximity: 0,
				pathPrior: 0.1,
				changedBoost: 0,
				fileCount: 2,
				reasons: [],
			},
		]);

		expect(scored[0]?.module).toBe("src/engine");
		expect(scored[0]?.score).toBeGreaterThan(scored[1]?.score ?? 0);
		expect(inferContextPackConfidenceBand(scored[0]?.score ?? 0)).toBe("high");
	});
});

describe("ContextPackBuilder", () => {
	it("builds a routing pack from indexed signals", async () => {
		const files: FileRecord[] = [
			{
				snapshotId: "snap-1",
				path: "src/cli/commands/context-pack.ts",
				sha256: "1",
				mtimeMs: 1,
				size: 100,
				languageId: "typescript",
			},
			{
				snapshotId: "snap-1",
				path: "src/engine/context-pack.ts",
				sha256: "2",
				mtimeMs: 2,
				size: 120,
				languageId: "typescript",
			},
			{
				snapshotId: "snap-1",
				path: "src/cli/commands/search.ts",
				sha256: "3",
				mtimeMs: 3,
				size: 80,
				languageId: "typescript",
			},
		];
		const symbols: SymbolRecord[] = [
			{
				snapshotId: "snap-1",
				id: "sym-1",
				filePath: "src/engine/context-pack.ts",
				kind: "function",
				name: "buildContextPack",
				exported: true,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 20, character: 0 },
				},
				signature: "buildContextPack(task: string): ContextPackResult",
			},
			{
				snapshotId: "snap-1",
				id: "sym-2",
				filePath: "src/cli/commands/context-pack.ts",
				kind: "function",
				name: "registerContextPackCommand",
				exported: true,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 20, character: 0 },
				},
			},
		];
		const artifact: ArtifactRecord = {
			projectId: "default",
			snapshotId: "snap-1",
			artifactType: "architecture_snapshot",
			scope: "project",
			dataJson: JSON.stringify({
				structure: { name: "root", path: ".", type: "directory", children: [] },
				entrypoints: ["src/cli/commands/context-pack.ts"],
				dependencies: { "src/engine": 1 },
				dependency_map: {
					internal: {
						"src/cli": ["src/engine"],
						"src/engine": [],
					},
					external: {},
					builtin: {},
					unresolved: {},
				},
				file_stats: { typescript: 3 },
				files: files.map((file) => ({
					path: file.path,
					language: file.languageId,
				})),
				module_files: {
					"src/cli": [
						"src/cli/commands/context-pack.ts",
						"src/cli/commands/search.ts",
					],
					"src/engine": ["src/engine/context-pack.ts"],
				},
			}),
			updatedAt: 1,
		};
		const metadata = createMetadataMock({ files, symbols, artifact });
		const search = {
			search: vi
				.fn()
				.mockResolvedValueOnce([
					{
						filePath: "src/engine/context-pack.ts",
						startLine: 1,
						endLine: 10,
						score: 0.91,
						primarySymbol: "buildContextPack",
						chunkType: "impl",
					},
					{
						filePath: "src/cli/commands/context-pack.ts",
						startLine: 1,
						endLine: 10,
						score: 0.62,
						primarySymbol: "registerContextPackCommand",
						chunkType: "impl",
					},
				])
				.mockResolvedValueOnce([
					{
						filePath: "src/engine/context-pack.ts",
						startLine: 1,
						endLine: 10,
						score: 0.91,
						primarySymbol: "buildContextPack",
						chunkType: "impl",
						content: "export class ContextPackBuilder {}",
					},
				]),
		};
		const git: GitOperations = {
			getHeadCommit: vi.fn(),
			isDirty: vi.fn(),
			getChangedFiles: vi.fn(),
			getWorkingTreeChanges: vi.fn().mockResolvedValue({
				added: [],
				modified: ["src/engine/context-pack.ts"],
				deleted: [],
			}),
			getChurnByFile: vi.fn(),
		};

		const builder = new ContextPackBuilder(metadata, search, git, "/repo");
		const result = await builder.build(
			"default",
			"snap-1",
			"fix context pack routing",
			{
				profile: "deep",
				explainSymbols: true,
			},
		);

		expect(result.intent).toBe("bugfix");
		expect(result.selected_scope.pathPrefixes).toContain("src/engine");
		expect(result.module_goals[0]?.module).toBe("src/engine");
		expect(result.architecture_slice.relatedModules).toContain("src/cli");
		const engineSymbol = result.structure_slice.keySymbols.find(
			(symbol) => symbol.file === "src/engine/context-pack.ts",
		);
		expect(engineSymbol?.signature).toContain("ContextPackResult");
		expect(result.semantic_hits[0]?.snippet).toContain("ContextPackBuilder");
		expect(result.next_reads.length).toBeGreaterThan(0);
		expect(result._meta.profile).toBe("deep");
		expect(result._meta.estimatedTokens).toBeGreaterThan(0);
	});

	it("keeps routing profile compact and respects explicit scope", async () => {
		const files: FileRecord[] = [
			{
				snapshotId: "snap-1",
				path: "src/engine/context-pack.ts",
				sha256: "1",
				mtimeMs: 1,
				size: 100,
				languageId: "typescript",
			},
			{
				snapshotId: "snap-1",
				path: "src/cli/commands/context-pack.ts",
				sha256: "2",
				mtimeMs: 2,
				size: 100,
				languageId: "typescript",
			},
		];
		const symbols: SymbolRecord[] = [
			{
				snapshotId: "snap-1",
				id: "sym-1",
				filePath: "src/engine/context-pack.ts",
				kind: "function",
				name: "buildContextPack",
				exported: true,
				range: {
					start: { line: 1, character: 0 },
					end: { line: 5, character: 0 },
				},
			},
		];
		const artifact: ArtifactRecord = {
			projectId: "default",
			snapshotId: "snap-1",
			artifactType: "architecture_snapshot",
			scope: "project",
			dataJson: JSON.stringify({
				structure: { name: "root", path: ".", type: "directory", children: [] },
				entrypoints: ["src/engine/context-pack.ts"],
				dependencies: { "src/cli": 1 },
				dependency_map: {
					internal: {
						"src/engine": [],
						"src/cli": ["src/engine"],
					},
					external: {},
					builtin: {},
					unresolved: {},
				},
				file_stats: { typescript: 2 },
				files: files.map((file) => ({
					path: file.path,
					language: file.languageId,
				})),
				module_files: {
					"src/engine": ["src/engine/context-pack.ts"],
					"src/cli": ["src/cli/commands/context-pack.ts"],
				},
			}),
			updatedAt: 1,
		};
		const metadata = createMetadataMock({ files, symbols, artifact });
		const search = {
			search: vi.fn().mockResolvedValue([
				{
					filePath: "src/engine/context-pack.ts",
					startLine: 1,
					endLine: 5,
					score: 0.9,
					primarySymbol: "buildContextPack",
					chunkType: "impl",
				},
			]),
		};
		const git: GitOperations = {
			getHeadCommit: vi.fn(),
			isDirty: vi.fn(),
			getChangedFiles: vi.fn(),
			getWorkingTreeChanges: vi.fn().mockResolvedValue({
				added: [],
				modified: ["src/cli/commands/context-pack.ts"],
				deleted: [],
			}),
			getChurnByFile: vi.fn(),
		};

		const builder = new ContextPackBuilder(metadata, search, git, "/repo");
		const result = await builder.build(
			"default",
			"snap-1",
			"fix context pack routing",
			{
				budget: 800,
				scope: "path-prefix:src/engine",
			},
		);

		expect(result._meta.profile).toBe("routing");
		expect(result.selected_scope.pathPrefixes).toEqual(["src/engine"]);
		expect(result.architecture_slice).toEqual({
			entrypoints: [],
			relatedModules: [],
			dependencies: [],
		});
		expect(result.structure_slice).toEqual({ files: [], keySymbols: [] });
		expect(result.semantic_hits).toEqual([]);
	});

	it("returns low-confidence empty result when explicit scope matches nothing", async () => {
		const files: FileRecord[] = [
			{
				snapshotId: "snap-1",
				path: "src/engine/context-pack.ts",
				sha256: "1",
				mtimeMs: 1,
				size: 100,
				languageId: "typescript",
			},
		];
		const artifact: ArtifactRecord = {
			projectId: "default",
			snapshotId: "snap-1",
			artifactType: "architecture_snapshot",
			scope: "project",
			dataJson: JSON.stringify({
				structure: { name: "root", path: ".", type: "directory", children: [] },
				entrypoints: [],
				dependencies: {},
				dependency_map: {
					internal: { "src/engine": [] },
					external: {},
					builtin: {},
					unresolved: {},
				},
				file_stats: { typescript: 1 },
				files: [{ path: "src/engine/context-pack.ts", language: "typescript" }],
				module_files: {
					"src/engine": ["src/engine/context-pack.ts"],
				},
			}),
			updatedAt: 1,
		};
		const metadata = createMetadataMock({ files, symbols: [], artifact });
		const builder = new ContextPackBuilder(
			metadata,
			{ search: vi.fn() },
			{
				getHeadCommit: vi.fn(),
				isDirty: vi.fn(),
				getChangedFiles: vi.fn(),
				getWorkingTreeChanges: vi.fn().mockResolvedValue({
					added: [],
					modified: [],
					deleted: [],
				}),
				getChurnByFile: vi.fn(),
			},
			"/repo",
		);

		const result = await builder.build(
			"default",
			"snap-1",
			"fix context pack routing",
			{ scope: "path-prefix:src/cli" },
		);

		expect(result.selected_scope.pathPrefixes).toEqual([]);
		expect(result.selected_scope.confidence).toBe(0.1);
		expect(result.selected_scope.why).toContain(
			"No indexed files matched the requested explicit scope.",
		);
		expect(result.next_reads).toEqual([]);
	});
});
