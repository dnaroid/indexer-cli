import { program } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerIndexCommand } from "./commands/index.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerStructureCommand } from "./commands/structure.js";
import { registerArchitectureCommand } from "./commands/architecture.js";
import { registerUninstallCommand } from "./commands/uninstall.js";
import { registerSetupCommand } from "./commands/setup.js";

const HANDLED_COMMANDER_EXIT_CODES = new Set([
	"commander.helpDisplayed",
	"commander.help",
	"commander.version",
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
	.description("Lightweight project indexer with semantic search")
	.version("0.1.0")
	.exitOverride();
registerSetupCommand(program);
registerInitCommand(program);
registerIndexCommand(program);
registerSearchCommand(program);
registerStructureCommand(program);
registerArchitectureCommand(program);
registerUninstallCommand(program);

try {
	program.parse();
} catch (error: unknown) {
	if (!isHandledCommanderExit(error)) {
		throw error;
	}
}
