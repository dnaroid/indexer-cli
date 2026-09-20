import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile, rename, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiscoveryCache } from "../../../src/knowledge/discovery-cache.js";

describe("DiscoveryCache", () => {
	const dirs: string[] = [];
	afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
	function root(): string { const dir = mkdtempSync(path.join(os.tmpdir(), "idx-discovery-cache-")); dirs.push(dir); return dir; }

	it("persists hints across cache instances without re-analysis", async () => {
		const dir = root(); await writeFile(path.join(dir, "doc.md"), "# One\n");
		let analyses = 0;
		const analyze = (text: string) => { analyses += 1; return { title: text.trim(), signals: { score: 3, roleHint: "spec-candidate" as const, signals: [] } }; };
		const first = new DiscoveryCache(dir, "project");
		expect(await first.document("doc.md", analyze)).not.toBeNull(); await first.save(["doc.md"]);
		const second = new DiscoveryCache(dir, "project");
		expect(await second.document("doc.md", analyze)).toMatchObject({ title: "# One" });
		expect(analyses).toBe(1);
	});

	it("does not reuse a same-size edit whose mtime is restored because ctime changed", async () => {
		const dir = root(); const file = path.join(dir, "doc.md"); await writeFile(file, "# One\n");
		let analyses = 0; const analyze = () => ({ title: `${++analyses}`, signals: { score: 3, roleHint: "spec-candidate" as const, signals: [] } });
		const first = new DiscoveryCache(dir, "project"); await first.document("doc.md", analyze); await first.save(["doc.md"]);
		const original = statSync(file); await writeFile(file, "# Two\n"); await utimes(file, original.atime, original.mtime);
		const second = new DiscoveryCache(dir, "project");
		expect((await second.document("doc.md", analyze))?.title).toBe("2");
	});

	it("does not reuse deleted or renamed paths", async () => {
		const dir = root(); await writeFile(path.join(dir, "old.md"), "# One\n");
		let analyses = 0; const analyze = () => ({ title: `${++analyses}`, signals: { score: 3, roleHint: "spec-candidate" as const, signals: [] } });
		const first = new DiscoveryCache(dir, "project"); await first.document("old.md", analyze); await first.save(["old.md"]);
		await rename(path.join(dir, "old.md"), path.join(dir, "new.md"));
		const second = new DiscoveryCache(dir, "project");
		expect(await second.document("old.md", analyze)).toBeNull();
		expect((await second.document("new.md", analyze))?.title).toBe("2");
	});

	it("invalidates an older cache format", async () => {
		const dir = root(); await writeFile(path.join(dir, "doc.md"), "# One\n");
		let analyses = 0; const analyze = () => ({ title: `${++analyses}`, signals: { score: 3, roleHint: "spec-candidate" as const, signals: [] } });
		const first = new DiscoveryCache(dir, "project"); await first.document("doc.md", analyze); await first.save(["doc.md"]);
		const cachePath = path.join(dir, ".indexer-cli/knowledge-discovery-v1.json");
		const cache = JSON.parse(await readFile(cachePath, "utf8")); cache.version = 0; await writeFile(cachePath, JSON.stringify(cache));
		const second = new DiscoveryCache(dir, "project");
		expect((await second.document("doc.md", analyze))?.title).toBe("2");
	});

	it("bypasses corrupt and config-mismatched cache files", async () => {
		const dir = root(); await writeFile(path.join(dir, "doc.md"), "# One\n");
		let analyses = 0; const analyze = () => ({ title: `${++analyses}`, signals: { score: 3, roleHint: "spec-candidate" as const, signals: [] } });
		const first = new DiscoveryCache(dir, "project"); await first.document("doc.md", analyze); await first.save(["doc.md"]);
		const cachePath = path.join(dir, ".indexer-cli/knowledge-discovery-v1.json");
		const cache = JSON.parse(await readFile(cachePath, "utf8")); cache.config = "stale"; await writeFile(cachePath, JSON.stringify(cache));
		expect((await new DiscoveryCache(dir, "project").document("doc.md", analyze))?.title).toBe("2");
		await writeFile(cachePath, "not json");
		expect((await new DiscoveryCache(dir, "project").document("doc.md", analyze))?.title).toBe("3");
	});
});
