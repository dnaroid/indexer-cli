import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "../../src/core/types.js";
import { SqliteMetadataStore } from "../../src/storage/sqlite.js";
import {
	createTempProject,
	fileExists,
	gitInit,
	readTextFile,
	removeTempProject,
	runCLI,
} from "../helpers/cli-runner-rust";

const TEMP_DIR = path.join(os.tmpdir(), "indexer-cli-e2e-rust");
const FIXTURE_FILE_COUNT = 5;

type IndexedDependency = {
	fromPath: string;
	toSpecifier: string;
	toPath?: string;
	dependencyType: "internal" | "external" | "builtin" | "unresolved";
};

async function listIndexedDependencies(
	filePath: string,
): Promise<IndexedDependency[]> {
	const metadata = new SqliteMetadataStore(
		path.join(TEMP_DIR, ".indexer-cli", "db.sqlite"),
	);

	try {
		await metadata.initialize();
		const snapshot =
			await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
		expect(snapshot).toBeTruthy();
		const dependencies = await metadata.listDependencies(
			DEFAULT_PROJECT_ID,
			snapshot!.id,
			filePath,
		);
		return dependencies.map<IndexedDependency>((dependency) => ({
			fromPath: dependency.fromPath,
			toSpecifier: dependency.toSpecifier,
			toPath: dependency.toPath,
			dependencyType: dependency.dependencyType ?? "unresolved",
		}));
	} finally {
		await metadata.close().catch(() => undefined);
	}
}

describe.sequential("CLI e2e Rust", () => {
	beforeAll(() => {
		removeTempProject(TEMP_DIR);
		createTempProject(TEMP_DIR);
		gitInit(TEMP_DIR);
	}, 30_000);

	afterAll(() => {
		removeTempProject(TEMP_DIR);
	});

	it("initializes indexer data, config, skills, and git hook", () => {
		const result = runCLI(["init"], { cwd: TEMP_DIR });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Initialized indexer-cli");
		expect(fileExists(path.join(TEMP_DIR, ".indexer-cli", "db.sqlite"))).toBe(
			true,
		);
		expect(
			fileExists(path.join(TEMP_DIR, ".git", "hooks", "post-commit")),
		).toBe(true);
		expect(
			readTextFile(path.join(TEMP_DIR, ".git", "hooks", "post-commit")),
		).toContain("idx index");
	});

	it("indexes Rust source files and reports Rust status", () => {
		const result = runCLI(["index", "--full"], { cwd: TEMP_DIR });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Index completed successfully.");

		const status = runCLI(["index", "--status"], { cwd: TEMP_DIR });
		expect(status.exitCode).toBe(0);
		expect(status.stdout).toContain(`Files: ${FIXTURE_FILE_COUNT}`);
		expect(status.stdout).toContain(`Languages: rust: ${FIXTURE_FILE_COUNT}`);
	});

	it("prints Rust AST outlines", () => {
		const result = runCLI(
			["ast", "src/services/order.rs", "--max-depth", "2"],
			{
				cwd: TEMP_DIR,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("AST src/services/order.rs language=rust");
		expect(result.stdout).toContain("struct_item");
		expect(result.stdout).toContain("trait_item");
	});

	it("resolves Rust module and use dependencies", async () => {
		const mainDependencies = await listIndexedDependencies("src/main.rs");
		expect(mainDependencies).toContainEqual(
			expect.objectContaining({
				toSpecifier: "services",
				toPath: "src/services/mod.rs",
				dependencyType: "internal",
			}),
		);

		const orderDependencies = await listIndexedDependencies(
			"src/services/order.rs",
		);
		expect(orderDependencies).toContainEqual(
			expect.objectContaining({
				toSpecifier: "crate::errors::AppError",
				toPath: "src/errors.rs",
				dependencyType: "internal",
			}),
		);
		expect(orderDependencies).toContainEqual(
			expect.objectContaining({
				toSpecifier: "serde::Deserialize",
				dependencyType: "external",
			}),
		);
	});

	it("supports AST call graph mode for Rust callables", () => {
		const result = runCLI(
			["deps", "src/main.rs::main", "--mode", "calls", "--show-edges"],
			{ cwd: TEMP_DIR },
		);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("M src/main.rs::main mode=call-graph");
		expect(result.stdout).toContain(
			"-> src/services/auth.rs::AuthService.new via=new() kind=call",
		);
		expect(result.stdout).toContain(
			"-> src/services/auth.rs::AuthService.verify via=verify() kind=call",
		);
	});
});
