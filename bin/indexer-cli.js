#!/usr/bin/env node
const { execSync } = require("child_process");
const { resolve } = require("path");

const entry = resolve(__dirname, "..", "src/cli/entry.ts");
const args = process.argv
	.slice(2)
	.map((a) => `"${a.replace(/"/g, '\\"')}"`)
	.join(" ");
try {
	execSync(`tsx "${entry}" ${args}`, { stdio: "inherit", env: process.env });
} catch (e) {
	process.exitCode = e.status ?? 1;
}
