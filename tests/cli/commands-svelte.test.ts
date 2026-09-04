import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCLI } from "../helpers/cli-runner";

let tempDir = "";

describe.sequential("CLI Svelte support", () => {
	beforeAll(() => {
		tempDir = mkdtempSync(path.join(os.tmpdir(), "indexer-cli-svelte-"));
		mkdirSync(path.join(tempDir, ".indexer-cli"), { recursive: true });
		writeFileSync(path.join(tempDir, ".indexer-cli", "config.json"), "{}\n");
		writeFileSync(
			path.join(tempDir, "App.svelte"),
			`<script lang="ts">
	import Button from "./Button.svelte";
	const greet = (name: string) => \`Hello \${name}\`;
</script>
<main><Button>{greet("Svelte")}</Button></main>
<style>main { display: grid }</style>`,
		);
	});

	afterAll(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("prints a compact AST for a .svelte component", () => {
		const result = runCLI(["ast", "App.svelte", "--max-depth", "3"], {
			cwd: tempDir,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("AST App.svelte language=svelte");
		expect(result.stdout).toContain("Root:");
		expect(result.stdout).toContain("Script:");
		expect(result.stdout).toContain("RegularElement:");
		expect(result.stdout).toContain("StyleSheet:");
	});
});
