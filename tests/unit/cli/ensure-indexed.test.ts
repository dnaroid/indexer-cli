import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

async function loadEnsureIndexedInternals<T>(): Promise<T> {
	const filePath = path.resolve(
		import.meta.dirname,
		"../../../src/cli/commands/ensure-indexed.ts",
	);
	const source = readFileSync(filePath, "utf8");
	const match = source.match(
		/function getErrorMessage[\s\S]*?(?=\/\*\*\n \* Returns true if every workspace-modified\/added file)/,
	);
	if (!match) {
		throw new Error(
			`Unable to extract ensure-indexed helpers from ${filePath}`,
		);
	}

	const transpiled = ts.transpileModule(
		`${match[0]}\nexport { getErrorMessage, getErrorDetailParts, describeError, formatAutoIndexError };`,
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
}>();

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
});
