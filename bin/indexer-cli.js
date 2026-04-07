#!/usr/bin/env node
const { execSync } = require("child_process");
const { resolve } = require("path");

const entry = resolve(__dirname, "..", "src/cli/entry.ts");
const args = process.argv.slice(2).join(" ");
execSync(`npx tsx "${entry}" ${args}`, { stdio: "inherit", env: process.env });
