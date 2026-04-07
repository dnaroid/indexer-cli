import { program } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerIndexCommand } from "./commands/index.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerStructureCommand } from "./commands/structure.js";
import { registerArchitectureCommand } from "./commands/architecture.js";
import { registerUninstallCommand } from "./commands/uninstall.js";
import { registerSetupCommand } from "./commands/setup.js";

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
} catch (e: any) {
	if (e?.code !== "commander.helpDisplayed" && e?.code !== "commander.help")
		throw e;
}
