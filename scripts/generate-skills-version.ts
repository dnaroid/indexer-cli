/**
 * Build-time script: computes a deterministic numeric version from all skill
 * templates and writes it to src/core/skills-version.ts as a plain constant.
 *
 * This avoids hashing skill content on every CLI invocation.
 *
 * Usage: tsx scripts/generate-skills-version.ts
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { GENERATED_SKILLS } from "../src/cli/commands/skills.js";

const combined = GENERATED_SKILLS.map((s) => s.content).join("\n---\n");
const hash = createHash("sha256").update(combined).digest("hex");
const version = Number.parseInt(hash.slice(0, 8), 16);

writeFileSync(
	"src/core/skills-version.ts",
	`export const SKILLS_VERSION = ${version};\n`,
	"utf8",
);

console.log(`skills-version: ${version}`);
