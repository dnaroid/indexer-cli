import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ID } from "../../src/core/types";
import { SqliteMetadataStore } from "../../src/storage/sqlite";
import {
	createTempProject,
	fileExists,
	gitInit,
	readTextFile,
	removeTempProject,
	runCLI,
} from "../helpers/cli-runner-python";

const TEMP_DIR = path.join(os.tmpdir(), "indexer-cli-e2e-python");
const FIXTURE_FILE_COUNT = 34;
const DAG_FIXTURE_PATH =
	"repositories/pipeline-dag/dags/export_copy_partition_to_archive_and_warehouse.py";

type DependencyRecord = {
	fromPath: string;
	toSpecifier: string;
	toPath?: string;
	dependencyType?: "internal" | "external" | "builtin" | "unresolved";
};

function parseSearchResults(
	output: string,
): Array<{ filePath: string; score: number; primarySymbol?: string }> {
	return output
		.split("\n")
		.map((block) => {
			const match = block
				.trim()
				.match(
					/^(.+?):(\d+)-(\d+) \(score: ([\d.]+)(?:, function: (.+?))?\)$/m,
				);
			if (!match) return null;
			return {
				filePath: match[1],
				score: Number.parseFloat(match[4]),
				primarySymbol: match[5] || undefined,
			};
		})
		.filter((result): result is NonNullable<typeof result> => result !== null);
}

async function listStoredDependencies(
	filePath: string,
): Promise<DependencyRecord[]> {
	const store = new SqliteMetadataStore(
		path.join(TEMP_DIR, ".indexer-cli", "db.sqlite"),
	);
	await store.initialize();

	try {
		const snapshot = await store.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
		expect(snapshot).toBeTruthy();
		return await store.listDependencies(
			DEFAULT_PROJECT_ID,
			snapshot!.id,
			filePath,
		);
	} finally {
		await store.close();
	}
}

describe.sequential("CLI e2e Python", () => {
	beforeAll(() => {
		removeTempProject(TEMP_DIR);
		createTempProject(TEMP_DIR);
		gitInit(TEMP_DIR);
	}, 30_000);

	afterAll(() => {
		removeTempProject(TEMP_DIR);
	});

	describe("init", () => {
		it("creates indexer data, config, skills, and git hook", () => {
			const result = runCLI(["init"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Initialized indexer-cli");

			const dataDir = path.join(TEMP_DIR, ".indexer-cli");
			const dbPath = path.join(dataDir, "db.sqlite");
			const configPath = path.join(dataDir, "config.json");
			const hookPath = path.join(TEMP_DIR, ".git", "hooks", "post-commit");
			const skillPath = path.join(
				TEMP_DIR,
				".claude",
				"skills",
				"repo-discovery",
				"SKILL.md",
			);

			expect(fileExists(dataDir)).toBe(true);
			expect(fileExists(dbPath)).toBe(true);
			expect(fileExists(configPath)).toBe(true);
			expect(fileExists(skillPath)).toBe(true);
			expect(fileExists(hookPath)).toBe(true);

			const config = JSON.parse(readTextFile(configPath)) as {
				embeddingModel: string;
				vectorSize: number;
				skillsVersion: number;
			};
			expect(config.embeddingModel).toBe("jina-8k");
			expect(config.vectorSize).toBe(768);
			expect(config.skillsVersion).toBeTypeOf("number");
			expect(
				readdirSync(path.join(TEMP_DIR, ".claude", "skills")).sort(),
			).toEqual(["repo-discovery"]);

			const gitignore = readTextFile(path.join(TEMP_DIR, ".gitignore"));
			expect(gitignore).toContain(".indexer-cli/");
			expect(gitignore).toContain(".claude/");

			const hook = readTextFile(hookPath);
			expect(hook).toContain("idx index");
		});

		it("is idempotent", () => {
			const result = runCLI(["init"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Initialized indexer-cli");
		});
	});

	describe("index --full", () => {
		it("indexes the Python fixture project", () => {
			const result = runCLI(["index", "--full"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Index completed successfully.");
			expect(result.stdout).toContain("Snapshot:");
			expect(result.stdout).toContain("Files indexed:");
			expect(result.stdout).toContain("Chunks created:");
		});

		it("indexes the anonymized Airflow DAG regression fixture without failing init-style full indexing", () => {
			const result = runCLI(["index", "--full"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Index completed successfully.");
			expect(result.stdout).toContain(DAG_FIXTURE_PATH);
			expect(result.stdout).not.toContain("Invalid argument");
			expect(result.stderr).not.toContain("Invalid argument");
		});

		it("reports status for all fixture files", () => {
			const result = runCLI(["index", "--status"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Snapshot:");
			expect(result.stdout).toContain(`Files: ${FIXTURE_FILE_COUNT}`);
			expect(result.stdout).toContain("Symbols:");
			expect(result.stdout).toContain("Chunks:");
			expect(result.stdout).toContain("Dependencies:");
			expect(result.stdout).toContain(
				`Languages: python: ${FIXTURE_FILE_COUNT}`,
			);
		});

		it("shows the indexed file tree", () => {
			const result = runCLI(["index", "--status", "--tree"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("manage.py");
			expect(result.stdout).toContain("src/");
			expect(result.stdout).toContain("repositories/");
			expect(result.stdout).toContain("__main__.py");
			expect(result.stdout).toContain("session.py");
			expect(result.stdout).toContain("processor.py");
			expect(result.stdout).toContain(
				"export_copy_partition_to_archive_and_warehouse.py",
			);
		});

		it("supports dry-run mode", () => {
			const result = runCLI(["index", "--dry-run"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Dry run complete.");
		});
	});

	describe("search", () => {
		it("matches auth session queries more strongly than game session queries", () => {
			const result = runCLI(
				["search", "auth session login token access user", "--max-files", "6"],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			const authCandidates = [
				"src/auth/session.py",
				"src/services/auth.py",
				"src/middleware/auth.py",
				"src/api/v1/handler.py",
				"src/api/v2/routes.py",
				"src/__main__.py",
			]
				.map((filePath) =>
					results.findIndex(
						(searchResult) => searchResult.filePath === filePath,
					),
				)
				.filter((index) => index >= 0)
				.sort((left, right) => left - right);
			const authIndex = authCandidates[0] ?? -1;
			const gameIndex = results.findIndex(
				(searchResult) => searchResult.filePath === "src/game/session.py",
			);

			expect(authIndex).toBeGreaterThanOrEqual(0);
			if (gameIndex >= 0) {
				expect(authIndex).toBeLessThan(gameIndex);
			}
			expect(results[authIndex]?.score).toBeGreaterThan(0.4);
		});

		it("matches game round queries more strongly than auth session queries", () => {
			const result = runCLI(
				[
					"search",
					"game round match score players session",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);

			const gameIndex = results.findIndex(
				(searchResult) => searchResult.filePath === "src/game/session.py",
			);
			const authIndex = results.findIndex(
				(searchResult) => searchResult.filePath === "src/auth/session.py",
			);

			expect(gameIndex).toBeGreaterThanOrEqual(0);
			if (authIndex >= 0) {
				expect(gameIndex).toBeLessThan(authIndex);
			}
			expect(results[gameIndex]?.score).toBeGreaterThan(0.4);
		});

		it("ranks payment processing files above unrelated infrastructure", () => {
			const result = runCLI(
				[
					"search",
					"payment processing provider charge checkout receipt",
					"--max-files",
					"5",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(
				results.some((result) => result.filePath.startsWith("src/payments/")),
			).toBe(true);
			const backgroundFiles = results.filter(
				(result) =>
					result.filePath.startsWith("src/middleware/") ||
					result.filePath.startsWith("src/helpers/") ||
					result.filePath.startsWith("src/db/"),
			);
			expect(backgroundFiles.length).toBeLessThan(results.length);
		});

		it("finds the error hierarchy for error handling queries", () => {
			const result = runCLI(
				[
					"search",
					"error handling validation not found app error",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);
			expect(result.exitCode).toBe(0);

			const errorsIndex = results.findIndex(
				(searchResult) => searchResult.filePath === "src/utils/errors.py",
			);
			expect(errorsIndex).toBeGreaterThanOrEqual(0);
			expect(results[errorsIndex]?.score).toBeGreaterThan(0.4);
		});

		it("respects --min-score to filter noise", () => {
			const result = runCLI(
				[
					"search",
					"authentication login token session",
					"--max-files",
					"10",
					"--min-score",
					"0.5",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			for (const result of results) {
				expect(result.score).toBeGreaterThanOrEqual(0.5);
			}
			expect(results.length).toBeGreaterThan(0);
		});

		it("respects --max-files", () => {
			const result = runCLI(
				["search", "user validation profile account", "--max-files", "1"],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(results.length).toBeLessThanOrEqual(1);
		});

		it("includes content with --include-content and omits it by default", () => {
			const withContent = runCLI(
				[
					"search",
					"logger debug event context json",
					"--include-content",
					"--max-files",
					"3",
				],
				{ cwd: TEMP_DIR },
			);
			const withoutContent = runCLI(
				["search", "logger debug event context json", "--max-files", "3"],
				{ cwd: TEMP_DIR },
			);
			const withContentLines = withContent.stdout
				.split("\n")
				.filter((line) => line.trim() !== "" && line.trim() !== "---");
			const withoutContentLines = withoutContent.stdout
				.split("\n")
				.filter((line) => line.trim() !== "" && line.trim() !== "---");
			const withoutContentResults = parseSearchResults(withoutContent.stdout);

			expect(withContent.exitCode).toBe(0);
			expect(withoutContent.exitCode).toBe(0);
			expect(parseSearchResults(withContent.stdout).length).toBeGreaterThan(0);
			expect(withContent.stdout).toContain("class AppLogger");
			expect(withoutContent.stdout).not.toContain("class AppLogger");
		});

		it("renders text output", () => {
			const result = runCLI(
				["search", "logger debug event context json", "--max-files", "3"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("score:");
			expect(result.stdout).toContain("src/logging/logger.py");
		});

		it("respects --path-prefix", () => {
			const result = runCLI(
				[
					"search",
					"order validation receipt payment user",
					"--path-prefix",
					"src/services",
					"--max-files",
					"5",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(results.length).toBeGreaterThan(0);
			for (const searchResult of results) {
				expect(searchResult.filePath.startsWith("src/services")).toBe(true);
			}
		});

		it("reports function names, not local variable names, in function metadata", () => {
			const result = runCLI(
				[
					"search",
					"session token validate user authentication",
					"--max-files",
					"10",
					"--min-score",
					"0.4",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(results.length).toBeGreaterThan(0);

			for (const searchResult of results) {
				if (searchResult.primarySymbol) {
					expect(searchResult.primarySymbol).not.toBe("email");
					expect(searchResult.primarySymbol).not.toBe("name");
					expect(searchResult.primarySymbol).not.toBe("normalized");
					expect(searchResult.primarySymbol).not.toBe("payload");
					expect(searchResult.primarySymbol).not.toBe("token");
					expect(searchResult.primarySymbol).not.toBe("session");
					expect(searchResult.primarySymbol).not.toBe("expires_at");
				}
			}
		});
	});

	describe("structure", () => {
		it("returns a text tree with files and symbols", () => {
			const result = runCLI(["structure"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/");
			expect(result.stdout).toContain("processor.py");
			expect(result.stdout).toContain(
				"class: PaymentAuditHook, PaymentProcessor, PaymentReceipt, PaymentRequest",
			);
		});

		it("filters classes with --kind class", () => {
			const result = runCLI(["structure", "--kind", "class"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("class: Policy, UserValidator");
			expect(result.stdout).not.toContain("function:");
		});

		it("filters functions with --kind function", () => {
			const result = runCLI(["structure", "--kind", "function"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"function: create_access_session, create_session, login_user, read_access_token, validate_token",
			);
			expect(result.stdout).not.toContain("class:");
		});

		it("renders text output", () => {
			const result = runCLI(["structure"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/");
			expect(result.stdout).toContain("PaymentProcessor");
		});

		it("respects --path-prefix", () => {
			const result = runCLI(["structure", "--path-prefix", "src/payments"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("processor.py");
			expect(result.stdout).toContain("stripe.py");
			expect(result.stdout).not.toContain("session.py");
		});

		it("shows deeply nested files with --max-depth 3", () => {
			const result = runCLI(["structure", "--max-depth", "3"], {
				cwd: TEMP_DIR,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("v1/");
			expect(result.stdout).toContain("handler.py");
		});

		it("distinguishes same-named files in different directories", () => {
			const result = runCLI(["structure", "--path-prefix", "src/api"], {
				cwd: TEMP_DIR,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout.match(/handler\.py/g)?.length).toBe(2);
		});
	});

	describe("architecture", () => {
		it("returns file stats, entrypoints, and dependency data", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain(`  python: ${FIXTURE_FILE_COUNT}`);
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("manage.py");
			expect(result.stdout).toContain("src/__main__.py");
			expect(result.stdout).toContain("Module dependency graph");
			expect(result.stdout).toContain("Unresolved dependencies");
		});

		it("renders text output", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("Module dependency graph");
		});

		it("respects --path-prefix", () => {
			const result = runCLI(["architecture", "--path-prefix", "src/payments"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("  python: 2");
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("  none");
		});

		it("detects multiple entrypoints", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("manage.py");
			expect(result.stdout).toContain("src/__main__.py");
		});
	});

	describe("explain", () => {
		it("explains create_session", () => {
			const result = runCLI(["explain", "create_session"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: create_session");
			expect(result.stdout).toContain("Kind:   function");
			expect(result.stdout).toContain("File:   src/auth/session.py");
			expect(result.stdout).toMatch(/lines \d+-\d+/);
		});

		it("explains UserValidator", () => {
			const result = runCLI(["explain", "UserValidator"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: UserValidator");
			expect(result.stdout).toContain("Kind:   class");
			expect(result.stdout).toContain("src/services/user.py");
		});

		it("explains PaymentProcessor and AppError", () => {
			const paymentProcessor = runCLI(["explain", "PaymentProcessor"], {
				cwd: TEMP_DIR,
			});
			const appError = runCLI(["explain", "AppError"], { cwd: TEMP_DIR });

			expect(paymentProcessor.exitCode).toBe(0);
			expect(paymentProcessor.stdout).toContain("Kind:   class");
			expect(paymentProcessor.stdout).toContain("src/payments/processor.py");
			expect(appError.exitCode).toBe(0);
			expect(appError.stdout).toContain("Kind:   class");
			expect(appError.stdout).toContain("src/utils/errors.py");
		});

		it("supports file::symbol syntax", () => {
			const result = runCLI(
				["explain", "src/payments/processor.py::PaymentProcessor"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: PaymentProcessor");
			expect(result.stdout).toContain("File:   src/payments/processor.py");
		});

		it("renders text output", () => {
			const result = runCLI(["explain", "AppError"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: AppError");
			expect(result.stdout).toContain("Kind:");
		});

		it("returns an error for unknown symbols", () => {
			const result = runCLI(["explain", "missing_symbol_xyz"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(1);
			expect(`${result.stdout}\n${result.stderr}`).toMatch(
				/symbol not found|not found/i,
			);
		});

		it("returns multiple results for ambiguous handle_request symbol", () => {
			const result = runCLI(["explain", "handle_request"], { cwd: TEMP_DIR });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/api/v1/handler.py");
			expect(result.stdout).toContain("src/api/v2/handler.py");
			expect(result.stdout.match(/^Symbol:/gm)?.length).toBeGreaterThan(1);
		});
	});

	describe("deps", () => {
		it("returns a stable dependency response for order services", () => {
			const result = runCLI(["deps", "src/services/order.py"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: src/services/order.py");
			expect(result.stdout).toContain("Callers");
			expect(result.stdout).toContain("Callees");
		});

		it("respects --direction callers", () => {
			const result = runCLI(
				["deps", "src/services/order.py", "--direction", "callers"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Callers");
			expect(result.stdout).not.toContain("Callees");
		});

		it("respects --direction callees and --depth", () => {
			const result = runCLI(
				[
					"deps",
					"src/services/order.py",
					"--direction",
					"callees",
					"--depth",
					"2",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Callers");
			expect(result.stdout).toContain("Callees");
		});

		it("resolves internal Python module imports for core engine callees", async () => {
			const result = runCLI(
				["deps", "src/core/engine.py", "--direction", "callees"],
				{ cwd: TEMP_DIR },
			);
			const dependencies = await listStoredDependencies("src/core/engine.py");

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Callers");
			expect(result.stdout).toContain("src/config/settings.py");
			expect(result.stdout).toContain("src/utils/helpers.py");
			expect(dependencies).toContainEqual(
				expect.objectContaining({
					toSpecifier: "src.config.settings",
					toPath: "src/config/settings.py",
					dependencyType: "internal",
				}),
			);
			expect(dependencies).toContainEqual(
				expect.objectContaining({
					toSpecifier: "src.utils.helpers",
					toPath: "src/utils/helpers.py",
					dependencyType: "internal",
				}),
			);
		});

		it("resolves from-import session dependencies for api v1 handlers", async () => {
			const result = runCLI(
				["deps", "src/api/v1/handler.py", "--direction", "callees"],
				{ cwd: TEMP_DIR },
			);
			const dependencies = await listStoredDependencies(
				"src/api/v1/handler.py",
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/auth/session.py");
			expect(dependencies).toContainEqual(
				expect.objectContaining({
					toSpecifier: "src.auth.session",
					toPath: "src/auth/session.py",
					dependencyType: "internal",
				}),
			);
		});

		it("classifies builtin Python imports in stored dependency metadata", async () => {
			const loggerDependencies = await listStoredDependencies(
				"src/logging/logger.py",
			);
			const settingsDependencies = await listStoredDependencies(
				"src/config/settings.py",
			);
			const manageDependencies = await listStoredDependencies("manage.py");

			expect(loggerDependencies).toContainEqual(
				expect.objectContaining({
					toSpecifier: "json",
					dependencyType: "builtin",
				}),
			);
			expect(settingsDependencies).toContainEqual(
				expect.objectContaining({
					toSpecifier: "os",
					dependencyType: "builtin",
				}),
			);
			expect(manageDependencies).toContainEqual(
				expect.objectContaining({
					toSpecifier: "os",
					dependencyType: "builtin",
				}),
			);
			expect(manageDependencies).toContainEqual(
				expect.objectContaining({
					toSpecifier: "sys",
					dependencyType: "builtin",
				}),
			);
		});

		it("renders text output", () => {
			const result = runCLI(["deps", "src/services/order.py"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: src/services/order.py");
			expect(result.stdout).toContain("Callers");
		});

		it("handles worker cycle queries without error", () => {
			const result = runCLI(["deps", "src/workers/email.py"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: src/workers/email.py");
			expect(result.stdout).toContain("Callers");
			expect(result.stdout).toContain("Callees");
		});
	});

	describe("uninstall", () => {
		it("removes indexer data, skills, gitignore entries, and git hook", () => {
			const result = runCLI(["uninstall", "--force"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removed");
			expect(fileExists(path.join(TEMP_DIR, ".indexer-cli"))).toBe(false);
			expect(fileExists(path.join(TEMP_DIR, ".claude"))).toBe(false);

			const gitignore = readTextFile(path.join(TEMP_DIR, ".gitignore"));
			expect(gitignore).not.toContain(".indexer-cli/");
			expect(gitignore).not.toContain(".claude/");

			const hookPath = path.join(TEMP_DIR, ".git", "hooks", "post-commit");
			if (fileExists(hookPath)) {
				expect(readTextFile(hookPath)).not.toContain("indexer-cli");
			}
		});

		it("is idempotent", () => {
			const result = runCLI(["uninstall", "--force"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Nothing to remove");
		});
	});
});
