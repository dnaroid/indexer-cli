import { describe, expect, it, vi } from "vitest";
import type { KnowledgeChunkRecord, KnowledgeStore } from "../../../src/core/types.js";
import { UnifiedSearchEngine } from "../../../src/engine/unified-search.js";
import type { SearchEngine, SearchResult } from "../../../src/engine/searcher.js";

describe("UnifiedSearchEngine", () => {
	it("preserves a relevant code slot among common document matches without promoting weak code", async () => {
		const search = vi.fn().mockResolvedValue([{ filePath: "src/a.ts", score: 0.7, startLine: 1, endLine: 2 }]);
		const rows = Array.from({ length: 5 }, (_, index) => ({ projectId: "p", snapshotId: "s", chunkId: `doc-${index}`, filePath: `docs/${index}.md`, startLine: 1, endLine: 2, contentHash: "h", chunkType: "doc_section", metadata: { searchText: "retry" } }));
		const knowledge = { listKnowledgeChunks: vi.fn().mockResolvedValue(rows) } as unknown as KnowledgeStore;
		const unified = new UnifiedSearchEngine({ search } as unknown as SearchEngine, "p", "s", knowledge, null, null);
		const mixed = await unified.search("p", "s", "retry", { topK: 3 });
		expect(mixed).toHaveLength(3);
		expect(mixed.map(result => result.domain)).toEqual(["document", "document", "code"]);
		expect(mixed[2].score).toBe(0.7);
		search.mockResolvedValue([{ filePath: "src/a.ts", score: 0.1, startLine: 1, endLine: 2 }]);
		expect((await unified.search("p", "s", "retry", { topK: 3 })).every(result => result.domain === "document")).toBe(true);
	});
	it("filters domains and preserves code scores rather than inflating by rank", async () => {
		const code = [
			{ filePath:"src/a.ts", score:.31, content:"a", startLine:1, endLine:1 },
			{ filePath:"src/b.ts", score:.12, content:"b", startLine:1, endLine:1 },
		] as SearchResult[];
		const search = vi.fn().mockResolvedValue(code);
		const codeEngine = { search } as unknown as SearchEngine;
		const row = { projectId:"p", snapshotId:"s", chunkId:"doc", filePath:"docs/a.md", startLine:1, endLine:2, contentHash:"h", chunkType:"doc_section", metadata:{ searchText:"quartz protocol" } } as KnowledgeChunkRecord;
		const knowledge = { listKnowledgeChunks:vi.fn().mockResolvedValue([row]) } as unknown as KnowledgeStore;
		const unified = new UnifiedSearchEngine(codeEngine, "p", "s", knowledge, null, null);
		const all = await unified.search("p", "s", "quartz", { topK:10 });
		expect(all.filter(r => r.domain === "code").map(r => r.score)).toEqual([.31,.12]);
		expect(all.some(r => r.domain === "document" && r.path === "docs/a.md")).toBe(true);
		const docs = await unified.search("p", "s", "quartz", { domain:"document", topK:10 });
		expect(docs.every(r => r.domain === "document")).toBe(true);
		expect(search).toHaveBeenCalledTimes(1);
		const codeOnly = await unified.search("p", "s", "quartz", { domain:"code", topK:10 });
		expect(codeOnly.every(r => r.domain === "code")).toBe(true);
	});
});
