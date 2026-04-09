import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJsonPath = resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

export const VERSION: string = packageJson.version;
