import { writeFileSync } from "node:fs";
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

const TEMP_DIR = path.join(os.tmpdir(), "indexer-cli-e2e-test");

type SearchResult = {
	filePath: string;
	score: number;
	content?: string | null;
	primarySymbol?: string | null;
};

type StructureEntry = {
	type: string;
	name?: string;
	path?: string;
	children?: StructureEntry[];
	symbols?: Array<{ name: string; kind: string; exported: boolean }>;
	hiddenFiles?: number;
};

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

function runJsonCommand<T>(args: string[]): T {
	const result = runCLI(args, { cwd: TEMP_DIR });
	expect(result.exitCode).toBe(0);
	return parseJson<T>(result.stdout);
}

function flattenFiles(entries: StructureEntry[]): StructureEntry[] {
	const files: StructureEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "file") {
			files.push(entry);
		}
		if (entry.children) {
			files.push(...flattenFiles(entry.children));
		}
	}
	return files;
}

function firstResultIndex(results: SearchResult[], filePath: string): number {
	return results.findIndex((result) => result.filePath === filePath);
}

describe.sequential("CLI e2e", () => {
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

			const config = parseJson<{ embeddingModel: string; vectorSize: number }>(
				readTextFile(configPath),
			);
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
		it("indexes the TypeScript fixture project", () => {
			const result = runCLI(["index", "--full"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Index completed successfully.");
			expect(result.stdout).toContain("Snapshot:");
			expect(result.stdout).toContain("Files indexed:");
			expect(result.stdout).toContain("Chunks created:");
		});

		it("reports status for all fixture files", () => {
			const output = runJsonCommand<{
				indexed: boolean;
				stats: {
					files: number;
					symbols: number;
					chunks: number;
					dependencies: number;
				};
				languages: Record<string, number>;
			}>(["index", "--status"]);

			expect(output.indexed).toBe(true);
			expect(output.stats.files).toBe(31);
			expect(output.stats.symbols).toBeGreaterThan(30);
			expect(output.stats.chunks).toBeGreaterThan(0);
			expect(output.stats.dependencies).toBeGreaterThan(0);
			expect(output.languages.typescript).toBe(31);
		});

		it("shows the indexed file tree", () => {
			const output = runJsonCommand<{ files: string[] }>([
				"index",
				"--status",
				"--tree",
			]);

			expect(output.files).toContain("src/index.ts");
			expect(output.files).toContain("src/auth/session.ts");
			expect(output.files).toContain("src/game/session.ts");
			expect(output.files).toContain("src/payments/processor.ts");
			expect(output.files).toContain("src/utils/errors.ts");
		});

		it("supports dry-run mode", () => {
			const result = runCLI(["index", "--dry-run"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Dry run complete.");
		});
	});

	describe("search", () => {
		it("matches auth session queries more strongly than game session queries", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"auth session login token user access",
				"--max-files",
				"6",
			]);

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
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"game round match players scoreboard session",
				"--max-files",
				"6",
			]);

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
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"game round match players scoreboard session",
				"--max-files",
				"5",
				"--min-score",
				"0.438",
			]);

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
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"payment processing provider charge refund checkout",
				"--max-files",
				"6",
			]);

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
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"error handling exceptions validation auth not found",
				"--max-files",
				"6",
			]);

			const errorsIndex = firstResultIndex(results, "src/utils/errors.ts");
			expect(errorsIndex).toBeGreaterThanOrEqual(0);
			const relevantResult = results[errorsIndex];
			expect(relevantResult.score).toBeGreaterThan(0.4);
		});

		it("respects --min-score to filter noise", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"authentication login token session",
				"--max-files",
				"10",
				"--min-score",
				"0.5",
			]);

			for (const result of results) {
				expect(result.score).toBeGreaterThanOrEqual(0.5);
			}
			expect(results.length).toBeGreaterThan(0);
		});

		it("respects --max-files", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"validation rules for user input",
				"--max-files",
				"1",
			]);

			expect(results.length).toBeLessThanOrEqual(1);
		});

		it("includes content with --include-content and omits it by default", () => {
			const withContent = runJsonCommand<SearchResult[]>([
				"search",
				"logging formatter timestamp context",
				"--include-content",
				"--max-files",
				"3",
			]);
			const withoutContent = runJsonCommand<SearchResult[]>([
				"search",
				"logging formatter timestamp context",
				"--max-files",
				"3",
			]);

			expect(withContent.length).toBeGreaterThan(0);
			expect(withContent[0]?.content).toBeTruthy();
			expect(withoutContent[0]?.content).toBeUndefined();
		});

		it("renders text output with --txt", () => {
			const result = runCLI(
				[
					"search",
					"logging formatter timestamp context",
					"--txt",
					"--max-files",
					"3",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("score:");
			expect(result.stdout).toContain("src/utils/logger.ts");
		});

		it("respects --path-prefix", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"service order creation user validation",
				"--path-prefix",
				"src/services",
				"--max-files",
				"5",
			]);

			expect(results.length).toBeGreaterThan(0);
			for (const result of results) {
				expect(result.filePath.startsWith("src/services")).toBe(true);
			}
		});
	});

	describe("structure", () => {
		it("returns a JSON tree with files and symbols", () => {
			const output = runJsonCommand<StructureEntry[]>(["structure"]);
			const files = flattenFiles(output);

			expect(files.length).toBeGreaterThan(0);
			expect(
				files.some((entry) => entry.path === "src/payments/processor.ts"),
			).toBe(true);
			expect(files.some((entry) => (entry.symbols?.length ?? 0) > 0)).toBe(
				true,
			);
		});

		it("filters classes with --kind class", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--kind",
				"class",
			]);
			const files = flattenFiles(output);

			for (const file of files) {
				for (const symbol of file.symbols ?? []) {
					expect(symbol.kind).toBe("class");
				}
			}
			expect(
				files.some((file) =>
					(file.symbols ?? []).some((symbol) => symbol.name === "UserService"),
				),
			).toBe(true);
		});

		it("filters functions with --kind function", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--kind",
				"function",
			]);
			const files = flattenFiles(output);

			for (const file of files) {
				for (const symbol of file.symbols ?? []) {
					expect(symbol.kind).toBe("function");
				}
			}
			expect(
				files.some((file) =>
					(file.symbols ?? []).some(
						(symbol) => symbol.name === "createSession",
					),
				),
			).toBe(true);
		});

		it("filters interfaces with --kind interface", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--kind",
				"interface",
			]);
			const files = flattenFiles(output);

			for (const file of files) {
				for (const symbol of file.symbols ?? []) {
					expect(symbol.kind).toBe("interface");
				}
			}
			expect(files.length).toBeGreaterThan(0);
		});

		it("renders text output", () => {
			const result = runCLI(["structure", "--txt"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("src/");
			expect(result.stdout).toContain("PaymentProcessor");
		});

		it("respects --path-prefix", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--path-prefix",
				"src/payments",
			]);
			const files = flattenFiles(output);

			expect(files.length).toBe(3);
			for (const file of files) {
				expect(file.path?.startsWith("src/payments")).toBe(true);
			}
		});

		it("shows deeply nested files with --max-depth 2", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--max-depth",
				"2",
			]);
			const files = flattenFiles(output);
			expect(files.some((f) => f.path?.includes("api/v"))).toBe(true);
		});

		it("distinguishes same-named files in different directories", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--path-prefix",
				"src/api",
			]);
			const files = flattenFiles(output);
			const handlerFiles = files.filter((f) => f.name === "handler.ts");
			expect(handlerFiles.length).toBe(2);
		});
	});

	describe("architecture", () => {
		it("returns file stats, entrypoints, and internal dependencies", () => {
			const output = runJsonCommand<{
				file_stats: Record<string, number>;
				entrypoints: string[];
				dependency_map: { internal: Record<string, string[]> };
				files: Array<{ path: string; language: string }>;
			}>(["architecture"]);

			expect(output.file_stats.typescript).toBe(31);
			expect(output.entrypoints).toContain("src/index.ts");
			expect(output.files.length).toBe(31);
			expect(
				Object.keys(output.dependency_map.internal).length,
			).toBeGreaterThan(0);
			expect(JSON.stringify(output.dependency_map.internal)).toMatch(
				/src\/payments|src\/services|src\/auth/,
			);
		});

		it("renders text output", () => {
			const result = runCLI(["architecture", "--txt"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("Module dependency graph");
		});

		it("respects --path-prefix", () => {
			const output = runJsonCommand<{
				file_stats: Record<string, number>;
				files: Array<{ path: string; language: string }>;
			}>(["architecture", "--path-prefix", "src/payments"]);

			expect(output.file_stats.typescript).toBe(3);
			for (const file of output.files) {
				expect(file.path.startsWith("src/payments")).toBe(true);
			}
		});

		it("detects multiple entrypoints including workers", () => {
			const output = runJsonCommand<{
				entrypoints: string[];
			}>(["architecture"]);

			expect(output.entrypoints).toContain("src/index.ts");
			expect(output.entrypoints).toContain("src/workers/email.ts");
		});
	});

	describe("context", () => {
		it("returns JSON context with symbols, modules, dependencies, and meta", () => {
			const output = runJsonCommand<{
				architecture: {
					fileStats: Record<string, number>;
					entrypoints: string[];
				};
				modules: Array<{ path: string }>;
				symbols: Array<{ file: string; name: string; kind: string }>;
				dependencies: Record<string, string[]>;
				_meta: { estimatedTokens: number; scope: string };
			}>(["context"]);

			expect(output.architecture.fileStats.typescript).toBe(31);
			expect(output.architecture.entrypoints).toContain("src/index.ts");
			expect(output.modules.length).toBeGreaterThan(0);
			expect(
				output.symbols.some((symbol) => symbol.name === "PaymentProcessor"),
			).toBe(true);
			expect(output.symbols.some((symbol) => symbol.name === "AppError")).toBe(
				true,
			);
			expect(Object.keys(output.dependencies).length).toBeGreaterThan(0);
			expect(output._meta.scope).toBe("all");
			expect(output._meta.estimatedTokens).toBeGreaterThan(0);
		});

		it("renders text output", () => {
			const result = runCLI(["context", "--txt"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("## Architecture");
			expect(result.stdout).toContain("## Key Symbols");
		});

		it("supports --scope changed", () => {
			const orderPath = path.join(TEMP_DIR, "src", "services", "order.ts");
			const original = readTextFile(orderPath);
			const updated = original.replace(
				'status: "pending" | "paid";',
				'status: "draft" | "pending" | "paid";',
			);

			writeFileSync(orderPath, updated, "utf-8");

			const output = runJsonCommand<{
				modules: Array<{ path: string }>;
				symbols: Array<{ file: string; name: string; kind: string }>;
				_meta: { scope: string };
			}>(["context", "--scope", "changed"]);

			expect(output._meta.scope).toBe("changed");
			expect(
				output.modules.some(
					(module) => module.path === "src/services/order.ts",
				),
			).toBe(true);
			expect(
				output.symbols.some(
					(symbol) => symbol.file === "src/services/order.ts",
				),
			).toBe(true);
		});

		it("respects --max-deps", () => {
			const output = runJsonCommand<{
				dependencies: Record<string, string[]>;
				_meta: { truncatedDependencies?: { shown: number; total: number } };
			}>(["context", "--max-deps", "1"]);

			expect(Object.keys(output.dependencies).length).toBeLessThanOrEqual(1);
			if (output._meta.truncatedDependencies) {
				expect(output._meta.truncatedDependencies.shown).toBeLessThanOrEqual(1);
			}
		});

		it("resolves relevant-to scope across module boundaries", () => {
			const output = runJsonCommand<{
				modules: Array<{ path: string }>;
				_meta: { scope: string };
			}>(["context", "--scope", "relevant-to:src/inventory/manager.ts"]);

			expect(output._meta.scope).toBe("relevant-to:src/inventory/manager.ts");
			const paths = output.modules.map((m) => m.path);
			expect(paths).toContain("src/inventory/manager.ts");
		});
	});

	describe("explain", () => {
		it("explains createSession", () => {
			const output = runJsonCommand<{
				name: string;
				kind: string;
				file: string;
				lines: { start: number; end: number };
				callers: string[];
				callees: string[];
			}>(["explain", "createSession"]);

			expect(output.name).toBe("createSession");
			expect(output.kind).toBe("function");
			expect(output.file).toBe("src/auth/session.ts");
			expect(output.lines.start).toBeGreaterThan(0);
		});

		it("explains UserService", () => {
			const output = runJsonCommand<{
				name: string;
				kind: string;
				file: string;
			}>(["explain", "UserService"]);

			expect(output.name).toBe("UserService");
			expect(output.kind).toBe("class");
			expect(output.file).toBe("src/services/user.ts");
		});

		it("explains PaymentProcessor and AppError", () => {
			const paymentProcessor = runJsonCommand<{
				name: string;
				kind: string;
				file: string;
			}>(["explain", "PaymentProcessor"]);
			const appError = runJsonCommand<{
				name: string;
				kind: string;
				file: string;
			}>(["explain", "AppError"]);

			expect(paymentProcessor.kind).toBe("class");
			expect(paymentProcessor.file).toBe("src/payments/processor.ts");
			expect(appError.kind).toBe("class");
			expect(appError.file).toBe("src/utils/errors.ts");
		});

		it("supports file::symbol syntax", () => {
			const output = runJsonCommand<{ name: string; file: string }>([
				"explain",
				"src/payments/processor.ts::PaymentProcessor",
			]);

			expect(output.name).toBe("PaymentProcessor");
			expect(output.file).toBe("src/payments/processor.ts");
		});

		it("renders text output", () => {
			const result = runCLI(["explain", "AppError", "--txt"], {
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
			const output = JSON.parse(result.stdout);
			const items = Array.isArray(output) ? output : [output];
			const files = items.map((item: { file: string }) => item.file);
			expect(files).toContain("src/api/v1/handler.ts");
			expect(files).toContain("src/api/v2/handler.ts");
		});

		it("disambiguates Status via file::symbol syntax", () => {
			const result = runCLI(["explain", "src/inventory/tracker.ts::Status"], {
				cwd: TEMP_DIR,
			});
			expect(result.exitCode).toBe(0);
			const output = JSON.parse(result.stdout);
			expect(output.name).toBe("Status");
			expect(output.file).toBe("src/inventory/tracker.ts");
		});
	});

	describe("deps", () => {
		it("returns callers and callees for a module with both", () => {
			const output = runJsonCommand<{
				path: string;
				callers: string[];
				callees: string[];
			}>(["deps", "src/services/user.ts"]);

			expect(output.path).toBe("src/services/user.ts");
			expect(output.callers).toContain("src/index.ts");
			expect(output.callers).toContain("src/services/order.ts");
			expect(output.callees).toContain("src/auth/session.ts");
			expect(output.callees).toContain("src/utils/errors.ts");
		});

		it("respects --direction callers", () => {
			const output = runJsonCommand<{
				callers: string[];
				callees: string[];
			}>(["deps", "src/services/user.ts", "--direction", "callers"]);

			expect(output.callers).toContain("src/index.ts");
			expect(output.callees).toEqual([]);
		});

		it("respects --direction callees and --depth", () => {
			const output = runJsonCommand<{
				callers: string[];
				callees: string[];
			}>([
				"deps",
				"src/services/user.ts",
				"--direction",
				"callees",
				"--depth",
				"2",
			]);

			expect(output.callers).toEqual([]);
			expect(output.callees).toContain("src/auth/session.ts");
			expect(output.callees).toContain("src/utils/errors.ts");
			expect(output.callees).toContain("src/utils/format.ts");
		});

		it("renders text output", () => {
			const result = runCLI(["deps", "src/services/user.ts", "--txt"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: src/services/user.ts");
			expect(result.stdout).toContain("Callers");
		});

		it("handles circular dependencies without infinite loop", () => {
			const output = runJsonCommand<{
				path: string;
				callers: string[];
				callees: string[];
			}>(["deps", "src/workers/email.ts"]);

			expect(output.callers).toContain("src/workers/notification.ts");
			expect(output.callees).toContain("src/workers/notification.ts");
		});

		it("shows cross-domain callers for inventory manager", () => {
			const output = runJsonCommand<{
				path: string;
				callees: string[];
			}>(["deps", "src/inventory/manager.ts", "--direction", "callees"]);

			expect(output.callees).toContain("src/services/order.ts");
			expect(output.callees).toContain("src/inventory/tracker.ts");
			expect(output.callees).toContain("src/utils/logger.ts");
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
