export const PROJECT_ROOT_COMMAND_HELP =
	"Run this command from the root of the target project. If you are already inside an initialized project, indexer-cli will detect the project root automatically.";

export const PROJECT_ROOT_PROGRAM_HELP = [
	"`init` prefers the root of the target Git project and will auto-detect it when run from a subdirectory.",
	"After `idx init`, project commands (`index`, `search`, `structure`, `architecture`, `explain`, `deps`, `uninstall`) auto-detect the initialized project root when run from a subdirectory.",
	"`setup` and `reinit` can be run from anywhere.",
].join("\n");
