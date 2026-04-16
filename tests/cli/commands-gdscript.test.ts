import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	DEFAULT_PROJECT_ID,
	type DependencyRecord,
} from "../../src/core/types.js";
import { SqliteMetadataStore } from "../../src/storage/sqlite.js";

import {
	createTempProject,
	fileExists,
	gitInit,
	readTextFile,
	removeTempProject,
	runCLI,
} from "../helpers/cli-runner-gdscript";

const TEMP_DIR = path.join(os.tmpdir(), "indexer-cli-e2e-gdscript");
const FIXTURE_GDSCRIPT_FILE_COUNT = 23;

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
): Promise<DependencyRecord[]> {
	const dbPath = path.join(TEMP_DIR, ".indexer-cli", "db.sqlite");
	const metadata = new SqliteMetadataStore(dbPath);

	try {
		await metadata.initialize();
		const snapshot =
			await metadata.getLatestCompletedSnapshot(DEFAULT_PROJECT_ID);
		expect(snapshot).toBeTruthy();
		return await metadata.listDependencies(
			DEFAULT_PROJECT_ID,
			snapshot!.id,
			filePath,
		);
	} finally {
		await metadata.close().catch(() => undefined);
	}
}

function expectDependency(
	dependencies: DependencyRecord[],
	toSpecifier: string,
): DependencyRecord {
	const dependency = dependencies.find(
		(item) => item.toSpecifier === toSpecifier,
	);
	expect(dependency).toBeTruthy();
	return dependency!;
}

describe.sequential("CLI e2e GDScript", () => {
	beforeAll(() => {
		removeTempProject(TEMP_DIR);
		createTempProject(TEMP_DIR);
		gitInit(TEMP_DIR);
	}, 30_000);

	afterAll(() => {
		removeTempProject(TEMP_DIR);
	});

	describe("init", () => {
		it("creates indexer data, skills, and hook", () => {
			const result = runCLI(["init"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Initialized indexer-cli");

			const dataDir = path.join(TEMP_DIR, ".indexer-cli");
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
			expect(fileExists(configPath)).toBe(true);
			expect(fileExists(skillPath)).toBe(true);
			expect(fileExists(hookPath)).toBe(true);
			expect(readTextFile(configPath)).toContain("jina-8k");
			expect(readTextFile(configPath)).toContain("skillsVersion");
			expect(
				readdirSync(path.join(TEMP_DIR, ".claude", "skills")).sort(),
			).toEqual(["repo-discovery"]);
			expect(readTextFile(path.join(TEMP_DIR, ".gitignore"))).toContain(
				".indexer-cli/",
			);
		});

		it("is idempotent", () => {
			const result = runCLI(["init"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Initialized indexer-cli");
		});
	});

	describe("index --full", () => {
		it("indexes the GDScript fixture project", () => {
			const result = runCLI(["index", "--full"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Index completed successfully.");
			expect(result.stdout).toContain("Files indexed:");
		});

		it("reports GDScript status for all fixture files", () => {
			const result = runCLI(["index", "--status"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Snapshot:");
			expect(result.stdout).toContain(`Files: ${FIXTURE_GDSCRIPT_FILE_COUNT}`);
			expect(result.stdout).toContain("Symbols:");
			expect(result.stdout).toContain("Chunks:");
			expect(result.stdout).toContain("Dependencies:");
			expect(result.stdout).toContain(
				`Languages: gdscript: ${FIXTURE_GDSCRIPT_FILE_COUNT}`,
			);
		});

		it("shows the indexed file tree", () => {
			const result = runCLI(["index", "--status", "--tree"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("scripts/");
			expect(result.stdout).toContain("main.gd");
			expect(result.stdout).toContain("game_manager.gd");
			expect(result.stdout).toContain("combat_manager.gd");
			expect(result.stdout).toContain("session.gd");
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
					"combat damage battle target health victory",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);

			const combatIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath === "scripts/combat/combat_manager.gd",
			);
			const sessionIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath === "scripts/multiplayer/session.gd",
			);

			expect(combatIndex).toBeGreaterThanOrEqual(0);
			if (sessionIndex >= 0) {
				expect(combatIndex).toBeLessThan(sessionIndex);
			}
			expect(results[combatIndex]?.score).toBeGreaterThan(0.35);
		});

		it("matches multiplayer lobby queries more strongly than combat manager queries", () => {
			const result = runCLI(
				[
					"search",
					"multiplayer lobby connect disconnect peer retries session",
					"--max-files",
					"6",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);

			const sessionIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath === "scripts/multiplayer/session.gd",
			);
			const combatIndex = results.findIndex(
				(searchResult) =>
					searchResult.filePath === "scripts/combat/combat_manager.gd",
			);

			expect(sessionIndex).toBeGreaterThanOrEqual(0);
			if (combatIndex >= 0) {
				expect(sessionIndex).toBeLessThan(combatIndex);
			}
			expect(results[sessionIndex]?.score).toBeGreaterThan(0.35);
		});

		it("filters background noise when querying combat-specific concepts", () => {
			const result = runCLI(
				[
					"search",
					"combat damage dealt battle manager session",
					"--max-files",
					"5",
					"--min-score",
					"0.34",
				],
				{ cwd: TEMP_DIR },
			);
			const results = parseSearchResults(result.stdout);

			expect(result.exitCode).toBe(0);
			expect(
				results.some(
					(result) => result.filePath === "scripts/combat/combat_manager.gd",
				),
			).toBe(true);
			const bgFiles = results.filter(
				(result) =>
					result.filePath.startsWith("scripts/middleware/") ||
					result.filePath.startsWith("scripts/helpers/") ||
					result.filePath.startsWith("scripts/db/") ||
					result.filePath.startsWith("scripts/constants/") ||
					result.filePath.startsWith("scripts/types/"),
			);
			expect(bgFiles.length).toBe(0);
		});

		it("includes content with --include-content and omits it by default", () => {
			const withContent = runCLI(
				[
					"search",
					"warning logger error code detail",
					"--include-content",
					"--max-files",
					"3",
				],
				{ cwd: TEMP_DIR },
			);
			const withoutContent = runCLI(
				["search", "warning logger error code detail", "--max-files", "3"],
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

		it("renders text output and respects --path-prefix", () => {
			const textResult = runCLI(
				["search", "audio track muted music", "--max-files", "3"],
				{ cwd: TEMP_DIR },
			);
			const pathResult = runCLI(
				[
					"search",
					"save profile language slot",
					"--path-prefix",
					"scripts/db",
					"--max-files",
					"5",
				],
				{ cwd: TEMP_DIR },
			);
			const pathResults = parseSearchResults(pathResult.stdout);

			expect(textResult.exitCode).toBe(0);
			expect(textResult.stdout).toContain(
				"scripts/singletons/audio_manager.gd",
			);
			expect(pathResult.exitCode).toBe(0);
			expect(pathResults.length).toBeGreaterThan(0);
			for (const searchResult of pathResults) {
				expect(searchResult.filePath.startsWith("scripts/db")).toBe(true);
			}
		});

		it("reports function names, not local variable names, in function metadata", () => {
			const result = runCLI(
				[
					"search",
					"save profile progress logger warning",
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
					expect(searchResult.primarySymbol).not.toBe("defaults");
					expect(searchResult.primarySymbol).not.toBe("entry");
					expect(searchResult.primarySymbol).not.toBe("response");
					expect(searchResult.primarySymbol).not.toBe("score");
					expect(searchResult.primarySymbol).not.toBe("loader");
					expect(searchResult.primarySymbol).not.toBe("history");
					expect(searchResult.primarySymbol).not.toBe("elapsed");
					expect(searchResult.primarySymbol).not.toBe("retries");
					expect(searchResult.primarySymbol).not.toBe("message");
					expect(searchResult.primarySymbol).not.toBe("code");
					expect(searchResult.primarySymbol).not.toBe("error_type");
					expect(searchResult.primarySymbol).not.toBe("total");
				}
			}
		});
	});

	describe("structure", () => {
		it("returns a text tree with files and symbols", () => {
			const result = runCLI(["structure"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("scripts/");
			expect(result.stdout).toContain("combat_manager.gd");
			expect(result.stdout).toContain("class: CombatManager");
		});

		it("filters classes with --kind class", () => {
			const result = runCLI(["structure", "--kind", "class"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("class: CombatManager");
			expect(result.stdout).not.toContain("function:");
		});

		it("filters functions with --kind function", () => {
			const result = runCLI(
				["structure", "--kind", "function", "--include-internal"],
				{
					cwd: TEMP_DIR,
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("function (internal): _process, _ready");
			expect(result.stdout).not.toContain("class:");
		});

		it("filters signals with --kind signal", () => {
			const result = runCLI(["structure", "--kind", "signal"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("signal: combat_ended, damage_dealt");
			expect(result.stdout).not.toContain("function:");
		});

		it("renders text output and respects path filtering", () => {
			const textResult = runCLI(["structure"], { cwd: TEMP_DIR });
			const pathResult = runCLI(["structure", "--path-prefix", "scripts/ui"], {
				cwd: TEMP_DIR,
			});

			expect(textResult.exitCode).toBe(0);
			expect(textResult.stdout).toContain("CombatManager");
			expect(textResult.stdout).toContain("damage_dealt");
			expect(pathResult.exitCode).toBe(0);
			expect(pathResult.stdout).toContain("hud.gd");
			expect(pathResult.stdout).toContain("menu.gd");
			expect(pathResult.stdout).not.toContain("combat_manager.gd");
		});
	});

	describe("architecture", () => {
		it("returns file stats, entrypoints, dependencies, and godot files", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("File stats by language");
			expect(result.stdout).toContain(
				`  gdscript: ${FIXTURE_GDSCRIPT_FILE_COUNT}`,
			);
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("scripts/main.gd");
			expect(result.stdout).toContain("scripts/game/game_manager.gd");
			expect(result.stdout).toContain("Module dependency graph");
			expect(result.stdout).toMatch(/gdscript|scripts\//);
		});

		it("renders text output with the Godot framework hint", () => {
			const result = runCLI(["architecture"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("gdscript");
			expect(result.stdout).toMatch(/Node|CanvasLayer|Resource/);
		});
	});

	describe("explain", () => {
		it("explains CombatManager and damage_dealt", () => {
			const combatManager = runCLI(["explain", "CombatManager"], {
				cwd: TEMP_DIR,
			});
			const damageSignal = runCLI(["explain", "damage_dealt"], {
				cwd: TEMP_DIR,
			});

			expect(combatManager.exitCode).toBe(0);
			expect(combatManager.stdout).toContain("Symbol: CombatManager");
			expect(combatManager.stdout).toContain(
				"File:   scripts/combat/combat_manager.gd",
			);
			expect(combatManager.stdout).toContain("Kind:   class");
			expect(damageSignal.exitCode).toBe(0);
			expect(damageSignal.stdout).toContain("Symbol: damage_dealt");
			expect(damageSignal.stdout).toContain("Kind:   signal");
			expect(damageSignal.stdout).toContain("scripts/combat/combat_manager.gd");
		});

		it("supports file::symbol syntax and returns multiple lifecycle matches for _ready", () => {
			const fileSymbol = runCLI(
				["explain", "scripts/combat/combat_manager.gd::CombatManager"],
				{ cwd: TEMP_DIR },
			);
			const result = runCLI(["explain", "_ready"], { cwd: TEMP_DIR });

			expect(fileSymbol.exitCode).toBe(0);
			expect(fileSymbol.stdout).toContain("Symbol: CombatManager");
			expect(fileSymbol.stdout).toContain(
				"File:   scripts/combat/combat_manager.gd",
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.match(/^Symbol:/gm)?.length).toBeGreaterThan(1);
			expect(result.stdout).toContain("scripts/main.gd");
			expect(result.stdout).toContain("scripts/combat/combat_manager.gd");
		});

		it("renders text output and errors on unknown symbols", () => {
			const textResult = runCLI(["explain", "damage_dealt"], {
				cwd: TEMP_DIR,
			});
			const missingResult = runCLI(["explain", "missing_signal_xyz"], {
				cwd: TEMP_DIR,
			});

			expect(textResult.exitCode).toBe(0);
			expect(textResult.stdout).toContain("Symbol: damage_dealt");
			expect(missingResult.exitCode).toBe(1);
			expect(`${missingResult.stdout}\n${missingResult.stderr}`).toMatch(
				/symbol not found|not found/i,
			);
		});
	});

	describe("deps", () => {
		it("returns preload callers and callees for combat_manager", () => {
			const result = runCLI(["deps", "scripts/combat/combat_manager.gd"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Module: scripts/combat/combat_manager.gd",
			);
			expect(result.stdout).toContain("scripts/game/game_manager.gd");
			expect(result.stdout).toContain("scripts/multiplayer/session.gd");
			expect(result.stdout).toContain("scripts/ui/hud.gd");
			expect(result.stdout).toContain("scripts/resources/health_resource.gd");
		});

		it("stores internal preload targets for game_engine and external built-in extends", async () => {
			const result = runCLI(
				["deps", "scripts/core/game_engine.gd", "--direction", "callees"],
				{ cwd: TEMP_DIR },
			);
			const gameEngineDependencies = await listIndexedDependencies(
				"scripts/core/game_engine.gd",
			);
			const sceneLoaderDependencies = await listIndexedDependencies(
				"scripts/core/scene_loader.gd",
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Module: scripts/core/game_engine.gd");
			expect(result.stdout).toContain("scripts/game/game_manager.gd");
			expect(result.stdout).toContain("scripts/utils/helpers.gd");
			expect(result.stdout).toContain("scripts/constants/game_constants.gd");

			expect(
				expectDependency(gameEngineDependencies, "../game/game_manager.gd"),
			).toMatchObject({
				dependencyType: "internal",
				toPath: "scripts/game/game_manager.gd",
			});
			expect(
				expectDependency(gameEngineDependencies, "../utils/helpers.gd"),
			).toMatchObject({
				dependencyType: "internal",
				toPath: "scripts/utils/helpers.gd",
			});
			expect(
				expectDependency(
					gameEngineDependencies,
					"../constants/game_constants.gd",
				),
			).toMatchObject({
				dependencyType: "internal",
				toPath: "scripts/constants/game_constants.gd",
			});
			expect(expectDependency(sceneLoaderDependencies, "Node")).toMatchObject({
				dependencyType: "external",
				toPath: undefined,
			});
			expect(
				expectDependency(sceneLoaderDependencies, "../core/game_engine.gd"),
			).toMatchObject({
				dependencyType: "internal",
				toPath: "scripts/core/game_engine.gd",
			});
		});

		it("handles the circular preload between combat_manager and session", () => {
			const result = runCLI(["deps", "scripts/multiplayer/session.gd"], {
				cwd: TEMP_DIR,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("scripts/combat/combat_manager.gd");
		});

		it("resolves resource preload targets internally and keeps Resource extends external", async () => {
			const result = runCLI(
				[
					"deps",
					"scripts/resources/weapon_database.gd",
					"--direction",
					"callees",
				],
				{ cwd: TEMP_DIR },
			);
			const weaponDependencies = await listIndexedDependencies(
				"scripts/resources/weapon_database.gd",
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"Module: scripts/resources/weapon_database.gd",
			);
			expect(result.stdout).toContain("scripts/constants/game_constants.gd");
			expect(result.stdout).toContain("scripts/core/game_engine.gd");
			expect(
				expectDependency(weaponDependencies, "../constants/game_constants.gd"),
			).toMatchObject({
				dependencyType: "internal",
				toPath: "scripts/constants/game_constants.gd",
			});
			expect(
				expectDependency(weaponDependencies, "../core/game_engine.gd"),
			).toMatchObject({
				dependencyType: "internal",
				toPath: "scripts/core/game_engine.gd",
			});
			expect(expectDependency(weaponDependencies, "Resource")).toMatchObject({
				dependencyType: "external",
				toPath: undefined,
			});
		});

		it("respects direction, depth, and text output", () => {
			const callersOnly = runCLI(
				["deps", "scripts/combat/combat_manager.gd", "--direction", "callers"],
				{ cwd: TEMP_DIR },
			);
			const calleesDepth = runCLI(
				[
					"deps",
					"scripts/game/game_manager.gd",
					"--direction",
					"callees",
					"--depth",
					"2",
				],
				{ cwd: TEMP_DIR },
			);
			const textResult = runCLI(["deps", "scripts/combat/combat_manager.gd"], {
				cwd: TEMP_DIR,
			});

			expect(callersOnly.exitCode).toBe(0);
			expect(callersOnly.stdout).toContain("Callers");
			expect(callersOnly.stdout).toContain("scripts/game/game_manager.gd");
			expect(callersOnly.stdout).toContain("scripts/multiplayer/session.gd");
			expect(callersOnly.stdout).not.toContain("Callees");
			expect(calleesDepth.exitCode).toBe(0);
			expect(calleesDepth.stdout).not.toContain("Callers");
			expect(calleesDepth.stdout).toContain("scripts/combat/combat_manager.gd");
			expect(calleesDepth.stdout).toContain("scripts/multiplayer/session.gd");
			expect(textResult.exitCode).toBe(0);
			expect(textResult.stdout).toContain(
				"Module: scripts/combat/combat_manager.gd",
			);
		});

		it("follows multi-hop preload chains across resources, core, and game", () => {
			const result = runCLI(
				[
					"deps",
					"scripts/resources/armor_database.gd",
					"--direction",
					"callees",
					"--depth",
					"3",
				],
				{ cwd: TEMP_DIR },
			);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("Callers");
			expect(result.stdout).toContain("scripts/resources/weapon_database.gd");
			expect(result.stdout).toContain("scripts/core/game_engine.gd");
			expect(result.stdout).toContain("scripts/constants/game_constants.gd");
			expect(result.stdout).toContain("scripts/game/game_manager.gd");
		});
	});

	describe("uninstall", () => {
		it("removes indexer data, skills, gitignore entries, and git hook", () => {
			const result = runCLI(["uninstall", "--force"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Removed");
			expect(fileExists(path.join(TEMP_DIR, ".indexer-cli"))).toBe(false);
			expect(fileExists(path.join(TEMP_DIR, ".claude"))).toBe(false);
			expect(readTextFile(path.join(TEMP_DIR, ".gitignore"))).not.toContain(
				".indexer-cli/",
			);
		});

		it("is idempotent", () => {
			const result = runCLI(["uninstall", "--force"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Nothing to remove");
		});
	});
});
