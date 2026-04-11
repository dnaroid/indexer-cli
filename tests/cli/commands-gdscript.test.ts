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
} from "../helpers/cli-runner-gdscript";

const TEMP_DIR = path.join(os.tmpdir(), "indexer-cli-e2e-gdscript");
const FIXTURE_GDSCRIPT_FILE_COUNT = 18;

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
				"repo-architecture",
				"SKILL.md",
			);

			expect(fileExists(dataDir)).toBe(true);
			expect(fileExists(configPath)).toBe(true);
			expect(fileExists(skillPath)).toBe(true);
			expect(fileExists(hookPath)).toBe(true);
			expect(readTextFile(configPath)).toContain("jina-8k");
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
			expect(output.stats.files).toBe(FIXTURE_GDSCRIPT_FILE_COUNT);
			expect(output.stats.symbols).toBeGreaterThan(20);
			expect(output.stats.chunks).toBeGreaterThan(0);
			expect(output.stats.dependencies).toBeGreaterThan(0);
			expect(output.languages.gdscript).toBe(FIXTURE_GDSCRIPT_FILE_COUNT);
		});

		it("shows the indexed file tree", () => {
			const output = runJsonCommand<{ files: string[] }>([
				"index",
				"--status",
				"--tree",
			]);

			expect(output.files).toContain("scripts/main.gd");
			expect(output.files).toContain("scripts/game/game_manager.gd");
			expect(output.files).toContain("scripts/combat/combat_manager.gd");
			expect(output.files).toContain("scripts/multiplayer/session.gd");
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
				"combat damage battle target health victory",
				"--max-files",
				"6",
			]);

			const combatIndex = firstResultIndex(
				results,
				"scripts/combat/combat_manager.gd",
			);
			const sessionIndex = firstResultIndex(
				results,
				"scripts/multiplayer/session.gd",
			);

			expect(combatIndex).toBeGreaterThanOrEqual(0);
			if (sessionIndex >= 0) {
				expect(combatIndex).toBeLessThan(sessionIndex);
			}
			expect(results[combatIndex]?.score).toBeGreaterThan(0.35);
		});

		it("matches multiplayer lobby queries more strongly than combat manager queries", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"multiplayer lobby connect disconnect peer retries session",
				"--max-files",
				"6",
			]);

			const sessionIndex = firstResultIndex(
				results,
				"scripts/multiplayer/session.gd",
			);
			const combatIndex = firstResultIndex(
				results,
				"scripts/combat/combat_manager.gd",
			);

			expect(sessionIndex).toBeGreaterThanOrEqual(0);
			if (combatIndex >= 0) {
				expect(sessionIndex).toBeLessThan(combatIndex);
			}
			expect(results[sessionIndex]?.score).toBeGreaterThan(0.35);
		});

		it("filters background noise when querying combat-specific concepts", () => {
			const results = runJsonCommand<SearchResult[]>([
				"search",
				"combat damage dealt battle manager session",
				"--max-files",
				"5",
				"--min-score",
				"0.34",
			]);

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
			const withContent = runJsonCommand<SearchResult[]>([
				"search",
				"warning logger error code detail",
				"--include-content",
				"--max-files",
				"3",
			]);
			const withoutContent = runJsonCommand<SearchResult[]>([
				"search",
				"warning logger error code detail",
				"--max-files",
				"3",
			]);

			expect(withContent.length).toBeGreaterThan(0);
			expect(withContent[0]?.content).toBeTruthy();
			expect(withoutContent[0]?.content).toBeUndefined();
		});

		it("renders text output and respects --path-prefix", () => {
			const textResult = runCLI(
				["search", "audio track muted music", "--txt", "--max-files", "3"],
				{ cwd: TEMP_DIR },
			);
			const pathResults = runJsonCommand<SearchResult[]>([
				"search",
				"save profile language slot",
				"--path-prefix",
				"scripts/db",
				"--max-files",
				"5",
			]);

			expect(textResult.exitCode).toBe(0);
			expect(textResult.stdout).toContain(
				"scripts/singletons/audio_manager.gd",
			);
			expect(pathResults.length).toBeGreaterThan(0);
			for (const result of pathResults) {
				expect(result.filePath.startsWith("scripts/db")).toBe(true);
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
					(entry) => entry.path === "scripts/combat/combat_manager.gd",
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
					(file.symbols ?? []).some((symbol) => symbol.name === "_ready"),
				),
			).toBe(true);
		});

		it("filters signals with --kind signal", () => {
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--kind",
				"signal",
			]);
			const files = flattenFiles(output);

			for (const file of files) {
				for (const symbol of file.symbols ?? []) {
					expect(symbol.kind).toBe("signal");
				}
			}
			expect(
				files.some((file) =>
					(file.symbols ?? []).some((symbol) => symbol.name === "damage_dealt"),
				),
			).toBe(true);
		});

		it("renders text output and respects path filtering", () => {
			const textResult = runCLI(["structure", "--txt"], { cwd: TEMP_DIR });
			const output = runJsonCommand<StructureEntry[]>([
				"structure",
				"--path-prefix",
				"scripts/ui",
			]);
			const files = flattenFiles(output);

			expect(textResult.exitCode).toBe(0);
			expect(textResult.stdout).toContain("CombatManager");
			expect(textResult.stdout).toContain("damage_dealt");
			expect(files.length).toBe(2);
			for (const file of files) {
				expect(file.path?.startsWith("scripts/ui")).toBe(true);
			}
		});
	});

	describe("architecture", () => {
		it("returns file stats, entrypoints, dependencies, and godot files", () => {
			const output = runJsonCommand<{
				file_stats: Record<string, number>;
				entrypoints: string[];
				dependency_map: { internal: Record<string, string[]> };
				files: Array<{ path: string; language: string }>;
			}>(["architecture"]);

			expect(output.file_stats.gdscript).toBe(FIXTURE_GDSCRIPT_FILE_COUNT);
			expect(output.entrypoints).toContain("scripts/main.gd");
			expect(output.entrypoints).toContain("scripts/game/game_manager.gd");
			expect(output.files.length).toBe(FIXTURE_GDSCRIPT_FILE_COUNT);
			expect(
				Object.keys(output.dependency_map.internal).length,
			).toBeGreaterThan(0);
			expect(JSON.stringify(output.files)).toMatch(/gdscript/);
		});

		it("renders text output with the Godot framework hint", () => {
			const result = runCLI(["architecture", "--txt"], { cwd: TEMP_DIR });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("Entrypoints");
			expect(result.stdout).toContain("gdscript");
			expect(result.stdout).toMatch(/Node|CanvasLayer|Resource/);
		});
	});

	describe("context", () => {
		it("returns JSON context with GDScript symbols and dependencies", () => {
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

			expect(output.architecture.fileStats.gdscript).toBe(
				FIXTURE_GDSCRIPT_FILE_COUNT,
			);
			expect(output.architecture.entrypoints).toContain("scripts/main.gd");
			expect(
				output.symbols.some((symbol) => symbol.name === "CombatManager"),
			).toBe(true);
			expect(
				output.symbols.some((symbol) => symbol.name === "damage_dealt"),
			).toBe(true);
			expect(Object.keys(output.dependencies).length).toBeGreaterThan(0);
			expect(output._meta.scope).toBe("all");
		});

		it("renders text output and supports changed scope with a GDScript edit", () => {
			const textResult = runCLI(["context", "--txt"], { cwd: TEMP_DIR });
			const healthPath = path.join(
				TEMP_DIR,
				"scripts",
				"resources",
				"health_resource.gd",
			);
			const original = readTextFile(healthPath);
			const updated = original.replace(
				"@export var regeneration_rate: float = 1.5",
				"@export var regeneration_rate: float = 2.0",
			);

			writeFileSync(healthPath, updated, "utf-8");

			const changed = runJsonCommand<{
				modules: Array<{ path: string }>;
				symbols: Array<{ file: string; name: string; kind: string }>;
				_meta: { scope: string };
			}>(["context", "--scope", "changed"]);

			expect(textResult.exitCode).toBe(0);
			expect(textResult.stdout).toContain("## Architecture");
			expect(changed._meta.scope).toBe("changed");
			expect(
				changed.modules.some(
					(module) => module.path === "scripts/resources/health_resource.gd",
				),
			).toBe(true);
			expect(
				changed.symbols.some(
					(symbol) => symbol.file === "scripts/resources/health_resource.gd",
				),
			).toBe(true);
		});
	});

	describe("explain", () => {
		it("explains CombatManager and damage_dealt", () => {
			const combatManager = runJsonCommand<{
				name: string;
				kind: string;
				file: string;
			}>(["explain", "CombatManager"]);
			const damageSignal = runJsonCommand<
				| {
						name: string;
						kind: string;
						file: string;
				  }
				| Array<{
						name: string;
						kind: string;
						file: string;
				  }>
			>(["explain", "damage_dealt"]);
			const damageItems = Array.isArray(damageSignal)
				? damageSignal
				: [damageSignal];
			const matchingSignal = damageItems.find(
				(item) =>
					item.name === "damage_dealt" &&
					item.file === "scripts/combat/combat_manager.gd",
			);

			expect(combatManager.name).toBe("CombatManager");
			expect(combatManager.kind).toBe("class");
			expect(combatManager.file).toBe("scripts/combat/combat_manager.gd");
			expect(matchingSignal?.kind).toBe("signal");
		});

		it("supports file::symbol syntax and returns multiple lifecycle matches for _ready", () => {
			const fileSymbol = runJsonCommand<{ name: string; file: string }>([
				"explain",
				"scripts/combat/combat_manager.gd::CombatManager",
			]);
			const result = runCLI(["explain", "_ready"], { cwd: TEMP_DIR });

			expect(fileSymbol.name).toBe("CombatManager");
			expect(fileSymbol.file).toBe("scripts/combat/combat_manager.gd");
			expect(result.exitCode).toBe(0);
			const output = JSON.parse(result.stdout) as
				| Array<{ file: string; name: string }>
				| { file: string; name: string };
			const items = Array.isArray(output) ? output : [output];
			expect(items.length).toBeGreaterThan(1);
			expect(items.some((item) => item.file === "scripts/main.gd")).toBe(true);
			expect(
				items.some((item) => item.file === "scripts/combat/combat_manager.gd"),
			).toBe(true);
		});

		it("renders text output and errors on unknown symbols", () => {
			const textResult = runCLI(["explain", "damage_dealt", "--txt"], {
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
			const output = runJsonCommand<{
				path: string;
				callers: string[];
				callees: string[];
			}>(["deps", "scripts/combat/combat_manager.gd"]);

			expect(output.path).toBe("scripts/combat/combat_manager.gd");
			expect(output.callers).toContain("scripts/game/game_manager.gd");
			expect(output.callers).toContain("scripts/multiplayer/session.gd");
			expect(output.callers).toContain("scripts/ui/hud.gd");
			expect(output.callees).toContain("scripts/multiplayer/session.gd");
			expect(output.callees).toContain("scripts/resources/health_resource.gd");
		});

		it("handles the circular preload between combat_manager and session", () => {
			const output = runJsonCommand<{
				callers: string[];
				callees: string[];
			}>(["deps", "scripts/multiplayer/session.gd"]);

			expect(output.callers).toContain("scripts/combat/combat_manager.gd");
			expect(output.callees).toContain("scripts/combat/combat_manager.gd");
		});

		it("respects direction, depth, and text output", () => {
			const callersOnly = runJsonCommand<{
				callers: string[];
				callees: string[];
			}>([
				"deps",
				"scripts/combat/combat_manager.gd",
				"--direction",
				"callers",
			]);
			const calleesDepth = runJsonCommand<{
				callers: string[];
				callees: string[];
			}>([
				"deps",
				"scripts/game/game_manager.gd",
				"--direction",
				"callees",
				"--depth",
				"2",
			]);
			const textResult = runCLI(
				["deps", "scripts/combat/combat_manager.gd", "--txt"],
				{ cwd: TEMP_DIR },
			);

			expect(callersOnly.callees).toEqual([]);
			expect(callersOnly.callers).toContain("scripts/game/game_manager.gd");
			expect(callersOnly.callers).toContain("scripts/multiplayer/session.gd");
			expect(calleesDepth.callers).toEqual([]);
			expect(calleesDepth.callees).toContain(
				"scripts/combat/combat_manager.gd",
			);
			expect(calleesDepth.callees).toContain("scripts/multiplayer/session.gd");
			expect(textResult.exitCode).toBe(0);
			expect(textResult.stdout).toContain(
				"Module: scripts/combat/combat_manager.gd",
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
