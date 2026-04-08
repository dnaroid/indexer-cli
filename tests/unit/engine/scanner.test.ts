import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanProjectFiles } from "../../../src/engine/scanner.js";

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "indexer-scanner-"));
	tempDirs.push(dir);
	return dir;
}

async function writeProjectFile(
	rootDir: string,
	relativePath: string,
	content = "",
): Promise<void> {
	const fullPath = path.join(rootDir, relativePath);
	await mkdir(path.dirname(fullPath), { recursive: true });
	await writeFile(fullPath, content, "utf8");
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("scanProjectFiles", () => {
	it("walks directories, respects gitignore rules, and filters by extension", async () => {
		const rootDir = await createTempProject();

		await writeProjectFile(rootDir, ".gitignore", "custom/\nignored.ts\n");
		await writeProjectFile(
			rootDir,
			"src/index.ts",
			"export const index = true;\n",
		);
		await writeProjectFile(
			rootDir,
			"src/util.TS",
			"export const util = true;\n",
		);
		await writeProjectFile(
			rootDir,
			"keep/script.js",
			"export const script = true;\n",
		);
		await writeProjectFile(rootDir, "README.md", "ignored\n");
		await writeProjectFile(rootDir, "custom/hidden.ts", "ignored\n");
		await writeProjectFile(rootDir, "src/ignored.ts", "ignored\n");
		await writeProjectFile(rootDir, "node_modules/pkg/index.ts", "ignored\n");
		await writeProjectFile(rootDir, "build/output.ts", "ignored\n");
		await writeProjectFile(rootDir, "keep/app.min.js", "ignored\n");

		const files = await scanProjectFiles(rootDir, [".ts", ".js"]);

		expect(files).toEqual(["keep/script.js", "src/index.ts", "src/util.TS"]);
	});

	it("returns sorted relative file paths from nested directories", async () => {
		const rootDir = await createTempProject();

		await writeProjectFile(rootDir, "z-last.ts", "export const z = true;\n");
		await writeProjectFile(rootDir, "a/first.ts", "export const a = true;\n");
		await writeProjectFile(
			rootDir,
			"a/deep/middle.ts",
			"export const middle = true;\n",
		);

		const files = await scanProjectFiles(rootDir, [".ts"]);

		expect(files).toEqual(["a/deep/middle.ts", "a/first.ts", "z-last.ts"]);
	});

	it("skips a falsy directory popped from the traversal stack", async () => {
		const originalPop = Array.prototype.pop;
		const popSpy = vi
			.spyOn(Array.prototype, "pop")
			.mockImplementation(function () {
				if (this.length === 1 && this[0] === "/repo") {
					this.length = 0;
					return undefined;
				}
				return originalPop.call(this);
			});

		await expect(scanProjectFiles("/repo", [".ts"])).resolves.toEqual([]);

		popSpy.mockRestore();
	});

	it("skips root-like entries with empty names and non-file entries", async () => {
		vi.resetModules();
		const readdir = vi.fn().mockResolvedValueOnce([
			{
				name: "",
				isDirectory: () => false,
				isFile: () => true,
			},
			{
				name: "socket",
				isDirectory: () => false,
				isFile: () => false,
			},
		]);

		vi.doMock("node:fs/promises", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs/promises")>();
			return { ...actual, readdir };
		});

		const { scanProjectFiles: mockedScanProjectFiles } = await import(
			"../../../src/engine/scanner.js"
		);

		await expect(mockedScanProjectFiles("/repo", [".ts"])).resolves.toEqual([]);
		expect(readdir).toHaveBeenCalledWith("/repo", { withFileTypes: true });

		vi.doUnmock("node:fs/promises");
		vi.resetModules();
	});

	it("ignores symlinks and other non-file directory entries", async () => {
		const rootDir = await createTempProject();
		await writeProjectFile(
			rootDir,
			"src/index.ts",
			"export const value = 1;\n",
		);
		await writeProjectFile(rootDir, "src/real.ts", "export const real = 1;\n");
		await mkdir(path.join(rootDir, "links"), { recursive: true });
		await import("node:fs/promises").then(({ symlink }) =>
			symlink(
				path.join(rootDir, "src", "real.ts"),
				path.join(rootDir, "links", "real-link.ts"),
			),
		);

		const files = await scanProjectFiles(rootDir, [".ts"]);

		expect(files).toEqual(["src/index.ts", "src/real.ts"]);
	});
});
