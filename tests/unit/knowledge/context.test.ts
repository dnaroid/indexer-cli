import { describe, expect, it, vi } from "vitest";
import type { MetadataStore } from "../../../src/core/types.js";
import { KnowledgeContextEngine, formatKnowledgeContext } from "../../../src/knowledge/context.js";
import type { DocumentSearchResult } from "../../../src/knowledge/search.js";
import type { SearchResult } from "../../../src/engine/searcher.js";
import { TokenEstimator } from "../../../src/utils/token-estimator.js";

function document(path: string, kind: DocumentSearchResult["kind"], status: DocumentSearchResult["status"], provenance: DocumentSearchResult["provenance"], references: NonNullable<DocumentSearchResult["metadata"]>["references"] = []): DocumentSearchResult {
	return {
		path, title: path, kind, status, provenance, score: 1, semanticScore: 0.8, lexicalScore: 1,
		summary: "Useful indexed evidence.", reasonCodes: ["semantic"], bestRanges: [{ startLine: 2, endLine: 5, score: 0.8 }],
		metadata: { kind, status, kindSource: provenance.kind, statusSource: provenance.status, warnings: [], references },
	};
}

const spec = document("docs/auth.md", "spec", "active", { kind: "explicit", status: "explicit" }, [
	{ path: "src/auth.ts", role: "implementation" }, { path: "tests/auth.test.ts", role: "test" },
]);

function engine(results: DocumentSearchResult[], files: string[] = ["src/auth.ts", "tests/auth.test.ts"], codeResults: Array<{ filePath: string; startLine?: number; endLine?: number; score: number }> = []) {
	const listFiles = vi.fn(async () => files.map((path) => ({ snapshotId: "snap", path, sha256: "hash", mtimeMs: 1, size: 1, languageId: "typescript" })));
	const listDependencies = vi.fn(async () => []);
	const searchDocuments = vi.fn(async () => results);
	const searchCode = vi.fn(async () => codeResults as SearchResult[]);
	const metadata = { listFiles, listDependencies } as unknown as MetadataStore;
	return { context: new KnowledgeContextEngine("project", "snap", metadata, { search: searchDocuments }, { search: searchCode }), listFiles, listDependencies, searchDocuments, searchCode };
}

describe("KnowledgeContextEngine", () => {
	it("preserves a document retrieval fallback warning", async () => {
		const metadata = { listFiles: async () => [], listDependencies: async () => [] } as unknown as MetadataStore;
		const context = new KnowledgeContextEngine("p", "s", metadata, {
			search: async () => [spec],
			getDiagnostics: () => ({ mode: "hybrid", semanticAvailable: false, lexicalCandidates: 1, vectorCandidates: 0, note: "Document retrieval unavailable; using lexical results." }),
		}, { search: async () => [] });
		expect((await context.build("auth")).warnings).toContain("Document retrieval unavailable; using lexical results.");
	});
	it("selects only explicitly active specs; other indexed documents remain documents", async () => {
		const inferred = document("docs/inferred.md", "spec", "active", { kind: "classifier", status: "classifier" });
		const unknown = document("docs/guide.md", "guide", "proposed", { kind: "explicit", status: "explicit" });
		const pack = await engine([spec, inferred, unknown]).context.build("auth");
		expect(pack.specs).toEqual([spec]);
		expect(pack.documents).toEqual([inferred, unknown]);
	});

	it("uses document references for indexed implementation and tests", async () => {
		const pack = await engine([spec]).context.build("auth");
		expect(pack.implementation.map(({ path }) => path)).toContain("src/auth.ts");
		expect(pack.tests).toContainEqual(expect.objectContaining({ path: "tests/auth.test.ts", reason: "explicit" }));
	});

	it("returns code-only context when document search has no match", async () => {
		const { context } = engine([], ["src/format.ts"], [{ filePath: "src/format.ts", startLine: 3, endLine: 7, score: 1 }]);
		const pack = await context.build("format");
		expect(pack.specs).toEqual([]);
		expect(pack.implementation).toContainEqual(expect.objectContaining({ path: "src/format.ts", reason: "semantic" }));
		expect(pack.warnings).toContain("No indexed document matched the query.");
	});

	it("passes pathPrefix to document and code searches", async () => {
		const mocks = engine([spec]);
		await mocks.context.build("auth", { pathPrefix: "src/auth" });
		expect(mocks.searchDocuments).toHaveBeenCalledWith("auth", expect.objectContaining({ pathPrefix: "src/auth" }));
		expect(mocks.searchCode).toHaveBeenCalledWith("project", "snap", "auth", expect.objectContaining({ pathPrefix: "src/auth" }));
	});
});

describe("formatKnowledgeContext", () => {
	it("bounds output, deduplicates evidence and reports omitted sources", () => {
		const output = formatKnowledgeContext({
			query: "auth", specs: [spec], documents: [],
			implementation: [{ path: "src/auth.ts", reason: "semantic" }],
			tests: [{ path: "tests/auth.test.ts", reason: "explicit", confidence: "high" }],
			warnings: Array.from({ length: 100 }, (_, index) => `warning ${index} ${"long warning detail ".repeat(4)}`), readNext: ["docs/auth.md:2-5", "src/auth.ts", "tests/auth.test.ts", "extra/follow-up.md"],
		}, 200);
		expect(output).toContain("budget=200");
		expect(new TokenEstimator().estimate(output)).toBeLessThanOrEqual(200);
		expect(output).toMatch(/TRUNC budget=200 omitted=\d+/);
		expect(output.match(/src\/auth\.ts/g)?.length).toBeLessThanOrEqual(1);
		expect(output).toContain("Read next: (1) > extra/follow-up.md");
	});
});
