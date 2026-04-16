#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const AUTO_UPDATE_RESTART_CODE = 42;

function resolveTsxCliPath({ existsSyncFn = existsSync } = {}) {
	const fallbackPath = resolve(
		__dirname,
		"..",
		"node_modules",
		"tsx",
		"dist",
		"cli.mjs",
	);
	if (existsSyncFn(fallbackPath)) {
		return fallbackPath;
	}

	try {
		const tsxPackageJson = require.resolve("tsx/package.json", {
			paths: [resolve(__dirname, "..")],
		});
		const tsxCliPath = resolve(dirname(tsxPackageJson), "dist", "cli.mjs");
		if (existsSyncFn(tsxCliPath)) {
			return tsxCliPath;
		}
	} catch {
		return null;
	}

	return null;
}

function buildLaunchSpec({
	argv = process.argv.slice(2),
	existsSyncFn = existsSync,
} = {}) {
	const distEntry = resolve(__dirname, "..", "dist", "cli", "entry.js");
	if (existsSyncFn(distEntry)) {
		return { command: process.execPath, args: [distEntry, ...argv] };
	}

	const tsxCliPath = resolveTsxCliPath({ existsSyncFn });
	if (tsxCliPath) {
		const srcEntry = resolve(__dirname, "..", "src", "cli", "entry.ts");
		return { command: process.execPath, args: [tsxCliPath, srcEntry, ...argv] };
	}

	throw new Error(
		"Unable to start indexer-cli: neither dist/cli/entry.js nor a local tsx runtime was found. Run `npm ci` and `npm run build` in the repository before invoking the CLI.",
	);
}

function main() {
	try {
		require("better-sqlite3");
	} catch {
		console.error(
			[
				"",
				"\u26A0 indexer-cli: native modules could not be loaded.",
				"  This usually means build tools (python3, make, C++ compiler) are missing.",
				"",
				"  Install build tools, then run:",
				"    npm install -g indexer-cli",
				"",
			].join("\n"),
		);
		process.exit(1);
	}

	let env = process.env;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const { command, args } = buildLaunchSpec();
		const result = spawnSync(command, args, {
			stdio: "inherit",
			env,
		});

		if (result.error) {
			throw result.error;
		}

		if (result.status === AUTO_UPDATE_RESTART_CODE && attempt === 0) {
			env = {
				...process.env,
				INDEXER_CLI_AUTO_UPDATE_ATTEMPTED: "1",
			};
			continue;
		}

		if (result.status !== null) {
			process.exit(result.status);
		}

		process.exit(1);
	}

	process.exit(1);
}

module.exports = {
	buildLaunchSpec,
	main,
	resolveTsxCliPath,
};

if (require.main === module) {
	main();
}
