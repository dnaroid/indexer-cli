import { CommanderError, program } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerIndexCommand } from "./commands/index.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerStructureCommand } from "./commands/structure.js";
import { registerArchitectureCommand } from "./commands/architecture.js";
import { registerUninstallCommand } from "./commands/uninstall.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerExplainCommand } from "./commands/explain.js";
import { registerDepsCommand } from "./commands/deps.js";
import { PACKAGE_VERSION } from "../core/version.js";
import { SKILLS_VERSION } from "../core/skills-version.js";
import {
	checkAndMigrateIfNeeded,
	checkAndRefreshSkills,
} from "../core/version-check.js";
import { checkForUpdates, performAutoUpdate } from "../core/update-check.js";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SKIP_MIGRATION_COMMANDS = new Set([
	"setup",
	"init",
	"uninstall",
	"doctor",
]);

const HANDLED_COMMANDER_EXIT_CODES = new Set([
	"commander.helpDisplayed",
	"commander.help",
	"commander.version",
	"commander.unknownCommand",
	"commander.missingArgument",
	"indexer.preActionFailed",
]);

async function runPreActionChecks(commandName: string): Promise<void> {
	if (SKIP_MIGRATION_COMMANDS.has(commandName)) {
		return;
	}

	await performAutoUpdate();

	try {
		await checkAndMigrateIfNeeded();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`indexer-cli: migration preflight failed: ${message}`);
		throw new CommanderError(1, "indexer.preActionFailed", "");
	}

	if ((process.exitCode ?? 0) !== 0) {
		const exitCode =
			typeof process.exitCode === "number" ? process.exitCode : 1;
		throw new CommanderError(exitCode, "indexer.preActionFailed", "");
	}

	try {
		await checkAndRefreshSkills();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`indexer-cli: skills refresh failed: ${message}`);
		process.exitCode = 1;
		throw new CommanderError(1, "indexer.preActionFailed", "");
	}

	if ((process.exitCode ?? 0) !== 0) {
		const exitCode =
			typeof process.exitCode === "number" ? process.exitCode : 1;
		throw new CommanderError(exitCode, "indexer.preActionFailed", "");
	}

	await checkForUpdates();
}

function isHandledCommanderExit(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}

	const code = Reflect.get(error, "code");
	return typeof code === "string" && HANDLED_COMMANDER_EXIT_CODES.has(code);
}

program
	.name("indexer-cli")
	.description("Lightweight project indexer with semantic search.")
	.version(`${PACKAGE_VERSION} (skills: ${SKILLS_VERSION})`)
	.addHelpText(
		"after",
		`\nVersion: ${PACKAGE_VERSION} (skills: ${SKILLS_VERSION})\n`,
	)
	.exitOverride()
	.option("--no-auto-update", "skip automatic update check");

registerSetupCommand(program);
registerInitCommand(program);
registerIndexCommand(program);
registerSearchCommand(program);
registerStructureCommand(program);
registerArchitectureCommand(program);
registerExplainCommand(program);
registerDepsCommand(program);
registerUninstallCommand(program);
registerDoctorCommand(program);

program.hook("preAction", async (thisCommand, actionCommand) => {
	void thisCommand;
	await runPreActionChecks(actionCommand.name());
});

function isIdxSetupDone(): boolean {
	const scriptPath = path.join(os.homedir(), ".local", "bin", "idx");
	return existsSync(scriptPath);
}

function hasInitializedProject(cwd: string): boolean {
	let current = path.resolve(cwd);
	while (true) {
		if (existsSync(path.join(current, ".indexer-cli", "config.json"))) {
			return true;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}

function showGuidance(): void {
	if (!isIdxSetupDone()) {
		console.log("indexer-cli is not set up yet. Run:  idx setup");
		return;
	}

	if (!hasInitializedProject(process.cwd())) {
		console.log(
			"No indexer-cli project here. Run:  cd /path/to/project && idx init",
		);
		return;
	}

	console.log("Project ready. Next steps:");
	console.log("  idx index       — index your codebase");
	console.log("  idx search <q>  — semantic search");
}

async function main(): Promise<void> {
	const hasNoArgs =
		process.argv.length === 2 ||
		(process.argv.length === 3 && process.argv[1].endsWith("indexer-cli.js"));

	if (hasNoArgs) {
		showGuidance();
		return;
	}

	try {
		await program.parseAsync();
	} catch (error: unknown) {
		if (!isHandledCommanderExit(error)) {
			throw error;
		}
	}
}

main();
