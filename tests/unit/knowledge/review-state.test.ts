import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../../src/core/config.js";
import { acknowledgeKnowledgeReviews, knowledgeReviewStatus } from "../../../src/knowledge/review-state.js";

const spec = (refs = "`src/a.ts::Thing`\n\n## Tests\n`tests/`") => `---\nkind: spec\nstatus: active\n---\n# Contract\n## Implementation\n${refs}\n`;
let root: string;
beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "knowledge-review-"));
	config.load(root);
	await mkdir(path.join(root, "src"));
	await mkdir(path.join(root, "tests"));
	await writeFile(path.join(root, "src/a.ts"), "export const Thing = 1;\n");
	await writeFile(path.join(root, "spec.md"), spec());
});
afterEach(async () => { config.load(root); await rm(root, { recursive: true, force: true }); });

describe("offline knowledge review state", () => {
	it("starts dirty without writing state, then acknowledges only explicitly selected specs", async () => {
		const report = await knowledgeReviewStatus(root);
		expect(report.status).toBe("dirty");
		expect(report.specs[0].reasons).toEqual(["never-reviewed"]);
		expect(await readdir(root)).not.toContain(".indexer-cli");
		await acknowledgeKnowledgeReviews(root, ["spec.md"]);
		expect((await knowledgeReviewStatus(root)).status).toBe("clean");
	});
	it("detects content changes even with the same size, and content reversions are clean", async () => {
		await acknowledgeKnowledgeReviews(root, ["spec.md"]);
		await writeFile(path.join(root, "src/a.ts"), "export const Thing = 2;\n");
		const report = await knowledgeReviewStatus(root);
		expect(report.specs[0].changedPaths).toEqual(["src/a.ts"]);
		await writeFile(path.join(root, "src/a.ts"), "export const Thing = 1;\n");
		expect((await knowledgeReviewStatus(root)).status).toBe("clean");
	});
	it("detects spec edits, added and deleted directory members, and ignores unrelated files", async () => {
		await acknowledgeKnowledgeReviews(root, ["spec.md"]);
		await writeFile(path.join(root, "src/unrelated.ts"), "unrelated");
		expect((await knowledgeReviewStatus(root)).status).toBe("clean");
		await writeFile(path.join(root, "tests/new.ts"), "test");
		expect((await knowledgeReviewStatus(root)).specs[0].changedPaths).toEqual(["tests/new.ts"]);
		await acknowledgeKnowledgeReviews(root, ["spec.md"]);
		await rm(path.join(root, "tests/new.ts"));
		expect((await knowledgeReviewStatus(root)).specs[0].changedPaths).toEqual(["tests/new.ts"]);
		await writeFile(path.join(root, "spec.md"), `${spec()}Changed prose.\n`);
		expect((await knowledgeReviewStatus(root)).specs[0].changedPaths).toContain("spec.md");
	});
	it("does not confuse ordinary mentions with declarations or include non-active specs", async () => {
		await writeFile(path.join(root, "old.md"), spec().replace("status: active", "status: superseded"));
		await writeFile(path.join(root, "guide.md"), spec().replace("kind: spec", "kind: guide"));
		await writeFile(path.join(root, "spec.md"), spec("`src/a.ts`\n## Notes\n`src/unrelated.ts`"));
		await acknowledgeKnowledgeReviews(root, ["spec.md"]);
		const report = await knowledgeReviewStatus(root);
		expect(report.specs).toHaveLength(1);
		expect(report.status).toBe("clean");
		await expect(acknowledgeKnowledgeReviews(root, ["old.md"])).rejects.toThrow("explicit");
	});
	it("keeps undeclared specs dirty and refuses acknowledgment", async () => {
		await writeFile(path.join(root, "spec.md"), spec("No paths."));
		expect((await knowledgeReviewStatus(root)).specs[0].reasons).toEqual(["no-declarations"]);
		await expect(acknowledgeKnowledgeReviews(root, ["spec.md"])).rejects.toThrow("No Implementation");
	});
	it("fails closed on missing dependencies, escaping paths, and symlinks", async () => {
		await rm(path.join(root, "src/a.ts"));
		expect((await knowledgeReviewStatus(root)).status).toBe("error");
		await writeFile(path.join(root, "spec.md"), spec("`../outside.ts`"));
		await expect(acknowledgeKnowledgeReviews(root, ["spec.md"])).rejects.toThrow("relative");
		await expect(acknowledgeKnowledgeReviews(root, ["../spec.md"])).rejects.toThrow("relative");
		await writeFile(path.join(root, "spec.md"), spec("`src/`"));
		await symlink(root, path.join(root, "src/loop"));
		await expect(acknowledgeKnowledgeReviews(root, ["spec.md"])).rejects.toThrow("Symlink");
	});
	it("validates all selections before writing and keeps other receipts intact", async () => {
		await writeFile(path.join(root, "second.md"), spec());
		await expect(acknowledgeKnowledgeReviews(root, ["spec.md", "missing.md"])).rejects.toThrow("selection");
		expect(await readdir(root)).not.toContain(".indexer-cli");
		await acknowledgeKnowledgeReviews(root, ["spec.md", "second.md"]);
		expect((await knowledgeReviewStatus(root)).counts.clean).toBe(2);
		const directory = path.join(root, ".indexer-cli/knowledge-reviews");
		for (const file of await readdir(directory)) expect(JSON.parse(await readFile(path.join(directory, file), "utf8")).version).toBe(1);
	});
	it("fails closed on corrupt receipts and skipped oversized documents", async () => {
		await acknowledgeKnowledgeReviews(root, ["spec.md"]);
		const directory = path.join(root, ".indexer-cli/knowledge-reviews");
		await writeFile(path.join(directory, (await readdir(directory))[0]), "{}");
		expect((await knowledgeReviewStatus(root)).status).toBe("error");
		await writeFile(path.join(root, "config.json"), '{"documentMaxBytes":1}');
		config.load(root);
		expect((await knowledgeReviewStatus(root)).status).toBe("error");
	});
});
