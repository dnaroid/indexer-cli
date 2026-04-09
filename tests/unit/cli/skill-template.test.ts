import {readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {describe, expect, it} from "vitest"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const templatePath = path.resolve(
  __dirname,
  "../../../src/cli/commands/skill-template.md",
)

function readTemplate(): string {
  return readFileSync(templatePath, "utf8")
}

describe("repo-discovery skill template", () => {
  it("keeps strong frontmatter wording for auto-pick heuristics", () => {
    const template = readTemplate()

    expect(template).toContain("name: repo-discovery")
    expect(template).toContain(
      "description: Mandatory for repository discovery. Before grep/glob/find, first use indexer-cli whenever the task involves finding implementations, tracing behavior, locating symbols, identifying entry points, inspecting module structure, understanding how some part of this repo works, or exploring an unfamiliar area of this repo.",
    )
  })

  it("includes explicit auto-load guidance and trigger phrases", () => {
    const template = readTemplate()

    expect(template).toContain(
      "Use this skill for repository discovery tasks inside this repository.",
    )
    expect(template).toContain(
      "Load this skill automatically when the user asks to find, trace, inspect, understand, or map code in this repo.",
    )
    expect(template).toContain("## Auto-load triggers")
    expect(template).toContain(
      "- Understand how some part of this repository works",
    )
    expect(template).toContain(
      "- Map entry points, dependencies, callers, or imports",
    )
  })

  it("covers all README commands in a compact command map", () => {
    const template = readTemplate()

    expect(template).toContain("## Command map")
    expect(template).toContain("Discovery:")
    expect(template).toContain("`npx indexer-cli search \"<query>\"`")
    expect(template).toContain("`npx indexer-cli structure")
    expect(template).toContain("`npx indexer-cli architecture")
    expect(template).toContain("`npx indexer-cli context`")
    expect(template).toContain("`npx indexer-cli explain <symbol>`")
    expect(template).toContain("`npx indexer-cli deps <path>`")
    expect(template).toContain("`--txt`")
    expect(template).not.toContain("--json")
    expect(template).toContain("`--direction`")
    expect(template).toContain("`--scope`")
    expect(template).not.toContain("`npx indexer-cli setup`")
    expect(template).not.toContain("`npx indexer-cli init`")
    expect(template).not.toContain("`npx indexer-cli uninstall [-f]`")
  })
})
