import { writeFileSync } from "node:fs";
import Database from "better-sqlite3";
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
} from "../helpers/cli-runner-csharp";

const TEMP_DIR = path.join(os.tmpdir(), "indexer-cli-e2e-csharp");
const FIXTURE_FILE_COUNT = 25;

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

type StoredDependency = {
	fromPath: string;
	toSpecifier: string;
	toPath?: string;
	dependencyType: "internal" | "external" | "builtin" | "unresolved";
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

function listIndexedDependencies(fromPath: string): StoredDependency[] {
	const db = new Database(path.join(TEMP_DIR, ".indexer-cli", "db.sqlite"), {
		readonly: true,
	});

	try {
		const latestSnapshot = db
			.prepare(
				"SELECT project_id AS projectId, id AS snapshotId FROM snapshots ORDER BY created_at DESC, id DESC LIMIT 1",
			)
			.get() as { projectId: string; snapshotId: string } | undefined;

		expect(latestSnapshot).toBeDefined();

		const rows = db
			.prepare(
				"SELECT from_path AS fromPath, to_specifier AS toSpecifier, to_path AS toPath, dependency_type AS dependencyType FROM dependencies WHERE project_id = ? AND snapshot_id = ? AND from_path = ? ORDER BY to_specifier",
			)
			.all(
				latestSnapshot?.projectId,
				latestSnapshot?.snapshotId,
				fromPath,
			) as Array<{
			fromPath: string;
			toSpecifier: string;
			toPath: string | null;
			dependencyType: StoredDependency["dependencyType"];
		}>;

		return rows.map((row) => ({
			fromPath: row.fromPath,
			toSpecifier: row.toSpecifier,
			toPath: row.toPath ?? undefined,
			dependencyType: row.dependencyType,
		}));
	} finally {
		db.close();
	}
}

function getIndexedDependency(
	fromPath: string,
	toSpecifier: string,
): StoredDependency | undefined {
	return listIndexedDependencies(fromPath).find(
		(dependency) => dependency.toSpecifier === toSpecifier,
	);
}

describe.sequential("CLI e2e CSharp", () => {
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
		it("indexes the C# fixture project", () => {
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
			expect(output.stats.symbols).toBeGreaterThan(35);
			expect(output.stats.chunks).toBeGreaterThan(0);
			expect(output.stats.dependencies).toBeGreaterThan(0);
			expect(output.languages.csharp).toBe(FIXTURE_FILE_COUNT);
		});

		it("shows the indexed file tree", () => {
			const output = runJsonCommand<{ files: string[] }>([
				"index",
				"--status",
				"--tree",
			]);

			expect(output.files).toContain("Assets/Scripts/Game/GameManager.cs");
			expect(output.files).toContain("Assets/Scripts/Combat/CombatManager.cs");
			expect(output.files).toContain("Assets/Scripts/Multiplayer/Session.cs");
			expect(output.files).toContain(
				"Assets/Scripts/Payments/PaymentProcessor.cs",
			);
			expect(output.files).toContain("Assets/Scripts/Utils/ErrorHandler.cs");
		});

		it("supports dry-run mode", () => {
			const result = runCLI(["index", "--dry-run"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Dry run complete.");
		});
	});

	describe("search", () => {
		it("matches combat queries more strongly than multiplayer session queries", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"combat damage cooldown arena target player service",
				"--max-files",
				"6",
			]);

			const combatIndex = firstResultIndex(
				results,
				"Assets/Scripts/Combat/CombatManager.cs",
			);
			const sessionIndex = firstResultIndex(
				results,
				"Assets/Scripts/Multiplayer/Session.cs",
			);

			expect(combatIndex).toBeGreaterThanOrEqual(0);
			if (sessionIndex >= 0) {
				expect(combatIndex).toBeLessThan(sessionIndex);
			}
			expect(results[combatIndex]!.score).toBeGreaterThan(0.35);
		});

		it("matches multiplayer session queries more strongly than combat queries", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"multiplayer network lobby session heartbeat reconnect code",
				"--max-files",
				"6",
			]);

			const sessionIndex = firstResultIndex(
				results,
				"Assets/Scripts/Multiplayer/Session.cs",
			);
			const combatIndex = firstResultIndex(
				results,
				"Assets/Scripts/Combat/CombatManager.cs",
			);

			expect(sessionIndex).toBeGreaterThanOrEqual(0);
			if (combatIndex >= 0) {
				expect(sessionIndex).toBeLessThan(combatIndex);
			}
			expect(results[sessionIndex]!.score).toBeGreaterThan(0.35);
		});

		it("finds payment abstractions and Stripe implementation", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"payment processing stripe checkout provider order cents",
				"--max-files",
				"6",
			]);

			const processorIndex = firstResultIndex(
				results,
				"Assets/Scripts/Payments/PaymentProcessor.cs",
			);
			const stripeIndex = firstResultIndex(
				results,
				"Assets/Scripts/Payments/StripeProcessor.cs",
			);

			expect(processorIndex >= 0 || stripeIndex >= 0).toBe(true);
			expect(
				results.some((result) =>
					result.filePath.startsWith("Assets/Scripts/Payments/"),
				),
			).toBe(true);
		});

		it("finds error handling code for validation and network failures", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"error handling validation network exception field message",
				"--max-files",
				"6",
			]);

			const errorsIndex = firstResultIndex(
				results,
				"Assets/Scripts/Utils/ErrorHandler.cs",
			);
			expect(errorsIndex).toBeGreaterThanOrEqual(0);
			expect(results[errorsIndex]!.score).toBeGreaterThan(0.35);
		});

		it("includes Unity content when requested and omits it by default", () => {
			const withContent = runJsonCommand<SearchResult[]>([
				"search",
				"unity monobehaviour awake update lifecycle",
				"--include-content",
				"--max-files",
				"3",
			]);
			const withoutContent = runJsonCommand<SearchResult[]>([
				"search",
				"unity monobehaviour awake update lifecycle",
				"--max-files",
				"3",
			]);

			expect(withContent.length).toBeGreaterThan(0);
			expect(withContent[0]?.content).toBeTruthy();
			expect(withContent[0]?.content).toMatch(
				/Awake|Update|MonoBehaviour|UnityEngine/,
			);
			expect(withoutContent[0]?.content).toBeUndefined();
		});

		it("renders text output with --txt", () => {
			const result = runCLI(
				[
					"search",
					"unity monobehaviour awake update lifecycle",
					"--txt",
					"--max-files",
					"3",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout.toLowerCase()).toContain("score:");
			expect(result.stdout).toMatch(
				/Assets\/Scripts\/(Game\/GameManager|Combat\/CombatManager|Multiplayer\/Session)\.cs/,
			);
		});

		it("respects --path-prefix", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"player validation display name slug",
				"--path-prefix",
				"Assets/Scripts/Services",
				"--max-files",
				"5",
			]);

			expect(results.length).toBeGreaterThan(0);
			for (const result of results) {
				expect(result.filePath.startsWith("Assets/Scripts/Services")).toBe(
					true,
				);
			}
		});
	});

	describe("structure", () => {
		it("returns a JSON tree with files and symbols", () => {
			const output = runJsonCommand<StructureEntry[]>(["structure"]);
			const files = flattenFiles(output);

			expect(files.length).toBeGreaterThan(0);
			expect(
				files.some(
					(entry) =>
						entry.path === "Assets/Scripts/Payments/PaymentProcessor.cs",
				),
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
						(symbol) => symbol.name === "CombatManager",
					),
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
						(symbol) =>
							symbol.name === "ValidatePlayer" ||
							symbol.name === "ProcessPayment",
					),
				),
			).toBe(true);
			expect(
				files.some((file) =>
					(file.symbols ?? []).some(
						(symbol) => symbol.name === "Awake" || symbol.name === "Update",
					),
				),
			).toBe(true);
		});

		it("renders text output", () => {
			const result = runCLI(["structure", "--txt"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Assets/");
			expect(result.stdout).toContain("PaymentProcessor");
		});

		it("respects --path-prefix", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--path-prefix",
				"Assets/Scripts/Payments",
			]);
			const files = flattenFiles(output);

			expect(files.length).toBe(2);
			for (const file of files) {
				expect(file.path?.startsWith("Assets/Scripts/Payments")).toBe(true);
			}
		});

		it("shows deeply nested API files", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--max-depth",
				"3",
			]);
			const files = flattenFiles(output);
			expect(
				files.some((file) => file.path?.includes("API/V1/Handler.cs")),
			).toBe(true);
			expect(
				files.some((file) => file.path?.includes("API/V2/Handler.cs")),
			).toBe(true);
		});

		it("distinguishes same-named handler files in different directories", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--path-prefix",
				"Assets/Scripts/API",
			]);
			const files = flattenFiles(output);
			const handlerFiles = files.filter((file) => file.name === "Handler.cs");
			expect(handlerFiles.length).toBe(2);
		});
	});

	describe("architecture", () => {
		it("returns file stats, entrypoints, and namespace dependencies", () => {
			const output = runJsonCommand<{
				file_stats: Record<string, number>;
				entrypoints: string[];
				dependency_map: {
					internal: Record<string, string[]>;
					external: Record<string, string[]>;
					unresolved: Record<string, string[]>;
				};
				files: Array<{ path: string; language: string }>;
			}>(["architecture"]);

			expect(output.file_stats.csharp).toBe(FIXTURE_FILE_COUNT);
			expect(output.entrypoints).toContain(
				"Assets/Scripts/Game/GameManager.cs",
			);
			expect(output.files.length).toBe(FIXTURE_FILE_COUNT);
			expect(
				Object.keys(output.dependency_map.external).length,
			).toBeGreaterThan(0);
			expect(JSON.stringify(output.dependency_map.external)).toMatch(
				/MyApp\.Services|MyApp\.Workers\.Notifications|UnityEngine/,
			);
		});

		it("renders text output with Unity namespaces visible", () => {
			const result = runCLI(["architecture", "--txt"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("External dependencies summary");
			expect(result.stdout.toLowerCase()).toContain("unityengine");
		});

		it("respects --path-prefix", () => {
			const output = runJsonCommand<{
				file_stats: Record<string, number>;
				files: Array<{ path: string; language: string }>;
			}>(["architecture", "--path-prefix", "Assets/Scripts/Payments"]);

			expect(output.file_stats.csharp).toBe(2);
			for (const file of output.files) {
				expect(file.path.startsWith("Assets/Scripts/Payments")).toBe(true);
			}
		});

		it("classifies external Unity and System namespaces in dependency data", () => {
			const output = runJsonCommand<{
				dependency_map: { external: Record<string, string[]> };
			}>(["architecture"]);

			const external = JSON.stringify(output.dependency_map.external);
			expect(external).toContain("UnityEngine");
			expect(external).toContain("System");
		});
	});

	describe("context", () => {
		it("returns JSON context with modules, symbols, and architecture data", () => {
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

			expect(output.architecture.fileStats.csharp).toBe(FIXTURE_FILE_COUNT);
			expect(output.architecture.entrypoints).toContain(
				"Assets/Scripts/Game/GameManager.cs",
			);
			expect(output.modules.length).toBeGreaterThan(0);
			expect(
				output.symbols.some((symbol) => symbol.name === "PaymentProcessor"),
			).toBe(true);
			expect(
				output.symbols.some((symbol) => symbol.name === "ErrorHandler"),
			).toBe(true);
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
			const paymentPath = path.join(
				TEMP_DIR,
				"Assets",
				"Scripts",
				"Payments",
				"PaymentProcessor.cs",
			);
			const original = readTextFile(paymentPath);
			const updated = original.replace(
				"return amountCents > 0;",
				"return amountCents >= 100;",
			);

			writeFileSync(paymentPath, updated, "utf-8");

			const output = runJsonCommand<{
				modules: Array<{ path: string }>;
				symbols: Array<{ file: string; name: string; kind: string }>;
				_meta: { scope: string };
			}>(["context", "--scope", "changed"]);

			expect(output._meta.scope).toBe("changed");
			expect(
				output.modules.some(
					(module) =>
						module.path === "Assets/Scripts/Payments/PaymentProcessor.cs",
				),
			).toBe(true);
			expect(
				output.symbols.some(
					(symbol) =>
						symbol.file === "Assets/Scripts/Payments/PaymentProcessor.cs",
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

		it("supports relevant-to scope", () => {
			const output = runJsonCommand<{
				modules: Array<{ path: string }>;
				_meta: { scope: string };
			}>([
				"context",
				"--scope",
				"relevant-to:Assets/Scripts/Payments/StripeProcessor.cs",
			]);

			expect(output._meta.scope).toBe(
				"relevant-to:Assets/Scripts/Payments/StripeProcessor.cs",
			);
			expect(
				output.modules.some(
					(module) =>
						module.path === "Assets/Scripts/Payments/StripeProcessor.cs",
				),
			).toBe(true);
		});
	});

	describe("explain", () => {
		it("explains CombatManager", () => {
			const output = runJsonCommand<{
				name: string;
				kind: string;
				file: string;
				lines: { start: number; end: number };
			}>(["explain", "CombatManager"]);

			expect(output.name).toBe("CombatManager");
			expect(output.kind).toBe("class");
			expect(output.file).toBe("Assets/Scripts/Combat/CombatManager.cs");
			expect(output.lines.start).toBeGreaterThan(0);
		});

		it("explains ValidatePlayer", () => {
			const output = runJsonCommand<{
				name: string;
				kind: string;
				file: string;
			}>(["explain", "ValidatePlayer"]);

			expect(output.name).toBe("ValidatePlayer");
			expect(output.kind).toBe("method");
			expect(output.file).toBe("Assets/Scripts/Services/PlayerService.cs");
		});

		it("returns both ProcessPayment definitions", () => {
			const result = runCLI(["explain", "ProcessPayment"], { cwd: TEMP_DIR });
			expect(result.exitCode).toBe(0);
			const output = JSON.parse(result.stdout);
			const items = Array.isArray(output) ? output : [output];
			const files = items.map((item: { file: string }) => item.file);
			expect(files).toContain("Assets/Scripts/Payments/PaymentProcessor.cs");
			expect(files).toContain("Assets/Scripts/Payments/StripeProcessor.cs");
		});

		it("supports file::symbol syntax", () => {
			const output = runJsonCommand<{ name: string; file: string }>([
				"explain",
				"Assets/Scripts/Payments/PaymentProcessor.cs::PaymentProcessor",
			]);

			expect(output.name).toBe("PaymentProcessor");
			expect(output.file).toBe("Assets/Scripts/Payments/PaymentProcessor.cs");
		});

		it("renders text output", () => {
			const result = runCLI(["explain", "ErrorHandler", "--txt"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: ErrorHandler");
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

		it("returns multiple results for ambiguous Handler symbol", () => {
			const result = runCLI(["explain", "Handler"], { cwd: TEMP_DIR });
			expect(result.exitCode).toBe(0);
			const output = JSON.parse(result.stdout);
			const items = Array.isArray(output) ? output : [output];
			const files = items.map((item: { file: string }) => item.file);
			expect(files).toContain("Assets/Scripts/API/V1/Handler.cs");
			expect(files).toContain("Assets/Scripts/API/V2/Handler.cs");
		});
	});

	describe("deps", () => {
		it("returns resolved internal callees for deeper C# namespace imports", () => {
			const output = runJsonCommand<{
				path: string;
				callers: string[];
				callees: string[];
			}>(["deps", "Assets/Scripts/Core/EngineManager.cs"]);

			expect(output.path).toBe("Assets/Scripts/Core/EngineManager.cs");
			expect(Array.isArray(output.callers)).toBe(true);
			expect(Array.isArray(output.callees)).toBe(true);
			expect(output.callees).toContain("Assets/Scripts/Config/AppSettings.cs");
			expect(output.callees).toContain("Assets/Scripts/Types/ApiResponse.cs");
			expect(
				output.callees.some((callee) =>
					callee.startsWith("Assets/Scripts/Services/"),
				),
			).toBe(true);

			const servicesDependency = getIndexedDependency(
				"Assets/Scripts/Core/EngineManager.cs",
				"MyApp.Services",
			);
			const unityDependency = getIndexedDependency(
				"Assets/Scripts/Core/EngineManager.cs",
				"UnityEngine",
			);
			const configDependency = getIndexedDependency(
				"Assets/Scripts/Core/EngineManager.cs",
				"MyApp.Config",
			);
			const typesDependency = getIndexedDependency(
				"Assets/Scripts/Core/EngineManager.cs",
				"MyApp.Types",
			);

			expect(servicesDependency).toMatchObject({
				fromPath: "Assets/Scripts/Core/EngineManager.cs",
				toSpecifier: "MyApp.Services",
				dependencyType: "internal",
			});
			expect([
				"Assets/Scripts/Services/InventoryService.cs",
				"Assets/Scripts/Services/PlayerService.cs",
			]).toContain(servicesDependency?.toPath);
			expect(unityDependency).toMatchObject({
				fromPath: "Assets/Scripts/Core/EngineManager.cs",
				toSpecifier: "UnityEngine",
				dependencyType: "external",
			});
			expect(unityDependency?.toPath).toBeUndefined();
			expect(configDependency).toMatchObject({
				fromPath: "Assets/Scripts/Core/EngineManager.cs",
				toSpecifier: "MyApp.Config",
				toPath: "Assets/Scripts/Config/AppSettings.cs",
				dependencyType: "internal",
			});
			expect(typesDependency).toMatchObject({
				fromPath: "Assets/Scripts/Core/EngineManager.cs",
				toSpecifier: "MyApp.Types",
				toPath: "Assets/Scripts/Types/ApiResponse.cs",
				dependencyType: "internal",
			});
		});

		it("respects --direction callers", () => {
			const output = runJsonCommand<{
				callers: string[];
				callees: string[];
			}>([
				"deps",
				"Assets/Scripts/Payments/PaymentProcessor.cs",
				"--direction",
				"callers",
			]);

			expect(Array.isArray(output.callers)).toBe(true);
			expect(output.callees).toEqual([]);
		});

		it("handles circular worker namespace references without infinite loop", () => {
			const output = runJsonCommand<{
				path: string;
				callers: string[];
				callees: string[];
			}>([
				"deps",
				"Assets/Scripts/Workers/EmailWorker.cs",
				"--direction",
				"callees",
				"--depth",
				"2",
			]);

			expect(output.path).toBe("Assets/Scripts/Workers/EmailWorker.cs");
			expect(output.callers).toEqual([]);
			expect(Array.isArray(output.callees)).toBe(true);
		});

		it("stores external Unity and System namespace dependencies while resolving internal C# imports", () => {
			const networkDependency = getIndexedDependency(
				"Assets/Scripts/Network/NetworkClient.cs",
				"MyApp.Core",
			);
			const unityDependency = getIndexedDependency(
				"Assets/Scripts/Network/NetworkClient.cs",
				"UnityEngine",
			);
			const systemCollectionsDependency = getIndexedDependency(
				"Assets/Scripts/Core/TaskScheduler.cs",
				"System.Collections",
			);

			expect(networkDependency).toMatchObject({
				fromPath: "Assets/Scripts/Network/NetworkClient.cs",
				toSpecifier: "MyApp.Core",
				toPath: "Assets/Scripts/Core/EngineManager.cs",
				dependencyType: "internal",
			});
			expect(unityDependency).toMatchObject({
				fromPath: "Assets/Scripts/Network/NetworkClient.cs",
				toSpecifier: "UnityEngine",
				dependencyType: "external",
			});
			expect(unityDependency?.toPath).toBeUndefined();
			expect(systemCollectionsDependency).toMatchObject({
				fromPath: "Assets/Scripts/Core/TaskScheduler.cs",
				toSpecifier: "System.Collections",
				dependencyType: "external",
			});
			expect(systemCollectionsDependency?.toPath).toBeUndefined();

			const output = runJsonCommand<{
				path: string;
				callers: string[];
				callees: string[];
			}>(["deps", "Assets/Scripts/Network/NetworkClient.cs"]);

			expect(output.path).toBe("Assets/Scripts/Network/NetworkClient.cs");
			expect(output.callers).toEqual([]);
			expect(output.callees).toContain("Assets/Scripts/Core/EngineManager.cs");
		});

		it("renders text output", () => {
			const result = runCLI(
				["deps", "Assets/Scripts/Game/GameManager.cs", "--txt"],
				{
					cwd: TEMP_DIR,
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Module: Assets/Scripts/Game/GameManager.cs",
			);
			expect(result.stdout).toContain("Callers");
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
