import { writeFileSync } from "node:fs";
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
const FIXTURE_FILE_COUNT = 33;

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

type DependencyRecord = {
	fromPath: string;
	toSpecifier: string;
	toPath?: string;
	dependencyType?: "internal" | "external" | "builtin" | "unresolved";
};

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

function runJsonCommand<T>(args: string[]): T {
	const result = runCLI(args, { cwd: TEMP_DIR });
	expect(result.exitCode).toBe(0);
	return parseJson<T>(result.stdout);
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
		it("indexes the Python fixture project", () => {
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
			expect(output.stats.files).toBe(FIXTURE_FILE_COUNT);
			expect(output.stats.symbols).toBeGreaterThan(20);
			expect(output.stats.chunks).toBeGreaterThan(0);
			expect(output.stats.dependencies).toBeGreaterThan(0);
			expect(output.languages.python).toBe(FIXTURE_FILE_COUNT);
		});

		it("shows the indexed file tree", () => {
			const output = runJsonCommand<{ files: string[] }>([
				"index",
				"--status",
				"--tree",
			]);

			expect(output.files).toContain("manage.py");
			expect(output.files).toContain("src/__main__.py");
			expect(output.files).toContain("src/auth/session.py");
			expect(output.files).toContain("src/game/session.py");
			expect(output.files).toContain("src/payments/processor.py");
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
				"auth session login token access user",
				"--max-files",
				"6",
			]);

			const authCandidates = [
				"src/auth/session.py",
				"src/services/auth.py",
				"src/middleware/auth.py",
				"src/api/v1/handler.py",
				"src/api/v2/routes.py",
				"src/__main__.py",
			]
				.map((filePath) => firstResultIndex(results, filePath))
				.filter((index) => index >= 0)
				.sort((left, right) => left - right);
			const authIndex = authCandidates[0] ?? -1;
			const gameIndex = firstResultIndex(results, "src/game/session.py");

			expect(authIndex).toBeGreaterThanOrEqual(0);
			if (gameIndex >= 0) {
				expect(authIndex).toBeLessThan(gameIndex);
			}
			expect(results[authIndex]?.score).toBeGreaterThan(0.4);
		});

		it("matches game round queries more strongly than auth session queries", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"game round match score players session",
				"--max-files",
				"6",
			]);

			const gameIndex = firstResultIndex(results, "src/game/session.py");
			const authIndex = firstResultIndex(results, "src/auth/session.py");

			expect(gameIndex).toBeGreaterThanOrEqual(0);
			if (authIndex >= 0) {
				expect(gameIndex).toBeLessThan(authIndex);
			}
			expect(results[gameIndex]?.score).toBeGreaterThan(0.4);
		});

		it("ranks payment processing files above unrelated infrastructure", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"payment processing provider charge checkout receipt",
				"--max-files",
				"5",
			]);

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
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"error handling validation not found app error",
				"--max-files",
				"6",
			]);

			const errorsIndex = firstResultIndex(results, "src/utils/errors.py");
			expect(errorsIndex).toBeGreaterThanOrEqual(0);
			expect(results[errorsIndex]?.score).toBeGreaterThan(0.4);
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
				"user validation profile account",
				"--max-files",
				"1",
			]);

			expect(results.length).toBeLessThanOrEqual(1);
		});

		it("includes content with --include-content and omits it by default", () => {
			const withContent = runJsonCommand<SearchResult[]>([
				"search",
				"logger debug event context json",
				"--include-content",
				"--max-files",
				"3",
			]);
			const withoutContent = runJsonCommand<SearchResult[]>([
				"search",
				"logger debug event context json",
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
					"logger debug event context json",
					"--txt",
					"--max-files",
					"3",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("score:");
			expect(result.stdout).toContain("src/logging/logger.py");
		});

		it("respects --path-prefix", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"order validation receipt payment user",
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
				files.some((entry) => entry.path === "src/payments/processor.py"),
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
					(file.symbols ?? []).some(
						(symbol) => symbol.name === "UserValidator",
					),
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
						(symbol) => symbol.name === "create_session",
					),
				),
			).toBe(true);
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

			expect(files.length).toBe(2);
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
			expect(files.some((file) => file.path?.includes("api/v"))).toBe(true);
		});

		it("distinguishes same-named files in different directories", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--path-prefix",
				"src/api",
			]);
			const files = flattenFiles(output);
			const handlerFiles = files.filter((file) => file.name === "handler.py");
			expect(handlerFiles.length).toBe(2);
		});
	});

	describe("architecture", () => {
		it("returns file stats, entrypoints, and dependency data", () => {
			const output = runJsonCommand<{
				file_stats: Record<string, number>;
				entrypoints: string[];
				dependency_map: {
					internal: Record<string, string[]>;
					unresolved: Record<string, string[]>;
				};
				files: Array<{ path: string; language: string }>;
			}>(["architecture"]);

			expect(output.file_stats.python).toBe(FIXTURE_FILE_COUNT);
			expect(output.entrypoints).toContain("manage.py");
			expect(output.entrypoints).toContain("src/__main__.py");
			expect(output.files.length).toBe(FIXTURE_FILE_COUNT);
			expect(output.dependency_map.internal).toBeTypeOf("object");
			expect(output.dependency_map.unresolved).toBeTypeOf("object");
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

			expect(output.file_stats.python).toBe(2);
			for (const file of output.files) {
				expect(file.path.startsWith("src/payments")).toBe(true);
			}
		});

		it("detects multiple entrypoints", () => {
			const output = runJsonCommand<{ entrypoints: string[] }>([
				"architecture",
			]);

			expect(output.entrypoints).toContain("manage.py");
			expect(output.entrypoints).toContain("src/__main__.py");
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

			expect(output.architecture.fileStats.python).toBe(FIXTURE_FILE_COUNT);
			expect(output.architecture.entrypoints).toContain("manage.py");
			expect(output.modules.length).toBeGreaterThan(0);
			expect(
				output.symbols.some((symbol) => symbol.name === "PaymentProcessor"),
			).toBe(true);
			expect(output.symbols.some((symbol) => symbol.name === "AppError")).toBe(
				true,
			);
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
			const orderPath = path.join(TEMP_DIR, "src", "services", "order.py");
			const original = readTextFile(orderPath);
			const updated = original.replace('"paid"', '"queued"');

			writeFileSync(orderPath, updated, "utf-8");

			const output = runJsonCommand<{
				modules: Array<{ path: string }>;
				symbols: Array<{ file: string; name: string; kind: string }>;
				_meta: { scope: string };
			}>(["context", "--scope", "changed"]);

			expect(output._meta.scope).toBe("changed");
			expect(
				output.modules.some(
					(module) => module.path === "src/services/order.py",
				),
			).toBe(true);
			expect(
				output.symbols.some(
					(symbol) => symbol.file === "src/services/order.py",
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
			}>(["context", "--scope", "relevant-to:src/services/order.py"]);

			expect(output._meta.scope).toBe("relevant-to:src/services/order.py");
			expect(output.modules.map((module) => module.path)).toContain(
				"src/services/order.py",
			);
		});
	});

	describe("explain", () => {
		it("explains create_session", () => {
			const output = runJsonCommand<{
				name: string;
				kind: string;
				file: string;
				lines: { start: number; end: number };
				callers: string[];
				callees: string[];
			}>(["explain", "create_session"]);

			expect(output.name).toBe("create_session");
			expect(output.kind).toBe("function");
			expect(output.file).toBe("src/auth/session.py");
			expect(output.lines.start).toBeGreaterThan(0);
		});

		it("explains UserValidator", () => {
			const output = runJsonCommand<{
				name: string;
				kind: string;
				file: string;
			}>(["explain", "UserValidator"]);

			expect(output.name).toBe("UserValidator");
			expect(output.kind).toBe("class");
			expect(output.file).toBe("src/services/user.py");
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
			expect(paymentProcessor.file).toBe("src/payments/processor.py");
			expect(appError.kind).toBe("class");
			expect(appError.file).toBe("src/utils/errors.py");
		});

		it("supports file::symbol syntax", () => {
			const output = runJsonCommand<{ name: string; file: string }>([
				"explain",
				"src/payments/processor.py::PaymentProcessor",
			]);

			expect(output.name).toBe("PaymentProcessor");
			expect(output.file).toBe("src/payments/processor.py");
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

		it("returns multiple results for ambiguous handle_request symbol", () => {
			const result = runCLI(["explain", "handle_request"], { cwd: TEMP_DIR });
			expect(result.exitCode).toBe(0);
			const output = JSON.parse(result.stdout);
			const items = Array.isArray(output) ? output : [output];
			const files = items.map((item: { file: string }) => item.file);
			expect(files).toContain("src/api/v1/handler.py");
			expect(files).toContain("src/api/v2/handler.py");
		});
	});

	describe("deps", () => {
		it("returns a stable dependency response for order services", () => {
			const output = runJsonCommand<{
				path: string;
				callers: string[];
				callees: string[];
			}>(["deps", "src/services/order.py"]);

			expect(output.path).toBe("src/services/order.py");
			expect(Array.isArray(output.callers)).toBe(true);
			expect(Array.isArray(output.callees)).toBe(true);
		});

		it("respects --direction callers", () => {
			const output = runJsonCommand<{ callers: string[]; callees: string[] }>([
				"deps",
				"src/services/order.py",
				"--direction",
				"callers",
			]);

			expect(Array.isArray(output.callers)).toBe(true);
			expect(output.callees).toEqual([]);
		});

		it("respects --direction callees and --depth", () => {
			const output = runJsonCommand<{ callers: string[]; callees: string[] }>([
				"deps",
				"src/services/order.py",
				"--direction",
				"callees",
				"--depth",
				"2",
			]);

			expect(output.callers).toEqual([]);
			expect(Array.isArray(output.callees)).toBe(true);
		});

		it("resolves internal Python module imports for core engine callees", async () => {
			const output = runJsonCommand<{ callers: string[]; callees: string[] }>([
				"deps",
				"src/core/engine.py",
				"--direction",
				"callees",
			]);
			const dependencies = await listStoredDependencies("src/core/engine.py");

			expect(output.callers).toEqual([]);
			expect(output.callees).toEqual(
				expect.arrayContaining([
					"src/config/settings.py",
					"src/utils/helpers.py",
				]),
			);
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
			const output = runJsonCommand<{ callers: string[]; callees: string[] }>([
				"deps",
				"src/api/v1/handler.py",
				"--direction",
				"callees",
			]);
			const dependencies = await listStoredDependencies(
				"src/api/v1/handler.py",
			);

			expect(output.callers).toEqual([]);
			expect(output.callees).toContain("src/auth/session.py");
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
			const result = runCLI(["deps", "src/services/order.py", "--txt"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: src/services/order.py");
			expect(result.stdout).toContain("Callers");
		});

		it("handles worker cycle queries without error", () => {
			const output = runJsonCommand<{
				path: string;
				callers: string[];
				callees: string[];
			}>(["deps", "src/workers/email.py"]);

			expect(output.path).toBe("src/workers/email.py");
			expect(Array.isArray(output.callers)).toBe(true);
			expect(Array.isArray(output.callees)).toBe(true);
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
