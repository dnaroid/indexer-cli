import { describe, expect, it, vi } from "vitest";
import { ArchitectureGenerator } from "../../../src/engine/architecture.js";
import type {
	DependencyRecord,
	FileRecord,
	MetadataStore,
} from "../../../src/core/types.js";
import type { LanguagePlugin } from "../../../src/languages/plugin.js";

function createMetadataStoreMock(
	files: FileRecord[],
	dependencies: DependencyRecord[],
): MetadataStore {
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
		listFiles: vi.fn().mockResolvedValue(files),
		getFile: vi.fn(),
		replaceChunks: vi.fn(),
		listChunks: vi.fn(),
		replaceSymbols: vi.fn(),
		listSymbols: vi.fn(),
		searchSymbols: vi.fn(),
		replaceDependencies: vi.fn(),
		listDependencies: vi.fn().mockResolvedValue(dependencies),
		getDependents: vi.fn(),
		upsertFileMetrics: vi.fn(),
		getFileMetrics: vi.fn(),
		listFileMetrics: vi.fn(),
		upsertArtifact: vi.fn().mockResolvedValue(undefined),
		getArtifact: vi.fn(),
		listArtifacts: vi.fn(),
		copyUnchangedFileData: vi.fn(),
		clearProjectMetadata: vi.fn(),
	};
}

describe("ArchitectureGenerator", () => {
	it("generates an architecture_snapshot with structure, file stats, entrypoints, and categorized dependencies", async () => {
		const files: FileRecord[] = [
			{
				snapshotId: "snap-1",
				path: "apps/web/src/index.ts",
				sha256: "1",
				mtimeMs: 1,
				size: 100,
				languageId: "typescript",
			},
			{
				snapshotId: "snap-1",
				path: "apps/web/src/components/Button.tsx",
				sha256: "2",
				mtimeMs: 2,
				size: 50,
				languageId: "typescript",
			},
			{
				snapshotId: "snap-1",
				path: "apps/web/tests/app.test.ts",
				sha256: "3",
				mtimeMs: 3,
				size: 25,
				languageId: "typescript",
			},
			{
				snapshotId: "snap-1",
				path: "apps/web/fixtures/mock.ts",
				sha256: "4",
				mtimeMs: 4,
				size: 10,
				languageId: "typescript",
			},
			{
				snapshotId: "snap-1",
				path: "packages/shared/src/util.ts",
				sha256: "5",
				mtimeMs: 5,
				size: 80,
				languageId: "typescript",
			},
			{
				snapshotId: "snap-1",
				path: "scripts/build.js",
				sha256: "6",
				mtimeMs: 6,
				size: 30,
				languageId: "javascript",
			},
			{
				snapshotId: "snap-1",
				path: "docs/notes.txt",
				sha256: "7",
				mtimeMs: 7,
				size: 5,
				languageId: "",
			},
		];

		const dependencies: DependencyRecord[] = [
			{
				snapshotId: "snap-1",
				id: "dep-1",
				fromPath: "apps/web/src/index.ts",
				toSpecifier: "../shared/util",
				toPath: "packages/shared/dist/util.js",
				kind: "import",
				dependencyType: "internal",
			},
			{
				snapshotId: "snap-1",
				id: "dep-2",
				fromPath: "apps/web/src/index.ts",
				toSpecifier: "./components/Button",
				toPath: "apps/web/src/components/Button.tsx",
				kind: "import",
				dependencyType: "internal",
			},
			{
				snapshotId: "snap-1",
				id: "dep-3",
				fromPath: "apps/web/src/index.ts",
				toSpecifier: "react",
				kind: "import",
				dependencyType: "external",
			},
			{
				snapshotId: "snap-1",
				id: "dep-4",
				fromPath: "apps/web/src/index.ts",
				toSpecifier: "node:path",
				kind: "import",
				dependencyType: "builtin",
			},
			{
				snapshotId: "snap-1",
				id: "dep-5",
				fromPath: "apps/web/src/index.ts",
				toSpecifier: "@/missing",
				kind: "import",
				dependencyType: "unresolved",
			},
			{
				snapshotId: "snap-1",
				id: "dep-6",
				fromPath: "packages/shared/src/util.ts",
				toSpecifier: "zod",
				kind: "import",
				dependencyType: "external",
			},
		];

		const metadata = createMetadataStoreMock(files, dependencies);
		const entrypointPlugin: LanguagePlugin = {
			id: "test-plugin",
			displayName: "Test Plugin",
			fileExtensions: [".ts", ".tsx", ".js"],
			getEntrypoints: vi.fn((filePaths: string[]) => [
				filePaths[0],
				"packages/shared/src/util.ts",
				filePaths[0],
			]),
			parse: vi.fn(),
			extractSymbols: vi.fn().mockReturnValue([]),
			extractImports: vi.fn().mockReturnValue([]),
			splitIntoChunks: vi.fn().mockReturnValue([]),
		};

		const generator = new ArchitectureGenerator(metadata, [entrypointPlugin]);

		await generator.generate("project-1", "snap-1");

		expect(metadata.listFiles).toHaveBeenCalledWith("project-1", "snap-1");
		expect(metadata.listDependencies).toHaveBeenCalledWith(
			"project-1",
			"snap-1",
		);
		expect(entrypointPlugin.getEntrypoints).toHaveBeenCalledWith([
			"apps/web/src/index.ts",
			"apps/web/src/components/Button.tsx",
			"packages/shared/src/util.ts",
			"scripts/build.js",
		]);

		expect(metadata.upsertArtifact).toHaveBeenCalledTimes(1);
		const artifact = vi.mocked(metadata.upsertArtifact).mock.calls[0]?.[1];
		expect(artifact?.artifactType).toBe("architecture_snapshot");
		expect(artifact?.scope).toBe("project");

		const data = JSON.parse(artifact?.dataJson ?? "{}");
		expect(data.file_stats).toEqual({
			javascript: 1,
			typescript: 5,
			unknown: 1,
		});
		expect(data.entrypoints).toEqual([
			"apps/web/src/index.ts",
			"packages/shared/src/util.ts",
		]);
		expect(data.dependency_map).toEqual({
			internal: {
				"apps/web": ["packages/shared"],
			},
			external: {
				"apps/web": ["react"],
				"packages/shared": ["zod"],
			},
			builtin: {
				"apps/web": ["node:path"],
			},
			unresolved: {
				"apps/web": ["@/missing"],
			},
		});
		expect(data.dependencies).toEqual({
			"@/missing": 1,
			"node:path": 1,
			"packages/shared": 1,
			react: 1,
			zod: 1,
		});

		const appsNode = data.structure.children.find(
			(node: { path: string }) => node.path === "apps",
		);
		expect(appsNode).toBeDefined();
		expect(JSON.stringify(data.structure)).toContain("apps/web/src/index.ts");
		expect(JSON.stringify(data.structure)).toContain(
			"packages/shared/src/util.ts",
		);
	});

	it("canonicalizes dist .js dependencies to .tsx sources and groups simple folders by first two path segments", async () => {
		const files: FileRecord[] = [
			{
				snapshotId: "snap-2",
				path: "packages/ui/src/app.ts",
				sha256: "1",
				mtimeMs: 1,
				size: 10,
				languageId: "typescript",
			},
			{
				snapshotId: "snap-2",
				path: "packages/ui/src/components/Button.tsx",
				sha256: "2",
				mtimeMs: 2,
				size: 10,
				languageId: "typescript",
			},
		];

		const dependencies: DependencyRecord[] = [
			{
				snapshotId: "snap-2",
				id: "dep-1",
				fromPath: "packages/ui/src/app.ts",
				toSpecifier: "./components/Button",
				toPath: "packages/ui/dist/components/Button.js",
				kind: "import",
				dependencyType: "internal",
			},
		];

		const metadata = createMetadataStoreMock(files, dependencies);
		const generator = new ArchitectureGenerator(metadata, []);

		await generator.generate("project-2", "snap-2");

		const artifact = vi.mocked(metadata.upsertArtifact).mock.calls[0]?.[1];
		const data = JSON.parse(artifact?.dataJson ?? "{}");

		expect(data.dependency_map).toEqual({
			internal: {},
			external: {},
			builtin: {},
			unresolved: {},
		});
		expect(data.dependencies).toEqual({});
	});

	it("covers canonicalizePath and getModuleKey helper branches directly", () => {
		const generator = new ArchitectureGenerator(
			createMetadataStoreMock([], []),
			[],
		);

		expect(
			(generator as any).canonicalizePath(
				"packages/ui/dist/components/Button.js",
				new Set(["packages/ui/src/components/Button.tsx"]),
			),
		).toBe("packages/ui/src/components/Button.tsx");
		expect(
			(generator as any).canonicalizePath(
				"packages/ui/dist/components/Button.js",
				new Set(),
			),
		).toBe("packages/ui/dist/components/Button.js");
		expect((generator as any).getModuleKey("src/index.ts")).toBe(
			"src/index.ts",
		);
		expect((generator as any).getModuleKey("README.md")).toBe("root");
	});
});
