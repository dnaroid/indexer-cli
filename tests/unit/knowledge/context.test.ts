import { describe, expect, it } from "vitest";
import type {
	KnowledgeRelation,
	KnowledgeStore,
	MetadataStore,
} from "../../../src/core/types.js";
import {
	KnowledgeContextEngine,
	formatKnowledgeContext,
} from "../../../src/knowledge/context.js";
import type { KnowledgeSearchResult } from "../../../src/knowledge/search.js";

const SPEC: KnowledgeSearchResult = {
	path: "docs/auth.md",
	title: "Auth session contract",
	authority: "registered",
	classification: "spec",
	behaviorType: "as-is",
	lifecycle: "active",
	status: "fresh",
	trust: "verified",
	score: 18,
	semanticScore: 0.9,
	lexicalScore: 7,
	summary: "Refresh tokens are rotated once and failures propagate.",
	topics: ["auth", "refresh"],
	reasonCodes: ["semantic", "title:1"],
	bestRanges: [{ startLine: 10, endLine: 24, score: 0.9 }],
};

const UNREVIEWED: KnowledgeSearchResult = {
	path: "docs/draft-auth-notes.md",
	title: "Draft auth notes",
	authority: "unreviewed-indexed",
	classification: "unclassified",
	behaviorType: "unknown",
	lifecycle: "unknown",
	status: "unreviewed",
	trust: "default",
	score: 6,
	semanticScore: 0,
	lexicalScore: 6,
	summary: "Retry behavior noted in an indexed document that has not been reviewed.",
	topics: [],
	reasonCodes: ["unreviewed-indexed", "body:1.00"],
	bestRanges: [{ startLine: 4, endLine: 8, score: 1 }],
};

const UNREVIEWED_TWO: KnowledgeSearchResult = {
	...UNREVIEWED,
	path: "docs/draft-session-notes.md",
	title: "Draft session notes",
	summary: "Indexed session notes that have not been reviewed.",
	bestRanges: [{ startLine: 12, endLine: 18, score: 0.8 }],
};

function relation(
	targetPath: string,
	relationKind: KnowledgeRelation["relationKind"],
	targetKind: KnowledgeRelation["targetKind"] = "code",
): KnowledgeRelation {
	return {
		projectId: "default",
		sourcePath: SPEC.path,
		targetPath,
		targetKind,
		relationKind,
		provenance: "explicit",
	};
}

describe("KnowledgeContextEngine", () => {
	it("merges primary knowledge, tracked implementation, semantic ranges, and tests", async () => {
		const relations = [
			relation("src/auth/refresh.ts", "implements"),
			relation("tests/auth/refresh.test.ts", "tests"),
			relation("docs/auth-v1.md", "supersedes", "knowledge"),
		];
		const knowledge = {
			listKnowledgeRelations: async () => relations,
		} as unknown as KnowledgeStore;
		const metadata = {
			listFiles: async () => [
				{
					snapshotId: "snap",
					path: "src/auth/refresh.ts",
					sha256: "a",
					mtimeMs: 1,
					size: 1,
					languageId: "typescript",
				},
				{
					snapshotId: "snap",
					path: "tests/auth/refresh.test.ts",
					sha256: "b",
					mtimeMs: 1,
					size: 1,
					languageId: "typescript",
				},
			],
			listDependencies: async () => [
				{
					snapshotId: "snap",
					id: "dep",
					fromPath: "tests/auth/refresh.test.ts",
					toSpecifier: "../../src/auth/refresh",
					toPath: "src/auth/refresh.ts",
					kind: "import",
					dependencyType: "internal",
				},
				{
					snapshotId: "snap",
					id: "dep-code",
					fromPath: "src/auth/refresh.ts",
					toSpecifier: "./session",
					toPath: "src/auth/session.ts",
					kind: "import",
					dependencyType: "internal",
				},
			],
		} as unknown as MetadataStore;
		const engine = new KnowledgeContextEngine(
			"default",
			"snap",
			metadata,
			knowledge,
			{ search: async () => [SPEC] },
			{
				search: async () => [
					{
						filePath: "src/auth/refresh.ts",
						startLine: 30,
						endLine: 55,
						score: 1.8,
						reasonCode: "semantic+text",
					},
				],
			},
		);

		const pack = await engine.build("how refresh token retry works");
		expect(pack.specs).toEqual([SPEC]);
		expect(pack.implementation).toEqual([
			{
				path: "src/auth/refresh.ts",
				startLine: 30,
				endLine: 55,
				score: 1.8,
				reason: "tracked+semantic",
			},
			{
				path: "src/auth/session.ts",
				startLine: undefined,
				endLine: undefined,
				score: undefined,
				reason: "graph",
			},
		]);
		expect(pack.tests[0]).toEqual({
			path: "tests/auth/refresh.test.ts",
			reason: "explicit",
			confidence: "high",
		});
		expect(pack.relations).toHaveLength(3);
		expect(pack.warnings).toEqual([]);
		expect(pack.readNext).toContain("docs/auth.md:10-24");
		expect(pack.readNext).toContain("src/auth/refresh.ts:30-55");
		expect(pack.readNext).toContain("src/auth/session.ts");
	});

	it("surfaces non-fresh knowledge and keeps formatted output bounded", async () => {
		const stale = { ...SPEC, status: "inputs-changed" as const, trust: "default" as const };
		const engine = new KnowledgeContextEngine(
			"default",
			"snap",
			{
				listFiles: async () => [],
				listDependencies: async () => [],
			} as unknown as MetadataStore,
			{ listKnowledgeRelations: async () => [] } as unknown as KnowledgeStore,
			{ search: async () => [stale] },
			{ search: async () => [] },
		);
		const pack = await engine.build("auth refresh");
		expect(pack.warnings).toEqual([
			"docs/auth.md: inputs-changed; trusted by default, verification may be stale or absent",
		]);

		const output = formatKnowledgeContext(pack, 200);
		expect(output).toContain("docs/auth.md: inputs-changed");
		expect(output).toContain("Primary knowledge:");
		expect(output).toContain("Read: docs/auth.md:10-24");
	});

	it("keeps unreviewed indexed documents separate from primary knowledge", async () => {
		const engine = new KnowledgeContextEngine(
			"default",
			"snap",
			{
				listFiles: async () => [],
				listDependencies: async () => [],
			} as unknown as MetadataStore,
			{ listKnowledgeRelations: async () => [] } as unknown as KnowledgeStore,
			{ search: async () => [UNREVIEWED, UNREVIEWED_TWO] },
			{ search: async () => [] },
		);

		const pack = await engine.build("auth retry behavior", { maxSpecs: 2 });
		expect(pack.specs).toEqual([]);
		expect(pack.unreviewed).toEqual([UNREVIEWED, UNREVIEWED_TWO]);
		expect(pack.relations).toEqual([]);
		expect(pack.warnings).toContain(
			"docs/draft-auth-notes.md: trusted by default but unreviewed indexed document; content may be stale or incorrect",
		);
		expect(pack.warnings).toContain(
			"No registered primary knowledge matched the query; using 2 default-trusted unreviewed indexed documents as knowledge evidence.",
		);
		expect(pack.readNext).toContain("docs/draft-auth-notes.md:4-8");
		expect(pack.readNext).toContain("docs/draft-session-notes.md:12-18");

		const output = formatKnowledgeContext(pack, 300);
		expect(output).toContain("Indexed knowledge (unreviewed):");
		expect(output).toContain("Read (unreviewed): docs/draft-auth-notes.md:4-8");
		expect(output).not.toContain("Primary knowledge:");
	});

	it("shows unreviewed fallback alongside primary knowledge without using its relations", async () => {
		const relations = [relation("src/auth/refresh.ts", "implements")];
		const engine = new KnowledgeContextEngine(
			"default",
			"snap",
			{
				listFiles: async () => [],
				listDependencies: async () => [],
			} as unknown as MetadataStore,
			{ listKnowledgeRelations: async () => relations } as unknown as KnowledgeStore,
			{ search: async () => [SPEC, UNREVIEWED] },
			{ search: async () => [] },
		);

		const pack = await engine.build("auth retry behavior", { maxSpecs: 1 });
		expect(pack.specs).toEqual([SPEC]);
		expect(pack.unreviewed).toEqual([UNREVIEWED]);
		expect(pack.relations).toEqual(relations);
		expect(pack.warnings).toContain(
			"docs/draft-auth-notes.md: trusted by default but unreviewed indexed document; content may be stale or incorrect",
		);
	});

	it("omits relation targets that are absent from the current code index", async () => {
		const relations = [
			relation("src/auth/refresh.ts", "implements"),
			relation("dist/main.js", "implements"),
			relation(".pi/tasks.test.ts", "tests"),
		];
		const engine = new KnowledgeContextEngine(
			"default",
			"snap",
			{
				listFiles: async () => [
					{
						snapshotId: "snap",
						path: "src/auth/refresh.ts",
						sha256: "a",
						mtimeMs: 1,
						size: 1,
						languageId: "typescript",
					},
				],
				listDependencies: async () => [],
			} as unknown as MetadataStore,
			{ listKnowledgeRelations: async () => relations } as unknown as KnowledgeStore,
			{ search: async () => [SPEC] },
			{ search: async () => [] },
		);

		const pack = await engine.build("auth refresh");
		expect(pack.implementation.map((item) => item.path)).toEqual([
			"src/auth/refresh.ts",
		]);
		expect(pack.tests).toEqual([]);
		expect(pack.readNext).not.toContain("dist/main.js");
		expect(pack.readNext).not.toContain(".pi/tasks.test.ts");
	});

	it("still returns useful code context when no primary knowledge matches", async () => {
		const engine = new KnowledgeContextEngine(
			"default",
			"snap",
			{
				listFiles: async () => [
					{
						snapshotId: "snap",
						path: "src/telemetry/format.ts",
						sha256: "a",
						mtimeMs: 1,
						size: 1,
						languageId: "typescript",
					},
				],
				listDependencies: async () => [],
			} as unknown as MetadataStore,
			{ listKnowledgeRelations: async () => [] } as unknown as KnowledgeStore,
			{ search: async () => [] },
			{
				search: async () => [
					{
						filePath: "src/telemetry/format.ts",
						startLine: 8,
						endLine: 22,
						score: 1.4,
						reasonCode: "semantic+text",
					},
				],
			},
		);

		const pack = await engine.build("telemetry label formatting");
		expect(pack.specs).toEqual([]);
		expect(pack.implementation).toEqual([
			{
				path: "src/telemetry/format.ts",
				startLine: 8,
				endLine: 22,
				score: 1.4,
				reason: "semantic",
			},
		]);
		expect(pack.warnings).toContain("No primary knowledge matched the query.");
		expect(pack.readNext).toContain("src/telemetry/format.ts:8-22");
	});

	it("ranks a late relevant implementation and its direct test ahead of broad paths", async () => {
		const files = Array.from({ length: 50 }, (_, index) => ({
			snapshotId: "snap", path: `src/a${index}/unrelated.ts`, sha256: `${index}`, mtimeMs: 1, size: 1, languageId: "typescript",
		}));
		files.push(
			{ snapshotId: "snap", path: "src/z/payment-refund.ts", sha256: "target", mtimeMs: 1, size: 1, languageId: "typescript" },
			{ snapshotId: "snap", path: "tests/z/payment-refund.test.ts", sha256: "test", mtimeMs: 1, size: 1, languageId: "typescript" },
		);
		const engine = new KnowledgeContextEngine("default", "snap", {
			listFiles: async () => files,
			listDependencies: async () => [{ snapshotId: "snap", id: "test", fromPath: "tests/z/payment-refund.test.ts", toSpecifier: "../../src/z/payment-refund", toPath: "src/z/payment-refund.ts", kind: "import", dependencyType: "internal" }],
		} as unknown as MetadataStore, { listKnowledgeRelations: async () => [] } as unknown as KnowledgeStore,
		{ search: async () => [] }, { search: async () => [
			{ filePath: "src/a1/unrelated.ts", startLine: 1, endLine: 2, score: 0.1 },
			{ filePath: "src/z/payment-refund.ts", startLine: 4, endLine: 9, score: 3 },
		] });
		const pack = await engine.build("payment refund", { maxCode: 2, maxTests: 1 });
		expect(pack.implementation[0]?.path).toBe("src/z/payment-refund.ts");
		expect(pack.tests).toMatchObject([{ path: "tests/z/payment-refund.test.ts", reason: "direct" }]);
	});

	it("reserves compact primary sources and counts omissions under the hard minimum budget", () => {
		const huge = "x".repeat(2_000);
		const output = formatKnowledgeContext({ query: huge, specs: [{ ...SPEC, path: huge, summary: huge, status: "inputs-changed" }], implementation: [{ path: huge, reason: "semantic" }], tests: [{ path: huge, reason: "direct", confidence: "high" }], relations: [], warnings: [huge, "second warning"], readNext: [] }, 1);
		expect(output).toContain("budget=200");
		expect(output).toContain("Warnings: (2)");
		expect(output).toContain("Primary knowledge:");
		expect(output).toContain("Implementation:");
		expect(output).toContain("Tests:");
	});
});
