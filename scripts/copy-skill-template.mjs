import { mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const sourcePath = path.join(rootDir, "src", "cli", "commands", "skill-template.md");
const targetDir = path.join(rootDir, "dist", "cli", "commands");
const targetPath = path.join(targetDir, "skill-template.md");

await mkdir(targetDir, { recursive: true });
await copyFile(sourcePath, targetPath);
