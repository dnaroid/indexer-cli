import {constants as fsConstants} from "node:fs"
import {access, readdir, readFile, rm, writeFile} from "node:fs/promises"
import path from "node:path"
import {stdin as input, stdout as output} from "node:process"
import {createInterface} from "node:readline/promises"
import type {Command} from "commander"
import {PROJECT_ROOT_COMMAND_HELP} from "../help-text.js"

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function isDirEmpty(dirPath: string): Promise<boolean> {
  const entries = await readdir(dirPath)
  return entries.length === 0
}

async function removeClaudeSkill(projectRoot: string): Promise<void> {
  const skillDir = path.join(
    projectRoot,
    ".claude",
    "skills",
    "repo-discovery",
  )
  if (await pathExists(skillDir)) {
    await rm(skillDir, {recursive: true, force: true})
    console.log(`Removed ${skillDir}`)
  }

  const skillsDir = path.join(projectRoot, ".claude", "skills")
  if (await pathExists(skillsDir)) {
    try {
      if (await isDirEmpty(skillsDir)) {
        await rm(skillsDir, {recursive: true, force: true})
      }
    } catch {}
  }

  const claudeDir = path.join(projectRoot, ".claude")
  if (await pathExists(claudeDir)) {
    try {
      if (await isDirEmpty(claudeDir)) {
        await rm(claudeDir, {recursive: true, force: true})
        console.log(`Removed empty ${claudeDir}`)
      }
    } catch {}
  }
}

async function removeFromGitignore(
  projectRoot: string,
  entries: string[],
): Promise<void> {
  const gitignorePath = path.join(projectRoot, ".gitignore")
  if (!(await pathExists(gitignorePath))) return

  const current = await readFile(gitignorePath, "utf8")
  const lines = current.split(/\r?\n/)
  const entrySet = new Set(entries)
  const filtered = lines.filter((line) => !entrySet.has(line.trim()))

  while (filtered.length > 0 && filtered[filtered.length - 1] === "") {
    filtered.pop()
  }
  filtered.push("")

  const nextContent = filtered.join("\n")
  if (nextContent !== current) {
    await writeFile(gitignorePath, nextContent, "utf8")
    console.log(`Updated ${gitignorePath}`)
  }
}

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall")
    .description(
      "Remove indexer data for a project",
    )
    .addHelpText("after", `\n${PROJECT_ROOT_COMMAND_HELP}\n`)
    .option("-f, --force", "Skip confirmation prompt")
    .action(async (options: { force?: boolean }) => {
      const resolvedProjectPath = process.cwd()
      const dataDir = path.join(resolvedProjectPath, ".indexer-cli")

      try {
        if (!(await pathExists(dataDir))) {
          console.log(`Nothing to remove at ${dataDir}`)
          return
        }

        if (!options.force) {
          const rl = createInterface({input, output})

          try {
            const answer = await rl.question(`Delete ${dataDir}? [y/N] `)
            if (!/^y(es)?$/i.test(answer.trim())) {
              console.log("Uninstall cancelled.")
              return
            }
          } finally {
            rl.close()
          }
        }

        await rm(dataDir, {recursive: true, force: true})
        console.log(`Removed ${dataDir}`)

        await removeClaudeSkill(resolvedProjectPath)
        await removeFromGitignore(resolvedProjectPath, [
          ".indexer-cli/",
          ".claude/",
        ])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`Uninstall failed: ${message}`)
        process.exitCode = 1
      }
    })
}
