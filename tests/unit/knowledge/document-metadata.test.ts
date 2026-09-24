import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../../src/knowledge/document-classifier-config.js", () => ({
	loadDocumentClassifierConfig: () => ({ apiKey: "test-key", model: "~typesafe/jev-latest", url: "https://openrouter.test/api/alpha/decisions", timeoutMs: 5000, kindMinConfidence: 0.9, statusMinConfidence: 0.65 }),
}));

import { buildDocumentClassifierInput, getDocumentMetadata, parseDocumentMetadata } from "../../../src/knowledge/document-metadata.js";

let roots: string[] = [];
async function tempRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "doc-metadata-test-")); roots.push(root); return root;
}
afterEach(async () => { fetchMock.mockReset(); vi.unstubAllGlobals(); await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); roots = []; });

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
		const result = await getDocumentMetadata(await tempRoot(), "doc.md", "No metadata");
		expect(result.kind).toBe("unknown"); expect(fetchMock).not.toHaveBeenCalled();
	});
	it("validates inference and caches valid results while preserving explicit fields", async () => {
		const root = await tempRoot();
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ answers: { kind: { choice: "guide", confidence: 0.99, probabilities: { guide: 0.99, spec: 0.01 } }, status: { choice: "active", confidence: 0.99, probabilities: { active: 0.99, proposed: 0.01 } } } }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const content = "---\nkind: spec\n---\nDocument";
		const first = await getDocumentMetadata(root, "doc.md", content, { classify: true });
		expect(first).toMatchObject({ kind: "spec", status: "active", kindSource: "explicit", statusSource: "classifier" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
			model: "~typesafe/jev-latest",
			questions: { kind: { type: "choice" }, status: { type: "choice" } },
		});
		const second = await getDocumentMetadata(root, "doc.md", content, { classify: true });
		expect(second).toMatchObject({ kind: "spec", status: "active", kindSource: "explicit", statusSource: "classifier" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid provider output without caching it", async () => {
		const root = await tempRoot();
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ answers: { kind: { choice: "bogus", confidence: 1, probabilities: { bogus: 1 } }, status: { choice: "active", confidence: 1, probabilities: { active: 1 } } } }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const result = await getDocumentMetadata(root, "doc.md", "Document", { classify: true });
		expect(result.kind).toBe("unknown");
		await getDocumentMetadata(root, "doc.md", "Document", { classify: true });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("abstains independently when Jev confidence is below configured thresholds", async () => {
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ answers: {
			kind: { choice: "spec", confidence: 0.88, probabilities: { spec: 0.9, guide: 0.1 } },
			status: { choice: "active", confidence: 0.8, probabilities: { active: 0.85, historical: 0.15 } },
		} }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const result = await getDocumentMetadata(await tempRoot(), "docs/ambiguous.md", "# Ambiguous contract", { classify: true });
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
		const result = await getDocumentMetadata(await tempRoot(), "doc.md", "# Document", { classify: true, onClassifierDiagnostic: diagnostic });
		expect(result).toMatchObject({ kind: "unknown", status: "unknown" });
		expect(diagnostic).toHaveBeenCalledWith({ reason, humanActionRequired });
	});

	it("reports invalid provider responses without blocking metadata", async () => {
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ answers: {} }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const diagnostic = vi.fn();
		const result = await getDocumentMetadata(await tempRoot(), "doc.md", "# Document", { classify: true, onClassifierDiagnostic: diagnostic });
		expect(result.kind).toBe("unknown");
		expect(diagnostic).toHaveBeenCalledWith({ reason: "invalid_response", humanActionRequired: false });
	});
});
