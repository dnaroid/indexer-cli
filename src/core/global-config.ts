// Shared with npm postinstall, which must also work before TypeScript is built.
const bootstrap = require("../../scripts/create-idx-config.cjs") as {
	globalConfigPath(env?: NodeJS.ProcessEnv, home?: string): string;
	ensureGlobalConfig(env?: NodeJS.ProcessEnv, home?: string): string;
	reportGlobalConfig(env?: NodeJS.ProcessEnv, home?: string): void;
};

export const { globalConfigPath, ensureGlobalConfig, reportGlobalConfig } = bootstrap;
