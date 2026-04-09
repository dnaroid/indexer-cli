import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * SKILL.md template for Claude Code integration.
 *
 * Written to `.claude/skills/repo-discovery/SKILL.md` during `indexer-cli init`.
 */
export const SKILL_MD = readFileSync(
	path.join(__dirname, "skill-template.md"),
	"utf8",
);
