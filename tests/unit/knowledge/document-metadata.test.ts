import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { json } = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("../../../src/ask/configured-model.js", () => ({ createConfiguredAskModel: () => ({ turn: async (request: unknown) => ({ text: JSON.stringify(await json(request)), toolCalls: [] }) }) }));
vi.mock("../../../src/ask/config.js", () => ({ loadAskConfig: () => ({ backend: "openai", model: "test-model", apiKey: "test-key" }) }));

import { getDocumentMetadata, parseDocumentMetadata } from "../../../src/knowledge/document-metadata.js";

let roots: string[] = [];
async function tempRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "doc-metadata-test-")); roots.push(root); return root;
}
afterEach(async () => { json.mockReset(); await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); roots = []; });

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

describe("document metadata inference", () => {
	it("does not invoke the provider by default", async () => {
		const result = await getDocumentMetadata(await tempRoot(), "doc.md", "No metadata");
		expect(result.kind).toBe("unknown"); expect(json).not.toHaveBeenCalled();
	});
	it("never classifies in an ask retrieval child", async () => {
		vi.stubEnv("IDX_ASK_CHILD", "1");
		try {
			const result = await getDocumentMetadata(await tempRoot(), "doc.md", "No metadata", { classify: true });
			expect(result.kind).toBe("unknown");
			expect(json).not.toHaveBeenCalled();
		} finally { vi.unstubAllEnvs(); }
	});

	it("validates inference and caches valid results while preserving explicit fields", async () => {
		const root = await tempRoot();
		json.mockResolvedValueOnce({ kind: "guide", status: "active" });
		const content = "---\nkind: spec\n---\nDocument";
		const first = await getDocumentMetadata(root, "doc.md", content, { classify: true });
		expect(first).toMatchObject({ kind: "spec", status: "active", kindSource: "explicit", statusSource: "llm" });
		expect(json).toHaveBeenCalledTimes(1);
		const second = await getDocumentMetadata(root, "doc.md", content, { classify: true });
		expect(second).toMatchObject({ kind: "spec", status: "active", kindSource: "explicit", statusSource: "llm" });
		expect(json).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid provider output without caching it", async () => {
		const root = await tempRoot(); json.mockResolvedValueOnce({ kind: "bogus", status: "active" });
		const result = await getDocumentMetadata(root, "doc.md", "Document", { classify: true });
		expect(result.kind).toBe("unknown");
		await getDocumentMetadata(root, "doc.md", "Document", { classify: true });
		expect(json).toHaveBeenCalledTimes(2);
	});
});
