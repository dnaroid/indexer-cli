import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSpecTemplate, SPEC_TEMPLATE } from "../../../src/cli/spec-template.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "idx-spec-template-"));
	roots.push(root);
	return root;
}

describe("recommended spec template", () => {
	it("installs a copyable template without turning it into an active spec", async () => {
		const target = await installSpecTemplate(await temporaryRoot());
		expect(await readFile(target, "utf8")).toBe(SPEC_TEMPLATE);
		expect(SPEC_TEMPLATE).toContain("status: proposed");
		expect(SPEC_TEMPLATE).toContain("## Implementation");
		expect(SPEC_TEMPLATE).toContain("src/feature.ts::Feature");
	});
	it("preserves a user-edited template on repeated init", async () => {
		const root = await temporaryRoot();
		const target = await installSpecTemplate(root);
		await writeFile(target, "custom template");
		await installSpecTemplate(root);
		expect(await readFile(target, "utf8")).toBe("custom template");
	});
	it("does not follow an existing template symlink", async () => {
		const root = await temporaryRoot();
		const external = path.join(root, "original.md");
		await writeFile(external, "preserve");
		await symlink(external, path.join(root, "spec-template.md"));
		await installSpecTemplate(root);
		expect(await readFile(external, "utf8")).toBe("preserve");
	});
});
