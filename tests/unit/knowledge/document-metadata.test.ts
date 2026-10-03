import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SqliteMetadataStore } from "../../../src/storage/sqlite.js";
import { loadDocumentClassifierConfig } from "../../../src/knowledge/document-classifier-config.js";

const { fetchMock, classifierConfig } = vi.hoisted(() => ({
	fetchMock: vi.fn(),
	classifierConfig: { apiKey: "test-key" as string | undefined, model: "~typesafe/jev-latest", url: "https://openrouter.test/api/alpha/decisions", timeoutMs: 5000, kindMinConfidence: 0.9, statusMinConfidence: 0.65 },
}));
vi.mock("../../../src/knowledge/document-classifier-config.js", () => ({
	loadDocumentClassifierConfig: () => classifierConfig,
}));

import { buildDocumentClassifierInput, documentClassifierKey, getDocumentMetadata, parseDocumentMetadata } from "../../../src/knowledge/document-metadata.js";

let roots: string[] = [];
let stores: SqliteMetadataStore[] = [];
async function openCache(root: string) {
	await fs.mkdir(path.join(root, ".indexer-cli"), { recursive: true });
	const store = new SqliteMetadataStore(path.join(root, ".indexer-cli", "db.sqlite"));
	await store.initialize();
	stores.push(store);
	return store;
}
function cacheKey(filePath: string, content: string) {
	return createHash("sha256").update(`document-metadata-v6\0${filePath}\0${content}\0${documentClassifierKey(loadDocumentClassifierConfig())}`).digest("hex");
}
function decisionResponse() {
	return new Response(JSON.stringify({ answers: {
		kind: { choice: "guide", confidence: 0.99, probabilities: { guide: 0.99 } },
		status: { choice: "active", confidence: 0.99, probabilities: { active: 0.99 } },
	} }), { status: 200 });
}
async function tempRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "doc-metadata-test-")); roots.push(root); return root;
}
afterEach(async () => {
	fetchMock.mockReset(); vi.unstubAllGlobals();
	classifierConfig.model = "~typesafe/jev-latest"; classifierConfig.apiKey = "test-key";
	await Promise.all(stores.map(store => store.close())); stores = [];
	await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))); roots = [];
});

describe("document metadata parsing", () => {
	it("reads explicit and partial frontmatter, leaving absent fields unknown", () => {
		expect(parseDocumentMetadata('---\nkind: Spec # accepted\nstatus: proposed\n---\nBody')).toMatchObject({ kind: "spec", status: "proposed", kindSource: "explicit", statusSource: "explicit" });
		expect(parseDocumentMetadata('---\nkind: guide\n---\nBody')).toMatchObject({ kind: "guide", status: "unknown", kindSource: "explicit", statusSource: "unknown" });
	});

	it("warns on invalid or unterminated frontmatter without accepting invalid values", () => {
		expect(parseDocumentMetadata('---\nkind: nonsense\nstatus: stale\n---').warnings).toEqual(["Invalid frontmatter kind", "Invalid frontmatter status"]);
		expect(parseDocumentMetadata('---\nkind: spec').warnings).toContain("Unterminated frontmatter");
	});

	it("ignores fenced headings and assigns declaration roles only in named sections", () => {
		const result = parseDocumentMetadata([
			"```md", "## Implementation", "`ignored.ts`", "```", "",
			"## Implementation", "See `src/auth.ts::refreshToken` and `src/helper.ts`.",
			"## Tests", "`tests/auth.test.ts::auth.refresh`", "## Notes", "Mention `src/other.ts::helper`.",
		].join("\n"));
		expect(result.references).toEqual([
			{ path: "src/auth.ts", symbol: "refreshToken", role: "implementation" },
			{ path: "src/helper.ts", role: "implementation" },
			{ path: "tests/auth.test.ts", symbol: "auth.refresh", role: "test" },
			{ path: "src/other.ts", symbol: "helper", role: "mention" },
		]);
	});
});

describe("document classifier input", () => {
	it("keeps short documents unchanged", () => {
		const content = "# Guide\n\nShort document.";
		expect(buildDocumentClassifierInput(content)).toBe(content);
	});

	it("bounds long documents while preserving structure, priority sections, and the ending", () => {
		const content = [
			"---", "owner: docs", "---", "# Big document", "", "A".repeat(11_000),
			"## Lifecycle", "This document is superseded by docs/new-contract.md.",
			"## Details", "B".repeat(11_000), "TAIL_SENTINEL",
		].join("\n");
		const input = buildDocumentClassifierInput(content);
		expect(input.length).toBeLessThanOrEqual(20_000);
		expect(input).toContain("[frontmatter]");
		expect(input).toContain("# Big document");
		expect(input).toContain("## Lifecycle");
		expect(input).toContain("superseded by docs/new-contract.md");
		expect(input).toContain("TAIL_SENTINEL");
	});
});

describe("document metadata inference", () => {
	it("does not invoke the provider by default", async () => {
		vi.stubGlobal("fetch", fetchMock);
		const result = await getDocumentMetadata("doc.md", "No metadata");
		expect(result.kind).toBe("unknown"); expect(fetchMock).not.toHaveBeenCalled();
	});
	it("validates inference and caches valid results while preserving explicit fields", async () => {
		const root = await tempRoot();
		const cache = await openCache(root);
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ answers: { kind: { choice: "guide", confidence: 0.99, probabilities: { guide: 0.99, spec: 0.01 } }, status: { choice: "active", confidence: 0.99, probabilities: { active: 0.99, proposed: 0.01 } } } }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const content = "---\nkind: spec\n---\nDocument";
		const first = await getDocumentMetadata("doc.md", content, { classify: true, cache });
		expect(first).toMatchObject({ kind: "spec", status: "active", kindSource: "explicit", statusSource: "classifier" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
			model: "~typesafe/jev-latest",
			questions: { kind: { type: "choice" }, status: { type: "choice" } },
		});
		await cache.close(); stores = [];
		const reopened = await openCache(root);
		classifierConfig.apiKey = undefined;
		const second = await getDocumentMetadata("doc.md", content, { cache: reopened });
		expect(second).toMatchObject({ kind: "spec", status: "active", kindSource: "explicit", statusSource: "classifier" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse((await reopened.getDocumentMetadataCache("default", "doc.md", cacheKey("doc.md", content)))!)).toEqual({ kind: "guide", status: "active" });
		await expect(fs.stat(path.join(root, ".indexer-cli", "doc-metadata"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("replaces a document's cache when content or settings change, keeping other paths", async () => {
		const root = await tempRoot();
		const cache = await openCache(root);
		fetchMock.mockImplementation(async () => decisionResponse()); vi.stubGlobal("fetch", fetchMock);
		await getDocumentMetadata("doc.md", "Document", { classify: true, cache });
		await getDocumentMetadata("doc.md", "Changed document", { classify: true, cache });
		expect(await cache.getDocumentMetadataCache("default", "doc.md", cacheKey("doc.md", "Document"))).toBeNull();
		await getDocumentMetadata("other.md", "Document", { classify: true, cache });
		classifierConfig.model = "changed-model";
		await getDocumentMetadata("doc.md", "Document", { classify: true, cache });
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect((await getDocumentMetadata("doc.md", "Changed document", { cache })).kind).toBe("unknown");
		classifierConfig.model = "~typesafe/jev-latest";
		expect((await getDocumentMetadata("other.md", "Document", { cache })).kind).toBe("guide");
		expect((await getDocumentMetadata("doc.md", "Document", { cache })).kind).toBe("unknown");
	});

	it("ignores legacy JSON entries in read-only and classification modes", async () => {
		const root = await tempRoot(); const cache = await openCache(root);
		const dir = path.join(root, ".indexer-cli", "doc-metadata"); await fs.mkdir(dir);
		const legacy = path.join(dir, `${cacheKey("doc.md", "Document")}.json`);
		const legacyContent = JSON.stringify({ kind: "archive", status: "historical" });
		await fs.writeFile(legacy, legacyContent);
		await fs.writeFile(path.join(dir, "unrelated.json"), "{}");
		vi.stubGlobal("fetch", fetchMock);
		expect((await getDocumentMetadata("doc.md", "Document", { cache })).kind).toBe("unknown");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(await cache.getDocumentMetadataCache("default", "doc.md", cacheKey("doc.md", "Document"))).toBeNull();
		fetchMock.mockResolvedValueOnce(decisionResponse());
		expect((await getDocumentMetadata("doc.md", "Document", { classify: true, cache })).kind).toBe("guide");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await cache.getDocumentMetadataCache("default", "doc.md", cacheKey("doc.md", "Document"))).not.toBeNull();
		expect(await fs.readFile(legacy, "utf8")).toBe(legacyContent);
		expect(await fs.readFile(path.join(dir, "unrelated.json"), "utf8")).toBe("{}");
	});

	it("ignores malformed cached data and replaces it with validated inference", async () => {
		const root = await tempRoot(); const cache = await openCache(root);
		await cache.setDocumentMetadataCache("default", "doc.md", cacheKey("doc.md", "Document"), "not-json");
		fetchMock.mockResolvedValueOnce(decisionResponse()); vi.stubGlobal("fetch", fetchMock);
		expect((await getDocumentMetadata("doc.md", "Document", { classify: true, cache })).kind).toBe("guide");
		expect(JSON.parse((await cache.getDocumentMetadataCache("default", "doc.md", cacheKey("doc.md", "Document")))!).kind).toBe("guide");
	});

	it("does not discard successful inference when cache reads and writes fail", async () => {
		const cache = { getDocumentMetadataCache: vi.fn().mockRejectedValue(new Error("read failed")), setDocumentMetadataCache: vi.fn().mockRejectedValue(new Error("write failed")) };
		fetchMock.mockResolvedValueOnce(decisionResponse()); vi.stubGlobal("fetch", fetchMock);
		expect(await getDocumentMetadata("doc.md", "Document", { classify: true, cache })).toMatchObject({ kind: "guide", status: "active" });
		expect(cache.setDocumentMetadataCache).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid provider output without caching it", async () => {
		const root = await tempRoot();
		const cache = await openCache(root);
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ answers: { kind: { choice: "bogus", confidence: 1, probabilities: { bogus: 1 } }, status: { choice: "active", confidence: 1, probabilities: { active: 1 } } } }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const result = await getDocumentMetadata("doc.md", "Document", { classify: true, cache });
		expect(result.kind).toBe("unknown");
		await getDocumentMetadata("doc.md", "Document", { classify: true, cache });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await cache.getDocumentMetadataCache("default", "doc.md", cacheKey("doc.md", "Document"))).toBeNull();
	});

	it("abstains independently when Jev confidence is below configured thresholds", async () => {
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ answers: {
			kind: { choice: "spec", confidence: 0.88, probabilities: { spec: 0.9, guide: 0.1 } },
			status: { choice: "active", confidence: 0.8, probabilities: { active: 0.85, historical: 0.15 } },
		} }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const result = await getDocumentMetadata("docs/ambiguous.md", "# Ambiguous contract", { classify: true });
		expect(result).toMatchObject({ kind: "unknown", status: "active", kindSource: "unknown", statusSource: "classifier" });
	});

	it.each([
		[401, "authentication_failed", true],
		[402, "credits_exhausted", true],
		[429, "rate_limited", false],
		[503, "provider_unavailable", false],
	] as const)("reports HTTP %s as %s without blocking metadata", async (status, reason, humanActionRequired) => {
		fetchMock.mockResolvedValueOnce(new Response("unavailable", { status }));
		vi.stubGlobal("fetch", fetchMock);
		const diagnostic = vi.fn();
		const result = await getDocumentMetadata("doc.md", "# Document", { classify: true, onClassifierDiagnostic: diagnostic });
		expect(result).toMatchObject({ kind: "unknown", status: "unknown" });
		expect(diagnostic).toHaveBeenCalledWith({ reason, humanActionRequired });
	});

	it("reports invalid provider responses without blocking metadata", async () => {
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ answers: {} }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const diagnostic = vi.fn();
		const result = await getDocumentMetadata("doc.md", "# Document", { classify: true, onClassifierDiagnostic: diagnostic });
		expect(result.kind).toBe("unknown");
		expect(diagnostic).toHaveBeenCalledWith({ reason: "invalid_response", humanActionRequired: false });
	});
});
