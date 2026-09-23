// Shared with npm postinstall, which must also work before TypeScript is built.
const bootstrap = require("../../scripts/create-ask-config.cjs") as {
	askConfigPath(env?: NodeJS.ProcessEnv, home?: string): string;
	ensureAskConfig(env?: NodeJS.ProcessEnv, home?: string): string;
	reportAskConfig(env?: NodeJS.ProcessEnv, home?: string): void;
};

export const { askConfigPath, ensureAskConfig, reportAskConfig } = bootstrap;
