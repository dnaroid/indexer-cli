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
} from "../helpers/cli-runner-ruby";

const TEMP_DIR = path.join(os.tmpdir(), "indexer-cli-e2e-ruby");
const FIXTURE_FILE_COUNT = 20;

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
		it("indexes the Ruby fixture project", () => {
			const result = runCLI(["index", "--full"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Index completed successfully.");
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
			expect(output.stats.symbols).toBeGreaterThan(30);
			expect(output.stats.chunks).toBeGreaterThan(0);
			expect(output.stats.dependencies).toBeGreaterThan(0);
			expect(output.languages.ruby).toBe(FIXTURE_FILE_COUNT);
		});

		it("shows the indexed file tree", () => {
			const output = runJsonCommand<{ files: string[] }>([
				"index",
				"--status",
				"--tree",
			]);

			expect(output.files).toContain("bin/app.rb");
			expect(output.files).toContain("lib/auth/session.rb");
			expect(output.files).toContain("lib/game/session.rb");
			expect(output.files).toContain("lib/payments/processor.rb");
			expect(output.files).toContain("lib/utils/errors.rb");
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

			const authIndex = firstResultIndex(results, "lib/auth/session.rb");
			const gameIndex = firstResultIndex(results, "lib/game/session.rb");

			expect(authIndex).toBeGreaterThanOrEqual(0);
			if (gameIndex >= 0) {
				expect(authIndex).toBeLessThan(gameIndex);
			}
			expect(results[authIndex]?.score).toBeGreaterThan(0.35);
		});

		it("matches game round queries more strongly than auth session queries", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"game round match players scoreboard session",
				"--max-files",
				"6",
			]);

			const gameIndex = firstResultIndex(results, "lib/game/session.rb");
			const authIndex = firstResultIndex(results, "lib/auth/session.rb");

			expect(gameIndex).toBeGreaterThanOrEqual(0);
			if (authIndex >= 0) {
				expect(gameIndex).toBeLessThan(authIndex);
			}
			expect(results[gameIndex]?.score).toBeGreaterThan(0.35);
		});

		it("finds payment processing abstractions and implementations", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"payment processing provider charge refund checkout stripe",
				"--max-files",
				"6",
			]);

			expect(
				results.some((result) => result.filePath.startsWith("lib/payments/")),
			).toBe(true);
			const processorIndex = firstResultIndex(
				results,
				"lib/payments/processor.rb",
			);
			const stripeIndex = firstResultIndex(
				results,
				"lib/payments/stripe_processor.rb",
			);
			expect(processorIndex >= 0 || stripeIndex >= 0).toBe(true);
		});

		it("finds Sinatra-oriented entrypoint queries", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"sinatra request route cli app",
				"--max-files",
				"4",
			]);

			expect(firstResultIndex(results, "bin/app.rb")).toBeGreaterThanOrEqual(0);
		});

		it("respects --min-score to filter noise", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"authentication login token session",
				"--max-files",
				"10",
				"--min-score",
				"0.45",
			]);

			for (const result of results) {
				expect(result.score).toBeGreaterThanOrEqual(0.45);
			}
			expect(results.length).toBeGreaterThan(0);
		});

		it("respects --max-files", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"service order creation user validation",
				"--max-files",
				"1",
			]);

			expect(results.length).toBeLessThanOrEqual(1);
		});

		it("includes content with --include-content and omits it by default", () => {
			const withContent = runJsonCommand<SearchResult[]>([
				"search",
				"pagination offset limit helper",
				"--include-content",
				"--max-files",
				"3",
			]);
			const withoutContent = runJsonCommand<SearchResult[]>([
				"search",
				"pagination offset limit helper",
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
					"pagination offset limit helper",
					"--txt",
					"--max-files",
					"3",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("score:");
			expect(result.stdout).toContain("lib/helpers/pagination_helper.rb");
		});

		it("respects --path-prefix", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"user validation create user session",
				"--path-prefix",
				"lib/services",
				"--max-files",
				"5",
			]);

			expect(results.length).toBeGreaterThan(0);
			for (const result of results) {
				expect(result.filePath.startsWith("lib/services")).toBe(true);
			}
		});
	});

	describe("structure", () => {
		it("returns a JSON tree with files and symbols", () => {
			const output = runJsonCommand<StructureEntry[]>(["structure"]);
			const files = flattenFiles(output);

			expect(files.length).toBeGreaterThan(0);
			expect(
				files.some((entry) => entry.path === "lib/payments/processor.rb"),
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

		it("filters methods with --kind method", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--kind",
				"method",
			]);
			const files = flattenFiles(output);

			for (const file of files) {
				for (const symbol of file.symbols ?? []) {
					expect(symbol.kind).toBe("method");
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

		it("filters modules with --kind module", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--kind",
				"module",
			]);
			const files = flattenFiles(output);

			for (const file of files) {
				for (const symbol of file.symbols ?? []) {
					expect(symbol.kind).toBe("module");
				}
			}
			expect(
				files.some((file) =>
					(file.symbols ?? []).some(
						(symbol) => symbol.name === "ProcessorBase",
					),
				),
			).toBe(true);
		});

		it("shows private Ruby methods as non-exported", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--path-prefix",
				"lib/services/user_service.rb",
			]);
			const files = flattenFiles(output);
			const userServiceFile = files.find(
				(file) => file.path === "lib/services/user_service.rb",
			);

			expect(userServiceFile).toBeTruthy();
			expect(userServiceFile?.symbols).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "normalize_email",
						kind: "method",
						exported: false,
					}),
				]),
			);
		});

		it("renders text output", () => {
			const result = runCLI(["structure", "--txt"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("lib/");
			expect(result.stdout).toContain("ProcessorBase");
		});

		it("respects --path-prefix and distinguishes same-named handlers", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--path-prefix",
				"lib/api",
			]);
			const files = flattenFiles(output);
			const handlerFiles = files.filter((file) => file.name === "handler.rb");

			expect(handlerFiles.length).toBe(2);
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
	});

	describe("architecture", () => {
		it("returns file stats, entrypoints, and internal dependencies", () => {
			const output = runJsonCommand<{
				file_stats: Record<string, number>;
				entrypoints: string[];
				dependency_map: { internal: Record<string, string[]> };
				files: Array<{ path: string; language: string }>;
			}>(["architecture"]);

			expect(output.file_stats.ruby).toBe(FIXTURE_FILE_COUNT);
			expect(output.entrypoints).toContain("bin/app.rb");
			expect(output.files.length).toBe(FIXTURE_FILE_COUNT);
			expect(
				Object.keys(output.dependency_map.internal).length,
			).toBeGreaterThan(0);
			expect(JSON.stringify(output.dependency_map.internal)).toMatch(
				/lib\/payments|lib\/services|lib\/auth/,
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
			}>(["architecture", "--path-prefix", "lib/payments"]);

			expect(output.file_stats.ruby).toBe(2);
			for (const file of output.files) {
				expect(file.path.startsWith("lib/payments")).toBe(true);
			}
		});

		it("detects the Ruby bin entrypoint", () => {
			const output = runJsonCommand<{ entrypoints: string[] }>([
				"architecture",
			]);

			expect(output.entrypoints).toContain("bin/app.rb");
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

			expect(output.architecture.fileStats.ruby).toBe(FIXTURE_FILE_COUNT);
			expect(output.architecture.entrypoints).toContain("bin/app.rb");
			expect(output.modules.length).toBeGreaterThan(0);
			expect(
				output.symbols.some((symbol) => symbol.name === "UserService"),
			).toBe(true);
			expect(
				output.symbols.some((symbol) => symbol.name === "ProcessorBase"),
			).toBe(true);
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

			const output = runJsonCommand<{
				modules: Array<{ path: string }>;
				symbols: Array<{ file: string; name: string; kind: string }>;
				_meta: { scope: string };
			}>(["context", "--scope", "changed"]);

			expect(output._meta.scope).toBe("changed");
			expect(
				output.modules.some(
					(module) => module.path === "lib/services/order_service.rb",
				),
			).toBe(true);
			expect(
				output.symbols.some(
					(symbol) => symbol.file === "lib/services/order_service.rb",
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
			}>(["context", "--scope", "relevant-to:lib/services/order_service.rb"]);

			expect(output._meta.scope).toBe(
				"relevant-to:lib/services/order_service.rb",
			);
			expect(output.modules.map((module) => module.path)).toContain(
				"lib/services/order_service.rb",
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
			}>(["explain", "create_session"]);

			expect(output.name).toBe("create_session");
			expect(output.kind).toBe("method");
			expect(output.file).toBe("lib/auth/session.rb");
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
			expect(output.file).toBe("lib/services/user_service.rb");
		});

		it("explains ProcessorBase", () => {
			const output = runJsonCommand<{
				name: string;
				kind: string;
				file: string;
			}>(["explain", "ProcessorBase"]);

			expect(output.name).toBe("ProcessorBase");
			expect(output.kind).toBe("module");
			expect(output.file).toBe("lib/payments/processor.rb");
		});

		it("supports file::symbol syntax", () => {
			const output = runJsonCommand<{ name: string; file: string }>([
				"explain",
				"lib/payments/processor.rb::ProcessorBase",
			]);

			expect(output.name).toBe("ProcessorBase");
			expect(output.file).toBe("lib/payments/processor.rb");
		});

		it("renders text output", () => {
			const result = runCLI(["explain", "ProcessorBase", "--txt"], {
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
			const output = JSON.parse(result.stdout);
			const items = Array.isArray(output) ? output : [output];
			const files = items.map((item: { file: string }) => item.file);
			expect(files).toContain("lib/api/v1/handler.rb");
			expect(files).toContain("lib/api/v2/handler.rb");
		});
	});

	describe("deps", () => {
		it("returns callers and callees for a module with both", () => {
			const output = runJsonCommand<{
				path: string;
				callers: string[];
				callees: string[];
			}>(["deps", "lib/services/user_service.rb"]);

			expect(output.path).toBe("lib/services/user_service.rb");
			expect(output.callers).toContain("bin/app.rb");
			expect(output.callers).toContain("lib/services/order_service.rb");
			expect(output.callees).toContain("lib/auth/session.rb");
			expect(output.callees).toContain("lib/utils/errors.rb");
		});

		it("respects --direction callers", () => {
			const output = runJsonCommand<{
				callers: string[];
				callees: string[];
			}>(["deps", "lib/services/user_service.rb", "--direction", "callers"]);

			expect(output.callers).toContain("bin/app.rb");
			expect(output.callees).toEqual([]);
		});

		it("respects --direction callees and --depth", () => {
			const output = runJsonCommand<{
				callers: string[];
				callees: string[];
			}>([
				"deps",
				"lib/services/order_service.rb",
				"--direction",
				"callees",
				"--depth",
				"2",
			]);

			expect(output.callers).toEqual([]);
			expect(output.callees).toContain("lib/services/user_service.rb");
			expect(output.callees).toContain("lib/payments/stripe_processor.rb");
			expect(output.callees).toContain("lib/payments/processor.rb");
		});

		it("renders text output", () => {
			const result = runCLI(["deps", "lib/services/user_service.rb", "--txt"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: lib/services/user_service.rb");
			expect(result.stdout).toContain("Callers");
		});

		it("handles circular dependencies without infinite loop", () => {
			const output = runJsonCommand<{
				path: string;
				callers: string[];
				callees: string[];
			}>(["deps", "lib/workers/email_worker.rb"]);

			expect(output.callers).toContain("lib/workers/notification_worker.rb");
			expect(output.callees).toContain("lib/workers/notification_worker.rb");
		});

		it("shows require_relative dependencies for API handlers", () => {
			const output = runJsonCommand<{
				path: string;
				callees: string[];
			}>(["deps", "lib/api/v1/handler.rb", "--direction", "callees"]);

			expect(output.path).toBe("lib/api/v1/handler.rb");
			expect(output.callees).toContain("lib/services/user_service.rb");
			expect(output.callees).toContain("lib/helpers/pagination_helper.rb");
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
