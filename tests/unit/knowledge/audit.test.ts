import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditTask } from "../../../src/knowledge/audit.js";

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function fixture() {
	root = await mkdtemp(path.join(os.tmpdir(), "idx-audit-"));
	await mkdir(path.join(root, "docs"), { recursive: true });
	return root;
}

describe("task audit", () => {
	it("distinguishes explicit active specs from inferred/unknown possible candidates and ordinary mentions", async () => {
		const dir = await fixture();
		await writeFile(path.join(dir, "docs/spec.md"), `---\nkind: spec\nstatus: active\n---\n## Implementation\n- \`src/a.ts::Thing\`\n`);
		await writeFile(path.join(dir, "docs/inferred.md"), `## Implementation\n- \`src/a.ts\`\n`);
		await writeFile(path.join(dir, "docs/mention.md"), `See \`src/a.ts\`.\n`);
		const report = await auditTask(dir, ["src/a.ts"], { noSemantic: true });
		expect(report.matches.find((m) => m.path === "docs/spec.md")?.group).toBe("explicit-active-spec");
		expect(report.matches.find((m) => m.path === "docs/inferred.md")?.group).toBe("possible");
		expect(report.matches.find((m) => m.path === "docs/mention.md")?.group).toBe("possible");
		expect(report.matches.find((m) => m.path === "docs/spec.md")?.reasons[0]?.symbol).toBe("Thing");
	});
	it("supports deleted paths, ignored docs, root escapes, unresolved symbols, and unrelated paths", async () => {
		const dir = await fixture();
		await writeFile(path.join(dir, ".gitignore"), "hidden.md\n");
		await writeFile(path.join(dir, "docs/spec.md"), `---\nkind: spec\nstatus: active\n---\n## Tests\n- \`gone.test.ts::missing\`\n`);
		await writeFile(path.join(dir, "hidden.md"), `## Implementation\n- \`gone.test.ts\`\n`);
		const report = await auditTask(dir, ["gone.test.ts", "elsewhere.ts"], { noSemantic: true });
		expect(report.changedPaths).toContain("gone.test.ts");
		expect(report.unresolvedPaths).toEqual([{ document: "docs/spec.md", path: "gone.test.ts", symbol: "missing", reason: "missing or outside project" }]);
		expect(report.uncoveredPaths).toContain("elsewhere.ts");
		await expect(auditTask(dir, ["../escape.ts"], { noSemantic: true })).rejects.toThrow(/escapes/);
	});
	it("does not traverse document symlinks outside the root", async () => {
		const dir = await fixture(); const external = await mkdtemp(path.join(os.tmpdir(), "idx-out-"));
		try { await writeFile(path.join(external, "out.md"), "## Implementation\n- `x.ts`\n"); await symlink(external, path.join(dir, "escape"));
			const report = await auditTask(dir, ["x.ts"], { noSemantic: true }); expect(report.matches).toEqual([]);
		} finally { await rm(external, { recursive: true, force: true }); }
	});
	it("keeps dependency and hybrid candidates advisory and reports missing symbols", async () => {
		const dir = await fixture();
		await writeFile(path.join(dir, "dependency.ts"), "export const actual = 1;");
		await writeFile(path.join(dir, "docs/spec.md"), "---\nkind: spec\nstatus: active\n---\n## Implementation\n`dependency.ts::missing`\n");
		await writeFile(path.join(dir, "docs/notes.md"), "Conceptual notes without references");
		const report = await auditTask(dir, ["changed.ts"], {
			dependencies: [{ fromPath: "changed.ts", toPath: "dependency.ts" }],
			symbols: [{ filePath: "dependency.ts", name: "actual" }],
			search: async () => ["docs/notes.md"],
		});
		expect(report.matches).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "docs/spec.md", group: "possible", reasons: [expect.objectContaining({ basis: "dependency", changedPath: "changed.ts" })] }),
			expect.objectContaining({ path: "docs/notes.md", group: "possible", reasons: [expect.objectContaining({ basis: "hybrid-retrieval" })] }),
		]));
		expect(report.unresolvedPaths).toContainEqual(expect.objectContaining({ symbol: "missing", reason: "symbol not indexed" }));
	});
	it("never invokes retrieval offline and sanitizes provider errors", async () => {
		const dir = await fixture();
		const search = vi.fn().mockRejectedValue(new Error("secret-token"));
		await auditTask(dir, ["changed.ts"], { noSemantic: true, search });
		expect(search).not.toHaveBeenCalled();
		const report = await auditTask(dir, ["changed.ts"], { search });
		expect(report.warnings).toContain("semantic retrieval failed for changed.ts");
		expect(JSON.stringify(report)).not.toContain("secret-token");
	});
	it("resolves Markdown links relative to their document without promoting them to declarations", async () => {
		const dir = await fixture();
		await writeFile(path.join(dir, "docs/spec.md"), "---\nkind: spec\nstatus: active\n---\n## Implementation\n[code](../src/a.ts)\n[outside](../../outside.ts)\n");
		const report = await auditTask(dir, ["src/a.ts"], { noSemantic: true });
		expect(report.matches).toEqual([expect.objectContaining({ group: "possible", reasons: [expect.objectContaining({ changedPath: "src/a.ts", basis: "ordinary-mention" })] })]);
		expect(report.unresolvedPaths).toContainEqual(expect.objectContaining({ path: "../outside.ts", reason: "outside project" }));
	});
});
