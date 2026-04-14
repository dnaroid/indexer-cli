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

type StoredDependency = {
	fromPath: string;
	toSpecifier: string;
	toPath?: string;
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
			const result = runCLI(["index", "--status"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Snapshot:");
			expect(result.stdout).toContain(`Files: ${FIXTURE_FILE_COUNT}`);
			expect(result.stdout).toContain("Symbols:");
			expect(result.stdout).toContain("Chunks:");
			expect(result.stdout).toContain("Dependencies:");
			expect(result.stdout).toContain(
				`Languages: csharp: ${FIXTURE_FILE_COUNT}`,
			);
		});

		it("shows the indexed file tree", () => {
			const result = runCLI(["index", "--status", "--tree"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Assets/");
			expect(result.stdout).toContain("Scripts/");
			expect(result.stdout).toContain("GameManager.cs");
			expect(result.stdout).toContain("CombatManager.cs");
			expect(result.stdout).toContain("Session.cs");
			expect(result.stdout).toContain("PaymentProcessor.cs");
			expect(result.stdout).toContain("ErrorHandler.cs");
		});

		it("supports dry-run mode", () => {
			const result = runCLI(["index", "--dry-run"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Dry run complete.");
		});
	});

	describe("search", () => {
		it("matches combat queries more strongly than multiplayer session queries", () => {
			const result = runCLI(
				[
					"search",
					"combat damage cooldown arena target player service",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);

			const combatIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath === "Assets/Scripts/Combat/CombatManager.cs",
			);
			const sessionIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath === "Assets/Scripts/Multiplayer/Session.cs",
			);

			expect(combatIndex).toBeGreaterThanOrEqual(0);
			if (sessionIndex >= 0) {
				expect(combatIndex).toBeLessThan(sessionIndex);
			}
			expect(results[combatIndex]!.score).toBeGreaterThan(0.35);
		});

		it("matches multiplayer session queries more strongly than combat queries", () => {
			const result = runCLI(
				[
					"search",
					"multiplayer network lobby session heartbeat reconnect code",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);

			const sessionIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath === "Assets/Scripts/Multiplayer/Session.cs",
			);
			const combatIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath === "Assets/Scripts/Combat/CombatManager.cs",
			);

			expect(sessionIndex).toBeGreaterThanOrEqual(0);
			if (combatIndex >= 0) {
				expect(sessionIndex).toBeLessThan(combatIndex);
			}
			expect(results[sessionIndex]!.score).toBeGreaterThan(0.35);
		});

		it("finds payment abstractions and Stripe implementation", () => {
			const result = runCLI(
				[
					"search",
					"payment processing stripe checkout provider order cents",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);

			const processorIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath ===
					"Assets/Scripts/Payments/PaymentProcessor.cs",
			);
			const stripeIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath ===
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
			const result = runCLI(
				[
					"search",
					"error handling validation network exception field message",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);
			expect(result.exitCode).toBe(0);

			const errorsIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath === "Assets/Scripts/Utils/ErrorHandler.cs",
			);
			expect(errorsIndex).toBeGreaterThanOrEqual(0);
			expect(results[errorsIndex]!.score).toBeGreaterThan(0.35);
		});

		it("includes Unity content when requested and omits it by default", () => {
			const withContent = runCLI(
				[
					"search",
					"unity monobehaviour awake update lifecycle",
					"--include-content",
					"--max-files",
					"3",
				],
				{ cwd: TEMP_DIR },
			);
			const withoutContent = runCLI(
				[
					"search",
					"unity monobehaviour awake update lifecycle",
					"--max-files",
					"3",
				],
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
				[
					"search",
					"unity monobehaviour awake update lifecycle",
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
			const result = runCLI(
				[
					"search",
					"player validation display name slug",
					"--path-prefix",
					"Assets/Scripts/Services",
					"--max-files",
					"5",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(results.length).toBeGreaterThan(0);
			for (const searchResult of results) {
				expect(
					searchResult.filePath.startsWith("Assets/Scripts/Services"),
				).toBe(true);
			}
		});

		it("reports function names, not local variable names, in function metadata", () => {
			const result = runCLI(
				[
					"search",
					"payment processing stripe checkout provider order cents",
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
					expect(searchResult.primarySymbol).not.toBe("receipt");
					expect(searchResult.primarySymbol).not.toBe("response");
					expect(searchResult.primarySymbol).not.toBe("settings");
					expect(searchResult.primarySymbol).not.toBe("playerId");
					expect(searchResult.primarySymbol).not.toBe("displayName");
					expect(searchResult.primarySymbol).not.toBe("normalized");
					expect(searchResult.primarySymbol).not.toBe("score");
					expect(searchResult.primarySymbol).not.toBe("echo");
					expect(searchResult.primarySymbol).not.toBe("worker");
					expect(searchResult.primarySymbol).not.toBe("sessionResponse");
					expect(searchResult.primarySymbol).not.toBe("paymentResponse");
					expect(searchResult.primarySymbol).not.toBe("combatReady");
				}
			}
		});
	});

	describe("structure", () => {
		it("returns a text tree with files and symbols", () => {
			const result = runCLI(["structure"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Assets/");
			expect(result.stdout).toContain("PaymentProcessor.cs");
			expect(result.stdout).toContain("class: PaymentProcessor");
		});

		it("filters classes with --kind class", () => {
			const result = runCLI(["structure", "--kind", "class"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("class: CombatManager");
			expect(result.stdout).not.toContain("method:");
		});

		it("filters methods with --kind method", () => {
			const result = runCLI(["structure", "--kind", "method"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"method: FormatDisplayName, ValidatePlayer",
			);
			expect(result.stdout).toMatch(/ProcessPayment|Awake|Update/);
			expect(result.stdout).not.toContain("class:");
		});

		it("renders text output", () => {
			const result = runCLI(["structure"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Assets/");
			expect(result.stdout).toContain("PaymentProcessor");
		});

		it("respects --path-prefix", () => {
			const result = runCLI(
				["structure", "--path-prefix", "Assets/Scripts/Payments"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Assets/");
			expect(result.stdout).toContain("PaymentProcessor.cs");
			expect(result.stdout).toContain("StripeProcessor.cs");
			expect(result.stdout).not.toContain("CombatManager.cs");
		});

		it("shows deeply nested API files", () => {
			const result = runCLI(["structure", "--max-depth", "4"], {
				cwd: TEMP_DIR,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("V1/");
			expect(result.stdout).toContain("Handler.cs");
		});

		it("distinguishes same-named handler files in different directories", () => {
			const result = runCLI(
				["structure", "--path-prefix", "Assets/Scripts/API"],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("V1/");
			expect(result.stdout).toContain("V2/");
			expect(result.stdout.match(/Handler\.cs/g)?.length).toBe(2);
		});
	});

	describe("architecture", () => {
		it("returns file stats, entrypoints, and namespace dependencies", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain(`  csharp: ${FIXTURE_FILE_COUNT}`);
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("Assets/Scripts/Game/GameManager.cs");
			expect(result.stdout).toContain("Module dependency graph");
			expect(result.stdout).toMatch(
				/MyApp\.Services|MyApp\.Workers\.Notifications|UnityEngine/,
			);
		});

		it("renders text output with Unity namespaces visible", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("External dependencies summary");
			expect(result.stdout.toLowerCase()).toContain("unityengine");
		});

		it("respects --path-prefix", () => {
			const result = runCLI(
				["architecture", "--path-prefix", "Assets/Scripts/Payments"],
				{
					cwd: TEMP_DIR,
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("  csharp: 2");
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("  none");
			expect(result.stdout).toContain("External dependencies summary");
		});

		it("classifies external Unity and System namespaces in dependency data", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("UnityEngine");
			expect(result.stdout).toContain("System");
		});
	});

	describe("explain", () => {
		it("explains CombatManager", () => {
			const result = runCLI(["explain", "CombatManager"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: CombatManager");
			expect(result.stdout).toContain(
				"File:   Assets/Scripts/Combat/CombatManager.cs",
			);
			expect(result.stdout).toContain("Kind:   class");
			expect(result.stdout).toMatch(/lines \d+-\d+/);
		});

		it("explains ValidatePlayer", () => {
			const result = runCLI(["explain", "ValidatePlayer"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: ValidatePlayer");
			expect(result.stdout).toContain("Kind:   method");
			expect(result.stdout).toContain(
				"Assets/Scripts/Services/PlayerService.cs",
			);
		});

		it("returns both ProcessPayment definitions", () => {
			const result = runCLI(["explain", "ProcessPayment"], { cwd: TEMP_DIR });
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Assets/Scripts/Payments/PaymentProcessor.cs",
			);
			expect(result.stdout).toContain(
				"Assets/Scripts/Payments/StripeProcessor.cs",
			);
			expect(result.stdout.match(/^Symbol:/gm)?.length).toBeGreaterThan(1);
		});

		it("supports file::symbol syntax", () => {
			const result = runCLI(
				[
					"explain",
					"Assets/Scripts/Payments/PaymentProcessor.cs::PaymentProcessor",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Symbol: PaymentProcessor");
			expect(result.stdout).toContain(
				"File:   Assets/Scripts/Payments/PaymentProcessor.cs",
			);
		});

		it("renders text output", () => {
			const result = runCLI(["explain", "ErrorHandler"], {
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
			expect(result.stdout).toContain("Assets/Scripts/API/V1/Handler.cs");
			expect(result.stdout).toContain("Assets/Scripts/API/V2/Handler.cs");
			expect(result.stdout.match(/^Symbol:/gm)?.length).toBeGreaterThan(1);
		});
	});

	describe("deps", () => {
		it("returns resolved internal callees for deeper C# namespace imports", () => {
			const result = runCLI(["deps", "Assets/Scripts/Core/EngineManager.cs"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Module: Assets/Scripts/Core/EngineManager.cs",
			);
			expect(result.stdout).toContain("Callees");
			expect(result.stdout).toContain("Assets/Scripts/Config/AppSettings.cs");
			expect(result.stdout).toContain("Assets/Scripts/Types/ApiResponse.cs");
			expect(result.stdout).toMatch(/Assets\/Scripts\/Services\//);

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
			const result = runCLI(
				[
					"deps",
					"Assets/Scripts/Payments/PaymentProcessor.cs",
					"--direction",
					"callers",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Module: Assets/Scripts/Payments/PaymentProcessor.cs",
			);
			expect(result.stdout).toContain("Callers");
			expect(result.stdout).not.toContain("Callees");
		});

		it("handles circular worker namespace references without infinite loop", () => {
			const result = runCLI(
				[
					"deps",
					"Assets/Scripts/Workers/EmailWorker.cs",
					"--direction",
					"callees",
					"--depth",
					"2",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Module: Assets/Scripts/Workers/EmailWorker.cs",
			);
			expect(result.stdout).not.toContain("Callers");
			expect(result.stdout).toContain("Callees");
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

			const result = runCLI(
				["deps", "Assets/Scripts/Network/NetworkClient.cs"],
				{
					cwd: TEMP_DIR,
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Module: Assets/Scripts/Network/NetworkClient.cs",
			);
			expect(result.stdout).toContain("Callees");
			expect(result.stdout).toContain("Assets/Scripts/Core/EngineManager.cs");
		});

		it("renders text output", () => {
			const result = runCLI(["deps", "Assets/Scripts/Game/GameManager.cs"], {
				cwd: TEMP_DIR,
			});

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
