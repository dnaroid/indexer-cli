import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { readFile } from "node:fs/promises";
const DEFAULT_PROJECT_ID = "default";
function computeHash(text) {
	const normalized = text.replace(/\\r\\n/g, "\\n").replace(/\\uFEFF/g, "").trimEnd();
	return createHash("sha256").update(normalized, "utf-8").digest("hex");
}
${match[0]}
export { getErrorMessage, getErrorDetailParts, describeError, formatAutoIndexError, countChangedFiles, countRemovedFiles, workspaceAlreadyIndexed };`,
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
	workspaceAlreadyIndexed: (
		metadata: {
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
});
