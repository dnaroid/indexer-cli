import { CommanderError, program } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerIndexCommand } from "./commands/index.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerStructureCommand } from "./commands/structure.js";
import { registerArchitectureCommand } from "./commands/architecture.js";
import { registerUninstallCommand } from "./commands/uninstall.js";
import { registerReinitCommand } from "./commands/reinit.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerExplainCommand } from "./commands/explain.js";
import { registerDepsCommand } from "./commands/deps.js";
import { PACKAGE_VERSION } from "../core/version.js";
import { SKILLS_VERSION } from "../core/skills-version.js";
import {
	checkAndMigrateIfNeeded,
	checkAndRefreshSkills,
} from "../core/version-check.js";
import { checkForUpdates } from "../core/update-check.js";
import { PROJECT_ROOT_PROGRAM_HELP } from "./help-text.js";

const SKIP_MIGRATION_COMMANDS = new Set([
	"setup",
	"init",
	"uninstall",
	"reinit",
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
	.description(
		"Lightweight project indexer with semantic search. Run project commands from the root of the target project; `setup` can run anywhere.",
	)
	.version(`${PACKAGE_VERSION} (skills: ${SKILLS_VERSION})`)
	.addHelpText(
		"after",
		`\nVersion: ${PACKAGE_VERSION} (skills: ${SKILLS_VERSION})\n\n${PROJECT_ROOT_PROGRAM_HELP}\n`,
	)
	.exitOverride();

registerSetupCommand(program);
registerInitCommand(program);
registerIndexCommand(program);
registerSearchCommand(program);
registerStructureCommand(program);
registerArchitectureCommand(program);
registerExplainCommand(program);
registerDepsCommand(program);
registerUninstallCommand(program);
registerReinitCommand(program);

program.hook("preAction", async (thisCommand, actionCommand) => {
	void thisCommand;
	await runPreActionChecks(actionCommand.name());
});

async function main(): Promise<void> {
	try {
		await program.parseAsync();
	} catch (error: unknown) {
		if (!isHandledCommanderExit(error)) {
			throw error;
		}
	}
}

main();
