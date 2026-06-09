import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import ts from "typescript";

async function loadEnsureIndexedInternals<T>(): Promise<T> {
	const filePath = path.resolve(
		import.meta.dirname,
		"../../../src/cli/commands/ensure-indexed.ts",
	);
	const source = readFileSync(filePath, "utf8");
	const match = source.match(
		/const INDEXED_EXTENSIONS[\s\S]*?(?=\nasync function getIndexPlan\()/,
	);
	if (!match) {
		throw new Error(
			`Unable to extract ensure-indexed helpers from ${filePath}`,
		);
	}

	const transpiled = ts.transpileModule(
		`import path, { extname } from "node:path";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
const DEFAULT_PROJECT_ID = "default";
const config = { get: (key) => key === "indexIncludePaths" ? [] : undefined };
async function getIndexLockStatus() { return { status: "locked" }; }
function computeHash(text) {
	const normalized = text.replace(/\\r\\n/g, "\\n").replace(/\\uFEFF/g, "").trimEnd();
	return createHash("sha256").update(normalized, "utf-8").digest("hex");
}
async function scanProjectFiles(rootPath, codeExtensions) {
	const allowed = new Set(codeExtensions.map((ext) => ext.toLowerCase()));
	let ignored = [];
	try {
		ignored = (await readFile(path.join(rootPath, ".gitignore"), "utf8"))
			.split(/\\r?\\n/)
			.map((line) => line.trim().replace(/\\\/$/, ""))
			.filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
	} catch {}
	const files = [];
	async function walk(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const fullPath = path.join(dir, entry.name);
			const relativePath = path.relative(rootPath, fullPath).replace(/\\\\/g, "/");
			if (ignored.some((pattern) => relativePath === pattern || relativePath.startsWith(pattern + "/"))) continue;
			if (entry.isDirectory()) await walk(fullPath);
			if (entry.isFile() && allowed.has(extname(relativePath).toLowerCase())) files.push(relativePath);
		}
	}
	await walk(rootPath);
	return files.sort();
}
${match[0]}
export { getErrorMessage, getErrorDetailParts, describeError, formatAutoIndexError, countChangedFiles, countRemovedFiles, useExistingIndexOnLockHeld, workspaceAlreadyIndexed };`,
		{
			compilerOptions: {
				module: ts.ModuleKind.ES2022,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText;

	const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
	return (await import(moduleUrl)) as T;
}

const ensureIndexedInternals = await loadEnsureIndexedInternals<{
	getErrorMessage: (error: unknown) => string;
	getErrorDetailParts: (error: unknown) => string[];
	describeError: (error: unknown) => string;
	formatAutoIndexError: (
		error: unknown,
		mode: "full" | "incremental",
	) => string;
	countChangedFiles: (changedFiles: {
		added: string[];
		modified: string[];
		deleted: string[];
	}) => number | undefined;
	countRemovedFiles: (changedFiles: {
		added: string[];
		modified: string[];
		deleted: string[];
	}) => number | undefined;
	useExistingIndexOnLockHeld: (
		metadata: {
			getLatestCompletedSnapshot: (projectId: string) => Promise<unknown>;
		},
		repoRoot: string,
		options: {
			silent: boolean;
			startedAt: number;
			getLockStatus?: (
				repoRoot: string,
			) => Promise<{ status: "unlocked" | "locked" | "stale" }>;
		},
	) => Promise<{
		status: "stale" | "failed";
		reason: string;
		action?: string;
		ms: number;
	}>;
	workspaceAlreadyIndexed: (
		metadata: {
			listFiles: (
				projectId: string,
				snapshotId: string,
			) => Promise<Array<{ path: string }>>;
			getFile: (
				projectId: string,
				snapshotId: string,
				filePath: string,
			) => Promise<{ sha256: string } | undefined>;
		},
		repoRoot: string,
		snapshot: { id: string },
		workspaceChanges: {
			added: string[];
			modified: string[];
			deleted: string[];
		},
	) => Promise<boolean>;
}>();

function computeTestHash(text: string): string {
	const normalized = text
		.replace(/\r\n/g, "\n")
		.replace(/\uFEFF/g, "")
		.trimEnd();
	return createHash("sha256").update(normalized, "utf-8").digest("hex");
}

function metadataFromRecords(records = new Map<string, { sha256: string }>()) {
	return {
		listFiles: async () =>
			Array.from(records.keys()).map((filePath) => ({ path: filePath })),
		getFile: async (
			_projectId: string,
			_snapshotId: string,
			filePath: string,
		) => records.get(filePath),
	};
}

describe("ensureIndexed error formatting", () => {
	it("collects system error details from structured errors", () => {
		const error = Object.assign(new Error("Invalid argument"), {
			code: "EINVAL",
			syscall: "open",
			path: "repositories/pipeline-dag/dags/export_copy_partition_to_archive_and_warehouse.py",
		});

		expect(ensureIndexedInternals.getErrorMessage(error)).toBe(
			"Invalid argument",
		);
		expect(ensureIndexedInternals.getErrorDetailParts(error)).toEqual([
			"code: EINVAL",
			"syscall: open",
			"path: repositories/pipeline-dag/dags/export_copy_partition_to_archive_and_warehouse.py",
		]);
	});

	it("includes nested causes in the detailed error description", () => {
		const cause = Object.assign(new Error("Invalid argument"), {
			code: "EINVAL",
			syscall: "open",
			path: "repositories/pipeline-dag/dags/export_copy_partition_to_archive_and_warehouse.py",
		});
		const error = Object.assign(
			new Error(
				"Failed while persisting batch [25-32] (repositories/pipeline-dag/dags/export_copy_partition_to_archive_and_warehouse.py .. src/app.py): Invalid argument",
			),
			{ cause },
		);

		expect(ensureIndexedInternals.describeError(error)).toBe(
			"Failed while persisting batch [25-32] (repositories/pipeline-dag/dags/export_copy_partition_to_archive_and_warehouse.py .. src/app.py): Invalid argument; cause: Invalid argument (code: EINVAL, syscall: open, path: repositories/pipeline-dag/dags/export_copy_partition_to_archive_and_warehouse.py)",
		);
	});

	it("formats the user-facing auto-index error with reindex mode and details", () => {
		const cause = Object.assign(new Error("Invalid argument"), {
			code: "EINVAL",
			syscall: "scandir",
			path: "repositories/pipeline-dag/dags",
		});
		const error = Object.assign(
			new Error(
				"Failed after indexing 80 files while generating architecture snapshot: Invalid argument",
			),
			{ cause },
		);

		expect(ensureIndexedInternals.formatAutoIndexError(error, "full")).toBe(
			"Auto-indexing failed during full reindex: Failed after indexing 80 files while generating architecture snapshot: Invalid argument; cause: Invalid argument (code: EINVAL, syscall: scandir, path: repositories/pipeline-dag/dags)",
		);
	});

	it("counts updated and removed files for compact IDX output", () => {
		const changedFiles = {
			added: ["src/new.ts"],
			modified: ["src/existing.ts", "src/other.ts"],
			deleted: ["src/old.ts"],
		};

		expect(ensureIndexedInternals.countChangedFiles(changedFiles)).toBe(3);
		expect(ensureIndexedInternals.countRemovedFiles(changedFiles)).toBe(1);
	});

	it("uses an existing completed snapshot when the auto-index lock remains held", async () => {
		const result = await ensureIndexedInternals.useExistingIndexOnLockHeld(
			{
				getLatestCompletedSnapshot: async () => ({ id: "snapshot-completed" }),
			},
			"/repo",
			{
				silent: true,
				startedAt: Date.now(),
				getLockStatus: async () => ({ status: "locked" }),
			},
		);

		expect(result).toMatchObject({
			status: "stale",
			reason: "lock-held",
			action: "using-existing-index",
		});
		expect(result.ms).toBeGreaterThanOrEqual(0);
	});

	it("reports stale locks while falling back to an existing completed snapshot", async () => {
		const result = await ensureIndexedInternals.useExistingIndexOnLockHeld(
			{
				getLatestCompletedSnapshot: async () => ({ id: "snapshot-completed" }),
			},
			"/repo",
			{
				silent: true,
				startedAt: Date.now(),
				getLockStatus: async () => ({ status: "stale" }),
			},
		);

		expect(result).toMatchObject({
			status: "stale",
			reason: "stale-lock",
			action: "using-existing-index",
		});
	});

	it("fails clearly when the auto-index lock remains held and no completed snapshot exists", async () => {
		const result = await ensureIndexedInternals.useExistingIndexOnLockHeld(
			{
				getLatestCompletedSnapshot: async () => null,
			},
			"/repo",
			{
				silent: true,
				startedAt: Date.now(),
				getLockStatus: async () => ({ status: "locked" }),
			},
		);

		expect(result).toMatchObject({
			status: "failed",
			reason: "lock-held",
			action: "run-idx-index",
		});
	});

	it("treats workspace deletions as already indexed when absent from the snapshot", async () => {
		await expect(
			ensureIndexedInternals.workspaceAlreadyIndexed(
				metadataFromRecords(),
				"/repo",
				{ id: "snapshot-1" },
				{
					added: [],
					modified: [],
					deleted: ["src/old.ts"],
				},
			),
		).resolves.toBe(true);
	});

	it("keeps reindexing a workspace deletion until it is absent from the snapshot", async () => {
		const records = new Map<string, { sha256: string }>([
			["src/old.ts", { sha256: "previous" }],
		]);

		await expect(
			ensureIndexedInternals.workspaceAlreadyIndexed(
				metadataFromRecords(records),
				"/repo",
				{ id: "snapshot-1" },
				{
					added: [],
					modified: [],
					deleted: ["src/old.ts"],
				},
			),
		).resolves.toBe(false);
	});

	it("handles already indexed mixed workspace changes including deletions", async () => {
		const repoRoot = await mkdtemp(path.join(tmpdir(), "idx-ensure-indexed-"));
		try {
			await writeFile(path.join(repoRoot, "kept.ts"), "export const kept = 1;\n");
			const records = new Map<string, { sha256: string }>([
				["kept.ts", { sha256: computeTestHash("export const kept = 1;\n") }],
			]);

			await expect(
				ensureIndexedInternals.workspaceAlreadyIndexed(
					metadataFromRecords(records),
					repoRoot,
					{ id: "snapshot-1" },
					{
						added: [],
						modified: ["kept.ts"],
						deleted: ["deleted.ts"],
					},
				),
			).resolves.toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	it("treats .gitignore workspace changes as already indexed when the snapshot file set matches", async () => {
		const repoRoot = await mkdtemp(path.join(tmpdir(), "idx-ensure-indexed-"));
		try {
			await writeFile(path.join(repoRoot, ".gitignore"), "# comment only\n");
			await writeFile(path.join(repoRoot, "kept.ts"), "export const kept = 1;\n");
			const records = new Map<string, { sha256: string }>([
				["kept.ts", { sha256: computeTestHash("export const kept = 1;\n") }],
			]);

			await expect(
				ensureIndexedInternals.workspaceAlreadyIndexed(
					metadataFromRecords(records),
					repoRoot,
					{ id: "snapshot-1" },
					{
						added: [],
						modified: [".gitignore"],
						deleted: [],
					},
				),
			).resolves.toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	it("keeps reindexing .gitignore workspace changes until the snapshot file set matches", async () => {
		const repoRoot = await mkdtemp(path.join(tmpdir(), "idx-ensure-indexed-"));
		try {
			await mkdir(path.join(repoRoot, "ignored"));
			await writeFile(path.join(repoRoot, ".gitignore"), "ignored/\n");
			await writeFile(path.join(repoRoot, "kept.ts"), "export const kept = 1;\n");
			await writeFile(
				path.join(repoRoot, "ignored", "old.ts"),
				"export const old = 1;\n",
			);
			const records = new Map<string, { sha256: string }>([
				["kept.ts", { sha256: computeTestHash("export const kept = 1;\n") }],
				["ignored/old.ts", { sha256: computeTestHash("export const old = 1;\n") }],
			]);

			await expect(
				ensureIndexedInternals.workspaceAlreadyIndexed(
					metadataFromRecords(records),
					repoRoot,
					{ id: "snapshot-1" },
					{
						added: [],
						modified: [".gitignore"],
						deleted: [],
					},
				),
			).resolves.toBe(false);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
});
