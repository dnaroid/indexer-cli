import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider, KnowledgeChunkRecord, KnowledgeStore, VectorSearchResult, VectorStore } from "../../../src/core/types.js";
import { DocumentSearchEngine } from "../../../src/knowledge/search.js";

const chunk = (filePath: string, searchText: string, metadata: Record<string, unknown> = {}): KnowledgeChunkRecord => ({
	projectId: "p", snapshotId: "s", chunkId: filePath, filePath, startLine: 1, endLine: 3,
	contentHash: filePath, chunkType: "doc_section", heading: "Recovery", metadata: { searchText, ...metadata },
});
function setup(rows: KnowledgeChunkRecord[], vectors: VectorSearchResult[] = [], embeddingFails = false) {
	const knowledge = { listKnowledgeChunks: vi.fn().mockResolvedValue(rows) } as unknown as KnowledgeStore;
	const vectorStore = { search: vi.fn().mockResolvedValue(vectors) } as unknown as VectorStore;
	const embedder: EmbeddingProvider = { id:"test", initialize:async()=>{}, close:async()=>{}, getDimension:()=>3,
		embed: async (texts) => { if (embeddingFails) throw new Error("offline"); expect(texts[0]).toContain("query:"); return [[1,0,0]]; } };
	return { engine: new DocumentSearchEngine("p", "s", knowledge, vectorStore, embedder), vectorStore };
}

describe("DocumentSearchEngine", () => {
	it("does lexical retrieval for unknown documents and returns explicit metadata provenance", async () => {
		const { engine } = setup([chunk("docs/guide.md", "quartz protocol retries safely", { document: { kind:"spec", status:"active", kindSource:"explicit", statusSource:"explicit" } })]);
		const [result] = await engine.search("quartz protocol", { mode:"lexical" });
		expect(result).toMatchObject({ path:"docs/guide.md", kind:"spec", status:"active", provenance:{kind:"explicit",status:"explicit"} });
		expect(result?.score).toBeGreaterThan(0);
	});
	it("enforces path boundaries and minimum score", async () => {
		const { engine } = setup([chunk("docs/a.md", "alpha recovery"), chunk("docs-extra/b.md", "alpha recovery")]);
		expect(await engine.search("alpha", { mode:"lexical", pathPrefix:"docs" })).toHaveLength(1);
		expect(await engine.search("alpha", { mode:"lexical", minScore:1.1 })).toEqual([]);
	});
	it("respects chunk and test exclusion filters in document retrieval", async () => {
		const { engine } = setup([chunk("docs/a.md", "alpha recovery"), chunk("tests/notes.md", "alpha recovery")]);
		expect(await engine.search("alpha", { mode: "lexical", excludeTests: true })).toHaveLength(1);
		expect(await engine.search("alpha", { mode: "lexical", chunkTypes: ["types"] })).toEqual([]);
		expect(await engine.search("alpha", { mode: "lexical", chunkTypes: ["doc_section"] })).toHaveLength(2);
	});
	it("uses document query embeddings, excludes unrelated weak vectors, and keeps valid ranges", async () => {
		const weak = { filePath:"docs/no.md", startLine:0, endLine:0, score:.1 } as VectorSearchResult;
		const strong = { filePath:"docs/yes.md", startLine:1, endLine:3, score:.9 } as VectorSearchResult;
		const { engine, vectorStore } = setup([chunk("docs/yes.md", "nothing lexical")], [weak, strong]);
		const [result] = await engine.search("concept", { mode:"semantic" });
		expect(vectorStore.search).toHaveBeenCalledWith([1,0,0], expect.any(Number), expect.objectContaining({domain:"document"}));
		expect(result?.path).toBe("docs/yes.md");
		expect(result?.bestRanges.every(r => r.startLine >= 1 && r.endLine >= r.startLine)).toBe(true);
	});
	it("degrades hybrid retrieval to lexical with diagnostics, while semantic errors", async () => {
		const { engine } = setup([chunk("docs/a.md", "offline recovery")], [], true);
		expect((await engine.search("offline", { mode:"hybrid" }))[0]?.path).toBe("docs/a.md");
		expect(engine.getDiagnostics()).toMatchObject({ semanticAvailable:false, note:expect.stringContaining("unavailable") });
		await expect(engine.search("offline", { mode:"semantic" })).rejects.toThrow("unavailable");
	});
});
