import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createTempProject,
	fileExists,
	gitInit,
	readTextFile,
	removeTempProject,
	runCLI,
} from "../helpers/cli-runner";
let TEMP_DIR = "";

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
				score: parseFloat(match[4]),
				primarySymbol: match[5],
			};
		})
		.filter((r): r is NonNullable<typeof r> => r !== null);
}

function firstResultIndex(
	results: Array<{ filePath: string }>,
	filePath: string,
): number {
	return results.findIndex((r) => r.filePath === filePath);
}

describe.sequential("CLI e2e", () => {
	beforeAll(() => {
		TEMP_DIR = mkdtempSync(path.join(os.tmpdir(), "indexer-cli-e2e-test-"));
		removeTempProject(TEMP_DIR);
		createTempProject(TEMP_DIR);
		gitInit(TEMP_DIR);
	}, 30_000);

	afterAll(() => {
		removeTempProject(TEMP_DIR);
	});

	describe.sequential("init", () => {
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
			expect(hook).toContain("idx index");
		});

		it("is idempotent", () => {
			const result = runCLI(["init"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Initialized indexer-cli");
		});

		it("auto-detects the Git project root when run from a subdirectory", () => {
			const tempRoot = mkdtempSync(
				path.join(os.tmpdir(), "indexer-cli-e2e-init-subdir-"),
			);

			removeTempProject(tempRoot);
			createTempProject(tempRoot);
			gitInit(tempRoot);

			try {
				const result = runCLI(["init"], { cwd: path.join(tempRoot, "src") });

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Detected Git project root");
				expect(
					fileExists(path.join(tempRoot, ".indexer-cli", "db.sqlite")),
				).toBe(true);
				expect(
					fileExists(path.join(tempRoot, "src", ".indexer-cli", "db.sqlite")),
				).toBe(false);
			} finally {
				removeTempProject(tempRoot);
			}
		});
	});

	describe.sequential("index --full", () => {
		it("indexes the TypeScript fixture project", () => {
			const result = runCLI(["index", "--full"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Index completed successfully.");
			expect(result.stdout).toMatch(/\[\d+\/\d+\] src\//);
			expect(result.stdout).toContain("Snapshot:");
			expect(result.stdout).toContain("Files indexed:");
			expect(result.stdout).toContain("Chunks created:");
		});

		it("reports status for all fixture files", () => {
			const result = runCLI(["index", "--status"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Files: 31");
			expect(result.stdout).toContain("Symbols:");
			expect(result.stdout).toContain("Chunks:");
			expect(result.stdout).toContain("Languages: typescript: 31");
		});

		it("shows the indexed file tree", () => {
			const result = runCLI(["index", "--status", "--tree"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/");
			expect(result.stdout).toContain("  index.ts");
			expect(result.stdout).toContain("  auth/");
			expect(result.stdout).toContain("    session.ts");
			expect(result.stdout).toContain("    processor.ts");
			expect(result.stdout).toContain("    errors.ts");
		});

		it("supports dry-run mode", () => {
			const result = runCLI(["index", "--dry-run"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Dry run complete.");
		});

		it("shows project-root-relative file paths for implicit full reindex from a subdirectory", () => {
			const tempRoot = mkdtempSync(
				path.join(os.tmpdir(), "indexer-cli-e2e-implicit-full-"),
			);

			removeTempProject(tempRoot);
			createTempProject(tempRoot);
			gitInit(tempRoot);
			mkdirSync(path.join(tempRoot, ".indexer-cli"), { recursive: true });
			writeFileSync(
				path.join(tempRoot, ".indexer-cli", "config.json"),
				"{}\n",
				"utf8",
			);

			try {
				const result = runCLI(["index"], {
					cwd: path.join(tempRoot, "src", "services"),
				});

				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Detected indexer-cli project root at");
				expect(result.stdout).toContain("Running full reindex...");
				expect(result.stdout).toMatch(/\[\d+\/\d+\] src\//);
				expect(result.stdout).not.toContain(`${tempRoot}/src/`);
			} finally {
				removeTempProject(tempRoot);
			}
		});
	});

	describe.sequential("search", () => {
		it("fails with a clear message before init when no project data exists", () => {
			const tempRoot = mkdtempSync(
				path.join(os.tmpdir(), "indexer-cli-e2e-uninitialized-"),
			);

			removeTempProject(tempRoot);
			createTempProject(tempRoot);
			gitInit(tempRoot);

			try {
				const result = runCLI(["search", "auth session"], { cwd: tempRoot });

				expect(result.exitCode).toBe(1);
				expect(result.stderr).toContain(
					"Search failed: No indexer-cli project data found",
				);
				expect(result.stderr).toContain("Run `idx init` here first.");
				expect(
					fileExists(path.join(tempRoot, ".indexer-cli", "db.sqlite")),
				).toBe(false);
			} finally {
				removeTempProject(tempRoot);
			}
		});

		it("auto-detects the initialized project root from nested directories", () => {
			const result = runCLI(["search", "auth session", "--max-files", "3"], {
				cwd: path.join(TEMP_DIR, "src", "services"),
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Detected indexer-cli project root at");
			expect(result.stdout).toContain("src/auth/session.ts");
		});

		it("matches auth session queries more strongly than game session queries", () => {
			const result = runCLI(
				["search", "auth session login token user access", "--max-files", "6"],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			const authIndex = firstResultIndex(results, "src/auth/session.ts");
			const gameIndex = firstResultIndex(results, "src/game/session.ts");

			expect(authIndex).toBeGreaterThanOrEqual(0);
			if (gameIndex >= 0) {
				expect(authIndex).toBeLessThan(gameIndex);
			}
			const relevantResult = results[authIndex];
			expect(relevantResult.score).toBeGreaterThan(0.4);
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
			const gameIndex = firstResultIndex(results, "src/game/session.ts");
			const authIndex = firstResultIndex(results, "src/auth/session.ts");

			expect(gameIndex).toBeGreaterThanOrEqual(0);
			if (authIndex >= 0) {
				expect(gameIndex).toBeLessThan(authIndex);
			}
			const relevantResult = results[gameIndex];
			expect(relevantResult.score).toBeGreaterThan(0.4);
		});

		it("ranks domain-specific files above unrelated infrastructure", () => {
			const result = runCLI(
				[
					"search",
					"game round match players scoreboard session",
					"--max-files",
					"5",
					"--min-score",
					"0.438",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			const gameIndex = firstResultIndex(results, "src/game/session.ts");
			expect(gameIndex).toBeGreaterThanOrEqual(0);

			const bgFiles = results.filter(
				(result) =>
					result.filePath.startsWith("src/middleware/") ||
					result.filePath.startsWith("src/helpers/") ||
					result.filePath.startsWith("src/db/") ||
					result.filePath.startsWith("src/queue/"),
			);
			expect(bgFiles.length).toBe(0);
		});

		it("finds payment processing abstractions and implementations", () => {
			const result = runCLI(
				[
					"search",
					"payment processing provider charge refund checkout",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			const processorIndex = firstResultIndex(
				results,
				"src/payments/processor.ts",
			);
			const implementationIndexes = [
				firstResultIndex(results, "src/payments/stripe.ts"),
				firstResultIndex(results, "src/payments/paypal.ts"),
			].filter((index) => index >= 0);

			expect(processorIndex >= 0 || implementationIndexes.length > 0).toBe(
				true,
			);
			expect(
				results.some((result) => result.filePath.startsWith("src/payments/")),
			).toBe(true);
			const relevantIndex =
				processorIndex >= 0 ? processorIndex : implementationIndexes[0]!;
			const relevantResult = results[relevantIndex];
			expect(relevantResult.score).toBeGreaterThan(0.4);
		});

		it("finds the error hierarchy for error handling queries", () => {
			const result = runCLI(
				[
					"search",
					"error handling exceptions validation auth not found",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			const errorsIndex = firstResultIndex(results, "src/utils/errors.ts");
			expect(errorsIndex).toBeGreaterThanOrEqual(0);
			const relevantResult = results[errorsIndex];
			expect(relevantResult.score).toBeGreaterThan(0.4);
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
				["search", "validation rules for user input", "--max-files", "1"],
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
					"logging formatter timestamp context",
					"--include-content",
					"--max-files",
					"3",
				],
				{ cwd: TEMP_DIR },
			);
			const withoutContent = runCLI(
				["search", "logging formatter timestamp context", "--max-files", "3"],
				{ cwd: TEMP_DIR },
			);

			expect(withContent.exitCode).toBe(0);
			expect(withoutContent.exitCode).toBe(0);
			expect(parseSearchResults(withContent.stdout).length).toBeGreaterThan(0);
			expect(withContent.stdout).toContain("export function formatLog(");
			expect(withoutContent.stdout).not.toContain("export function formatLog(");
		});

		it("renders text output", () => {
			const result = runCLI(
				["search", "logging formatter timestamp context", "--max-files", "3"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("score:");
			expect(result.stdout).toContain("src/utils/logger.ts");
		});

		it("respects --path-prefix", () => {
			const result = runCLI(
				[
					"search",
					"service order creation user validation",
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
			for (const result of results) {
				expect(result.filePath.startsWith("src/services")).toBe(true);
			}
		});

		it("falls back to global search on nonexistent --path-prefix", () => {
			const result = runCLI(
				[
					"search",
					"session token validate user authentication",
					"--path-prefix",
					"nonexistent",
					"--max-files",
					"3",
					"--min-score",
					"0.4",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Path 'nonexistent' not found in indexed files.",
			);
			expect(result.stdout).toContain(
				"Showing results for the entire project instead.",
			);
			expect(results.length).toBeGreaterThan(0);
		});

		it("does not fall back when --path-prefix matches files", () => {
			const result = runCLI(
				[
					"search",
					"service order creation user validation",
					"--path-prefix",
					"src/services",
					"--max-files",
					"5",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("not found in indexed files");
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

			for (const r of results) {
				if (r.primarySymbol) {
					expect(r.primarySymbol).not.toBe("user");
					expect(r.primarySymbol).not.toBe("token");
					expect(r.primarySymbol).not.toBe("session");
					expect(r.primarySymbol).not.toBe("expiresAt");
					expect(r.primarySymbol).not.toBe("payload");
					expect(r.primarySymbol).not.toBe("parts");
					expect(r.primarySymbol).not.toBe("decoded");
					expect(r.primarySymbol).not.toBe("normalized");
					expect(r.primarySymbol).not.toBe("email");
					expect(r.primarySymbol).not.toBe("name");
				}
			}
		});
	});

	describe.sequential("structure", () => {
		it("renders a tree with files and symbols", () => {
			const result = runCLI(["structure"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/");
			expect(result.stdout).toContain("payments/");
			expect(result.stdout).toContain("processor.ts —");
			expect(result.stdout).toContain("interface: PaymentProcessor");
		});

		it("filters classes with --kind class", () => {
			const result = runCLI(["structure", "--kind", "class"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("class: UserService");
			expect(result.stdout).not.toContain("function: createSession");
		});

		it("filters functions with --kind function", () => {
			const result = runCLI(["structure", "--kind", "function"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("function: createSession");
			expect(result.stdout).not.toContain("class: UserService");
		});

		it("filters interfaces with --kind interface", () => {
			const result = runCLI(["structure", "--kind", "interface"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("interface: AppConfig");
			expect(result.stdout).toContain("interface: PaymentProcessor");
			expect(result.stdout).not.toContain("function: createSession");
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
			expect(result.stdout).toContain("src/");
			expect(result.stdout).toContain("payments/");
			expect(result.stdout).toContain("processor.ts —");
			expect(result.stdout).not.toContain("src/auth/session.ts");
			expect(result.stdout).not.toContain("services/");
		});

		it("excludes fixtures by default and includes them with --include-fixtures", () => {
			const fixturesDir = path.join(TEMP_DIR, "fixtures", "support");
			const fixtureFile = path.join(fixturesDir, "structure-fixture.ts");
			mkdirSync(fixturesDir, { recursive: true });
			writeFileSync(
				fixtureFile,
				'export function createFixtureValue(): string {\n\treturn "fixture";\n}\n',
				"utf-8",
			);

			try {
				const defaultResult = runCLI(
					["structure", "--path-prefix", "fixtures"],
					{ cwd: TEMP_DIR },
				);
				const includedResult = runCLI(
					["structure", "--path-prefix", "fixtures", "--include-fixtures"],
					{ cwd: TEMP_DIR },
				);

				expect(defaultResult.exitCode).toBe(0);
				expect(defaultResult.stdout).toContain(
					"No indexed files found for the requested filters.",
				);
				expect(includedResult.exitCode).toBe(0);
				expect(includedResult.stdout).toContain("fixtures/");
				expect(includedResult.stdout).toContain(
					"structure-fixture.ts — function: createFixtureValue",
				);
			} finally {
				rmSync(path.join(TEMP_DIR, "fixtures"), {
					recursive: true,
					force: true,
				});
			}
		});

		it("excludes test files with --no-tests", () => {
			const testsDir = path.join(TEMP_DIR, "__tests__");
			const testFile = path.join(testsDir, "example.test.ts");
			mkdirSync(testsDir, { recursive: true });
			writeFileSync(
				testFile,
				"export function testHelper(): boolean {\n\treturn true;\n}\n",
				"utf-8",
			);

			try {
				runCLI(["init"], { cwd: TEMP_DIR });
				runCLI(["index", "--full"], { cwd: TEMP_DIR });

				const defaultResult = runCLI(["structure"], { cwd: TEMP_DIR });
				const noTestsResult = runCLI(["structure", "--no-tests"], {
					cwd: TEMP_DIR,
				});

				expect(defaultResult.exitCode).toBe(0);
				expect(defaultResult.stdout).toContain("__tests__/");
				expect(defaultResult.stdout).toContain("example.test.ts");

				expect(noTestsResult.exitCode).toBe(0);
				expect(noTestsResult.stdout).not.toContain("__tests__/");
				expect(noTestsResult.stdout).not.toContain("example.test.ts");
				expect(noTestsResult.stdout).toContain("src/");
			} finally {
				rmSync(testsDir, { recursive: true, force: true });
				runCLI(["index", "--full"], { cwd: TEMP_DIR });
			}
		});

		it("shows deeply nested files with --max-depth 3", () => {
			const result = runCLI(["structure", "--max-depth", "3"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("v1/");
			expect(result.stdout).toContain("handler.ts");
		});

		it("distinguishes same-named files in different directories", () => {
			const result = runCLI(["structure", "--path-prefix", "src/api"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout.match(/handler\.ts/g)?.length ?? 0).toBe(2);
		});

		it("falls back to root structure with depth=1 on nonexistent --path-prefix", () => {
			const result = runCLI(["structure", "--path-prefix", "nonexistent"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Path 'nonexistent' not found in indexed files.",
			);
			expect(result.stdout).toContain(
				"Showing results for the entire project instead.",
			);
			expect(result.stdout).toContain("src/");
			expect(result.stdout).not.toContain("src/auth/");
		});

		it("does not fall back when --path-prefix matches files", () => {
			const result = runCLI(["structure", "--path-prefix", "src/payments"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("not found in indexed files");
			expect(result.stdout).toContain("payments/");
			expect(result.stdout).not.toContain("src/auth/");
		});

		it("uses max-depth=1 on fallback even if --max-depth was specified", () => {
			const result = runCLI(
				["structure", "--path-prefix", "nonexistent", "--max-depth", "5"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Path 'nonexistent' not found in indexed files.",
			);
			expect(result.stdout).toContain("src/");
			expect(result.stdout).not.toContain("src/auth/");
		});

		it("uses explicit --max-depth when --path-prefix matches files", () => {
			const result = runCLI(
				["structure", "--path-prefix", "src", "--max-depth", "5"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("not found in indexed files");
			expect(result.stdout).toContain("auth/");
		});
	});

	describe.sequential("architecture", () => {
		it("returns file stats, entrypoints, and internal dependencies", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain("typescript: 31");
			expect(result.stdout).toContain("src/index.ts");
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
			const result = runCLI(["architecture", "--path-prefix", "src/payments"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("typescript: 3");
			expect(result.stdout).toContain("Entrypoints\n  none");
		});

		it("detects multiple entrypoints including workers", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/index.ts");
			expect(result.stdout).toContain("src/workers/email.ts");
		});

		it("keeps TypeScript entrypoint detection stable from nested directories", () => {
			const result = runCLI(["architecture"], {
				cwd: path.join(TEMP_DIR, "src", "services"),
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Detected indexer-cli project root at");
			expect(result.stdout).toContain("src/index.ts");
			expect(result.stdout).toContain("src/workers/email.ts");
		});

		it("falls back to full architecture on nonexistent --path-prefix", () => {
			const result = runCLI(["architecture", "--path-prefix", "nonexistent"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Path 'nonexistent' not found in indexed files.",
			);
			expect(result.stdout).toContain(
				"Showing results for the entire project instead.",
			);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain("typescript: 31");
		});

		it("does not fall back when --path-prefix matches files", () => {
			const result = runCLI(["architecture", "--path-prefix", "src/payments"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("not found in indexed files");
			expect(result.stdout).toContain("typescript: 3");
		});
	});

	describe.sequential("explain", () => {
		it("explains createSession", () => {
			const result = runCLI(["explain", "createSession"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: createSession");
			expect(result.stdout).toContain("Kind:   function");
			expect(result.stdout).toContain("src/auth/session.ts");
		});

		it("explains UserService", () => {
			const result = runCLI(["explain", "UserService"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: UserService");
			expect(result.stdout).toContain("Kind:   class");
			expect(result.stdout).toContain("src/services/user.ts");
		});

		it("explains PaymentProcessor and AppError", () => {
			const paymentProcessor = runCLI(["explain", "PaymentProcessor"], {
				cwd: TEMP_DIR,
			});
			const appError = runCLI(["explain", "AppError"], { cwd: TEMP_DIR });

			expect(paymentProcessor.exitCode).toBe(0);
			expect(paymentProcessor.stdout).toContain("Kind:   class");
			expect(paymentProcessor.stdout).toContain("src/payments/processor.ts");
			expect(appError.exitCode).toBe(0);
			expect(appError.stdout).toContain("Kind:   class");
			expect(appError.stdout).toContain("src/utils/errors.ts");
		});

		it("supports file::symbol syntax", () => {
			const result = runCLI(
				["explain", "src/payments/processor.ts::PaymentProcessor"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: PaymentProcessor");
			expect(result.stdout).toContain("src/payments/processor.ts");
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

		it("returns multiple results for ambiguous handleRequest symbol", () => {
			const result = runCLI(["explain", "handleRequest"], { cwd: TEMP_DIR });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/api/v1/handler.ts");
			expect(result.stdout).toContain("src/api/v2/handler.ts");
		});

		it("disambiguates Status via file::symbol syntax", () => {
			const result = runCLI(["explain", "src/inventory/tracker.ts::Status"], {
				cwd: TEMP_DIR,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: Status");
			expect(result.stdout).toContain("src/inventory/tracker.ts");
		});
	});

	describe.sequential("deps", () => {
		it("returns callers and callees for a module with both", () => {
			const result = runCLI(["deps", "src/services/user.ts"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: src/services/user.ts");
			expect(result.stdout).toContain("Callers");
			expect(result.stdout).toContain("src/index.ts");
			expect(result.stdout).toContain("src/auth/session.ts");
		});

		it("respects --direction callers", () => {
			const result = runCLI(
				["deps", "src/services/user.ts", "--direction", "callers"],
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
					"src/services/user.ts",
					"--direction",
					"callees",
					"--depth",
					"2",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Callers");
			expect(result.stdout).toContain("src/auth/session.ts");
			expect(result.stdout).toContain("src/utils/errors.ts");
			expect(result.stdout).toContain("src/utils/format.ts");
		});

		it("renders text output", () => {
			const result = runCLI(["deps", "src/services/user.ts"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: src/services/user.ts");
			expect(result.stdout).toContain("Callers");
		});

		it("handles circular dependencies without infinite loop", () => {
			const result = runCLI(["deps", "src/workers/email.ts"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Callers");
			expect(result.stdout).toContain("Callees");
			expect(result.stdout).toContain("src/workers/notification.ts");
		});

		it("shows cross-domain callers for inventory manager", () => {
			const result = runCLI(
				["deps", "src/inventory/manager.ts", "--direction", "callees"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/services/order.ts");
			expect(result.stdout).toContain("src/inventory/tracker.ts");
			expect(result.stdout).toContain("src/utils/logger.ts");
		});
	});

	describe.sequential("uninstall", () => {
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

		it("cleans stale generated artifacts from a subdirectory even without .indexer-cli", () => {
			const staleSkillPath = path.join(
				TEMP_DIR,
				".claude",
				"skills",
				"semantic-search",
				"SKILL.md",
			);
			mkdirSync(path.dirname(staleSkillPath), { recursive: true });
			writeFileSync(staleSkillPath, "stale skill\n", "utf8");
			writeFileSync(
				path.join(TEMP_DIR, ".gitignore"),
				".indexer-cli/\n.claude/\n",
				"utf8",
			);
			writeFileSync(
				path.join(TEMP_DIR, ".git", "hooks", "post-commit"),
				"#!/bin/sh\n# >>> indexer-cli >>>\nidx index --skip-if-locked\n# <<< indexer-cli <<<\n",
				"utf8",
			);

			const result = runCLI(["uninstall", "--force"], {
				cwd: path.join(TEMP_DIR, "src", "services"),
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Detected Git project root");
			expect(fileExists(path.join(TEMP_DIR, ".claude"))).toBe(false);
			expect(readTextFile(path.join(TEMP_DIR, ".gitignore"))).not.toContain(
				".claude/",
			);
			const hookPath = path.join(TEMP_DIR, ".git", "hooks", "post-commit");
			if (fileExists(hookPath)) {
				expect(readTextFile(hookPath)).not.toContain("indexer-cli");
			}
		});
	});
});
