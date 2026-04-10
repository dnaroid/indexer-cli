import { program } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerIndexCommand } from "./commands/index.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerStructureCommand } from "./commands/structure.js";
import { registerArchitectureCommand } from "./commands/architecture.js";
import { registerUninstallCommand } from "./commands/uninstall.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerContextCommand } from "./commands/context.js";
import { registerContextPackCommand } from "./commands/context-pack.js";
import { registerExplainCommand } from "./commands/explain.js";
import { registerDepsCommand } from "./commands/deps.js";
import { VERSION } from "./version.js";
import { checkForUpdates } from "../core/update-check.js";
import { PROJECT_ROOT_PROGRAM_HELP } from "./help-text.js";

const HANDLED_COMMANDER_EXIT_CODES = new Set([
	"commander.helpDisplayed",
	"commander.help",
	"commander.version",
	"commander.unknownCommand",
]);

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
	.version(VERSION)
	.addHelpText("after", `\n${PROJECT_ROOT_PROGRAM_HELP}\n`)
	.exitOverride();
registerSetupCommand(program);
registerInitCommand(program);
registerIndexCommand(program);
registerSearchCommand(program);
registerStructureCommand(program);
registerArchitectureCommand(program);
registerContextCommand(program);
registerContextPackCommand(program);
registerExplainCommand(program);
registerDepsCommand(program);
registerUninstallCommand(program);

try {
	program.parse();
} catch (error: unknown) {
	if (!isHandledCommanderExit(error)) {
		throw error;
	}
}

checkForUpdates().catch(() => {});
