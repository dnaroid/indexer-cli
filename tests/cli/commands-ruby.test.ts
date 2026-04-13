import { writeFileSync } from "node:fs";
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
} from "../helpers/cli-runner-ruby";

const TEMP_DIR = path.join(os.tmpdir(), "indexer-cli-e2e-ruby");
const FIXTURE_FILE_COUNT = 31;

type IndexedDependency = {
	fromPath: string;
	toSpecifier: string;
	toPath?: string;
	kind: string;
	dependencyType: "internal" | "external" | "builtin" | "unresolved";
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
			kind: dependency.kind,
			dependencyType: dependency.dependencyType ?? "unresolved",
		}));
	} finally {
		await metadata.close().catch(() => undefined);
	}
}

describe.sequential("CLI e2e Ruby", () => {
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
				"semantic-search",
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
			};
			expect(config.embeddingModel).toBe("jina-8k");
			expect(config.vectorSize).toBe(768);

			const gitignore = readTextFile(path.join(TEMP_DIR, ".gitignore"));
			expect(gitignore).toContain(".indexer-cli/");
			expect(gitignore).toContain(".claude/");

			const hook = readTextFile(hookPath);
			expect(hook).toContain("indexer-cli index");
		});

		it("is idempotent", () => {
			const result = runCLI(["init"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Initialized indexer-cli");
		});
	});

	describe("index --full", () => {
		it("indexes the Ruby fixture project", () => {
			const result = runCLI(["index", "--full"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Index completed successfully.");
			expect(result.stdout).toContain("Files indexed:");
			expect(result.stdout).toContain("Chunks created:");
		});

		it("reports status for all fixture files", () => {
			const result = runCLI(["index", "--status"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Snapshot:");
			expect(result.stdout).toContain(`Files: ${FIXTURE_FILE_COUNT}`);
			expect(result.stdout).toContain("Symbols:");
			expect(result.stdout).toContain("Chunks:");
			expect(result.stdout).toContain("Dependencies:");
			expect(result.stdout).toContain(`Languages: ruby: ${FIXTURE_FILE_COUNT}`);
		});

		it("shows the indexed file tree", () => {
			const result = runCLI(["index", "--status", "--tree"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("bin/");
			expect(result.stdout).toContain("app.rb");
			expect(result.stdout).toContain("lib/");
			expect(result.stdout).toContain("session.rb");
			expect(result.stdout).toContain("processor.rb");
			expect(result.stdout).toContain("errors.rb");
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
				["search", "auth session login token user access", "--max-files", "6"],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);

			const authIndex = results.findIndex((searchResult) =>
				[
					"lib/auth/session.rb",
					"lib/services/auth.rb",
					"lib/middleware/auth.rb",
				].includes(searchResult.filePath),
			);
			const gameIndex = results.findIndex(
				(searchResult) => searchResult.filePath === "lib/game/session.rb",
			);

			expect(authIndex).toBeGreaterThanOrEqual(0);
			if (gameIndex >= 0) {
				expect(authIndex).toBeLessThan(gameIndex);
			}
			expect(results[authIndex]?.score).toBeGreaterThan(0.35);
		});

		it("matches game round queries more strongly than auth session queries", () => {
			const result = runCLI(
				[
					"search",
					"game round match players scoreboard session",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);

			const gameIndex = results.findIndex(
				(searchResult) => searchResult.filePath === "lib/game/session.rb",
			);
			const authIndex = results.findIndex(
				(searchResult) => searchResult.filePath === "lib/auth/session.rb",
			);

			expect(gameIndex).toBeGreaterThanOrEqual(0);
			if (authIndex >= 0) {
				expect(gameIndex).toBeLessThan(authIndex);
			}
			expect(results[gameIndex]?.score).toBeGreaterThan(0.35);
		});

		it("finds payment processing abstractions and implementations", () => {
			const result = runCLI(
				[
					"search",
					"payment processing provider charge refund checkout stripe",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(
				results.some((result) => result.filePath.startsWith("lib/payments/")),
			).toBe(true);
			const processorIndex = results.findIndex(
				(searchResult) => searchResult.filePath === "lib/payments/processor.rb",
			);
			const stripeIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath === "lib/payments/stripe_processor.rb",
			);
			expect(processorIndex >= 0 || stripeIndex >= 0).toBe(true);
		});

		it("finds Sinatra-oriented entrypoint queries", () => {
			const result = runCLI(
				["search", "sinatra request route cli app", "--max-files", "4"],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(
				results.findIndex(
					(searchResult) => searchResult.filePath === "bin/app.rb",
				),
			).toBeGreaterThanOrEqual(0);
		});

		it("respects --min-score to filter noise", () => {
			const result = runCLI(
				[
					"search",
					"authentication login token session",
					"--max-files",
					"10",
					"--min-score",
					"0.45",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			for (const result of results) {
				expect(result.score).toBeGreaterThanOrEqual(0.45);
			}
			expect(results.length).toBeGreaterThan(0);
		});

		it("respects --max-files", () => {
			const result = runCLI(
				[
					"search",
					"service order creation user validation",
					"--max-files",
					"1",
				],
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
					"pagination offset limit helper",
					"--include-content",
					"--max-files",
					"3",
				],
				{ cwd: TEMP_DIR },
			);
			const withoutContent = runCLI(
				["search", "pagination offset limit helper", "--max-files", "3"],
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
			expect(withContentLines.length).toBeGreaterThan(
				withoutContentResults.length,
			);
			expect(withoutContentLines.length).toBe(withoutContentResults.length);
		});

		it("renders text output", () => {
			const result = runCLI(
				["search", "pagination offset limit helper", "--max-files", "3"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("score:");
			expect(result.stdout).toContain("lib/helpers/pagination_helper.rb");
		});

		it("respects --path-prefix", () => {
			const result = runCLI(
				[
					"search",
					"user validation create user session",
					"--path-prefix",
					"lib/services",
					"--max-files",
					"5",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(results.length).toBeGreaterThan(0);
			for (const searchResult of results) {
				expect(searchResult.filePath.startsWith("lib/services")).toBe(true);
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
					expect(searchResult.primarySymbol).not.toBe("session");
					expect(searchResult.primarySymbol).not.toBe("token");
					expect(searchResult.primarySymbol).not.toBe("metadata");
					expect(searchResult.primarySymbol).not.toBe("normalized_user_id");
				}
			}
		});
	});

	describe("structure", () => {
		it("returns a text tree with files and symbols", () => {
			const result = runCLI(["structure"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("lib/");
			expect(result.stdout).toContain("processor.rb");
			expect(result.stdout).toContain("module: Payments, ProcessorBase");
		});

		it("filters classes with --kind class", () => {
			const result = runCLI(["structure", "--kind", "class"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("class: UserService");
			expect(result.stdout).not.toContain("method:");
		});

		it("filters methods with --kind method", () => {
			const result = runCLI(["structure", "--kind", "method"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"method: create_session, login_access, validate_token",
			);
			expect(result.stdout).not.toContain("class:");
		});

		it("filters modules with --kind module", () => {
			const result = runCLI(["structure", "--kind", "module"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("module: Payments, ProcessorBase");
			expect(result.stdout).not.toContain("class:");
		});

		it("shows private Ruby methods as non-exported", () => {
			const result = runCLI(
				[
					"structure",
					"--path-prefix",
					"lib/services/user_service.rb",
					"--include-internal",
				],
				{
					cwd: TEMP_DIR,
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"method (internal): build_name, normalize_email",
			);
			expect(result.stdout).not.toContain(
				"method: build_name, normalize_email",
			);
		});

		it("renders text output", () => {
			const result = runCLI(["structure"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("lib/");
			expect(result.stdout).toContain("ProcessorBase");
		});

		it("respects --path-prefix and distinguishes same-named handlers", () => {
			const result = runCLI(["structure", "--path-prefix", "lib/api"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout.match(/handler\.rb/g)?.length).toBe(2);
		});

		it("shows deeply nested files with --max-depth 2", () => {
			const result = runCLI(["structure", "--max-depth", "2"], {
				cwd: TEMP_DIR,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("lib/api/v");
		});
	});

	describe("architecture", () => {
		it("returns file stats, entrypoints, and internal dependencies", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain(`  ruby: ${FIXTURE_FILE_COUNT}`);
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("bin/app.rb");
			expect(result.stdout).toContain("Module dependency graph");
			expect(result.stdout).toMatch(/payments|services|auth/);
		});

		it("renders text output", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("Module dependency graph");
		});

		it("respects --path-prefix", () => {
			const result = runCLI(["architecture", "--path-prefix", "lib/payments"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("  ruby: 2");
			expect(result.stdout).toContain("Module dependency graph");
			expect(result.stdout).toContain("lib/");
			expect(result.stdout).toContain("payments");
		});

		it("detects the Ruby bin entrypoint", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("bin/app.rb");
		});
	});

	describe("context", () => {
		it("returns text context with modules, symbols, and dependencies", () => {
			const result = runCLI(["context"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("## Modules");
			expect(result.stdout).toContain("bin/app.rb");
			expect(result.stdout).toContain("## Key Symbols");
			expect(result.stdout).toContain(
				"lib/services/user_service.rb::UserService",
			);
			expect(result.stdout).toContain(
				"lib/payments/processor.rb::ProcessorBase",
			);
			expect(result.stdout).not.toContain("## Architecture");
			expect(result.stdout).not.toContain("Estimated tokens:");
		});

		it("renders text output", () => {
			const result = runCLI(["context"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("## Modules");
			expect(result.stdout).toContain("## Key Symbols");
		});

		it("supports --scope changed", () => {
			const orderPath = path.join(
				TEMP_DIR,
				"lib",
				"services",
				"order_service.rb",
			);
			const original = readTextFile(orderPath);
			const updated = original.replace(
				'status: "created"',
				'status: "submitted"',
			);

			writeFileSync(orderPath, updated, "utf-8");

			const result = runCLI(["context", "--scope", "changed"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("lib/services/order_service.rb");
		});

		it("respects --max-deps", () => {
			const result = runCLI(["context", "--max-deps", "1"], {
				cwd: TEMP_DIR,
			});
			const dependencySection =
				result.stdout.split("## Module Dependencies")[1] ?? "";
			const dependencyLines = dependencySection
				.split("\n")
				.filter((line) => line.includes(" -> "));

			expect(result.exitCode).toBe(0);
			expect(dependencyLines.length).toBeLessThanOrEqual(1);
		});

		it("resolves relevant-to scope across module boundaries", () => {
			const result = runCLI(
				["context", "--scope", "relevant-to:lib/services/order_service.rb"],
				{
					cwd: TEMP_DIR,
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("lib/services/order_service.rb");
		});
	});

	describe("explain", () => {
		it("explains create_session", () => {
			const result = runCLI(["explain", "create_session"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: create_session");
			expect(result.stdout).toContain("Kind:   method");
			expect(result.stdout).toContain("File:   lib/auth/session.rb");
			expect(result.stdout).toMatch(/lines \d+-\d+/);
		});

		it("explains UserService", () => {
			const result = runCLI(["explain", "UserService"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: UserService");
			expect(result.stdout).toContain("Kind:   class");
			expect(result.stdout).toContain("lib/services/user_service.rb");
		});

		it("explains ProcessorBase", () => {
			const result = runCLI(["explain", "ProcessorBase"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: ProcessorBase");
			expect(result.stdout).toContain("Kind:   module");
			expect(result.stdout).toContain("lib/payments/processor.rb");
		});

		it("supports file::symbol syntax", () => {
			const result = runCLI(
				["explain", "lib/payments/processor.rb::ProcessorBase"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: ProcessorBase");
			expect(result.stdout).toContain("File:   lib/payments/processor.rb");
		});

		it("renders text output", () => {
			const result = runCLI(["explain", "ProcessorBase"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: ProcessorBase");
			expect(result.stdout).toContain("Kind:");
		});

		it("returns an error for unknown symbols", () => {
			const result = runCLI(["explain", "missing_ruby_symbol_xyz"], {
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
			expect(result.stdout).toContain("lib/api/v1/handler.rb");
			expect(result.stdout).toContain("lib/api/v2/handler.rb");
			expect(result.stdout.match(/^Symbol:/gm)?.length).toBeGreaterThan(1);
		});
	});

	describe("deps", () => {
		it("returns callers and resolved internal callees for engine", async () => {
			const result = runCLI(["deps", "lib/core/engine.rb"], {
				cwd: TEMP_DIR,
			});
			const dependencies = await listIndexedDependencies("lib/core/engine.rb");

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: lib/core/engine.rb");
			expect(result.stdout).toContain("lib/core/health_check.rb");
			expect(result.stdout).toContain("lib/core/scheduler.rb");
			expect(result.stdout).toContain("lib/middleware/cors.rb");
			expect(result.stdout).toContain("lib/config/settings.rb");
			expect(result.stdout).toContain("lib/services/auth.rb");
			expect(result.stdout).toContain("lib/utils/helpers.rb");
			expect(dependencies).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						toSpecifier: "../config/settings.rb",
						toPath: "lib/config/settings.rb",
						dependencyType: "internal",
					}),
					expect.objectContaining({
						toSpecifier: "../utils/helpers.rb",
						toPath: "lib/utils/helpers.rb",
						dependencyType: "internal",
					}),
					expect.objectContaining({
						toSpecifier: "../services/auth.rb",
						toPath: "lib/services/auth.rb",
						dependencyType: "internal",
					}),
				]),
			);
		});

		it("respects --direction callers", () => {
			const result = runCLI(
				["deps", "lib/services/user_service.rb", "--direction", "callers"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("bin/app.rb");
			expect(result.stdout).toContain("Callers");
			expect(result.stdout).not.toContain("Callees");
		});

		it("resolves builtin and external dependencies in indexed metadata", async () => {
			const healthCheckDependencies = await listIndexedDependencies(
				"lib/core/health_check.rb",
			);
			const settingsDependencies = await listIndexedDependencies(
				"lib/config/settings.rb",
			);
			const appDependencies = await listIndexedDependencies("bin/app.rb");

			expect(healthCheckDependencies).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						toSpecifier: "json",
						dependencyType: "builtin",
					}),
					expect.objectContaining({
						toSpecifier: "./engine.rb",
						toPath: "lib/core/engine.rb",
						dependencyType: "internal",
					}),
				]),
			);
			expect(
				healthCheckDependencies.find(
					(dependency) => dependency.toSpecifier === "json",
				)?.toPath,
			).toBeUndefined();
			expect(settingsDependencies).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						toSpecifier: "uri",
						dependencyType: "builtin",
					}),
				]),
			);
			expect(
				settingsDependencies.find(
					(dependency) => dependency.toSpecifier === "uri",
				)?.toPath,
			).toBeUndefined();
			expect(appDependencies).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						toSpecifier: "json",
						dependencyType: "builtin",
					}),
					expect.objectContaining({
						toSpecifier: "sinatra/base",
						dependencyType: "external",
					}),
				]),
			);
		});

		it("respects --direction callees and resolves same-directory require_relative", async () => {
			const result = runCLI(
				[
					"deps",
					"lib/core/scheduler.rb",
					"--direction",
					"callees",
					"--depth",
					"2",
				],
				{ cwd: TEMP_DIR },
			);
			const dependencies = await listIndexedDependencies(
				"lib/core/scheduler.rb",
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Callers");
			expect(result.stdout).toContain("lib/core/engine.rb");
			expect(result.stdout).toContain("lib/game/player.rb");
			expect(result.stdout).toContain("lib/services/auth.rb");
			expect(result.stdout).toContain("lib/config/settings.rb");
			expect(dependencies).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						toSpecifier: "./engine.rb",
						toPath: "lib/core/engine.rb",
						dependencyType: "internal",
					}),
					expect.objectContaining({
						toSpecifier: "../game/player.rb",
						toPath: "lib/game/player.rb",
						dependencyType: "internal",
					}),
				]),
			);
		});

		it("renders text output", () => {
			const result = runCLI(["deps", "lib/services/user_service.rb"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: lib/services/user_service.rb");
			expect(result.stdout).toContain("Callers");
		});

		it("handles circular dependencies without infinite loop", () => {
			const result = runCLI(["deps", "lib/workers/email_worker.rb"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("lib/workers/notification_worker.rb");
		});

		it("resolves cross-directory chains from workers through core into services", async () => {
			const result = runCLI(
				[
					"deps",
					"lib/workers/batch_processor.rb",
					"--direction",
					"callees",
					"--depth",
					"3",
				],
				{ cwd: TEMP_DIR },
			);
			const dependencies = await listIndexedDependencies(
				"lib/workers/batch_processor.rb",
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: lib/workers/batch_processor.rb");
			expect(result.stdout).toContain("lib/workers/queue_worker.rb");
			expect(result.stdout).toContain("lib/core/scheduler.rb");
			expect(result.stdout).toContain("lib/core/engine.rb");
			expect(result.stdout).toContain("lib/services/auth.rb");
			expect(dependencies).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						toSpecifier: "./queue_worker.rb",
						toPath: "lib/workers/queue_worker.rb",
						dependencyType: "internal",
					}),
					expect.objectContaining({
						toSpecifier: "../core/scheduler.rb",
						toPath: "lib/core/scheduler.rb",
						dependencyType: "internal",
					}),
				]),
			);
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
