import {existsSync, readFileSync} from "node:fs"
import path from "node:path"
import {PACKAGE_VERSION} from "./version.js"
import {performUninstall} from "../cli/commands/uninstall.js"
import {performInit} from "../cli/commands/init.js"

/**
 * Parse a version string into [major, minor, patch].
 * Returns null if the string is not a valid semver-like version.
 */
export function parseSemver(version: string): [number, number, number] | null {
  const parts = version.split(".")
  if (parts.length !== 3) return null
  const [major, minor, patch] = parts.map(Number)
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    return null
  }
  return [major, minor, patch]
}

/**
 * Compare CLI version with config version.
 * If major.minor differs, run uninstall + init to re-sync.
 *
 * @returns true if migration was performed, false otherwise
 */
export async function checkAndMigrateIfNeeded(): Promise<boolean> {
  const projectRoot = process.cwd()
  const configPath = path.join(projectRoot, ".indexer-cli", "config.json")

  if (!existsSync(configPath)) {
    return false
  }

  let configVersion: string
  try {
    const raw = readFileSync(configPath, "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      typeof (parsed as { version: unknown }).version !== "string"
    ) {
      return false
    }
    configVersion = (parsed as { version: string }).version
  } catch {
    return false
  }

  const current = parseSemver(PACKAGE_VERSION)
  const stored = parseSemver(configVersion)

  if (!current || !stored) return false

  // Compare major.minor (release line). Patch changes are skipped.
  if (current[0] === stored[0] && current[1] === stored[1]) {
    return false
  }

  console.log(
    `indexer-cli: version changed (${configVersion} → ${PACKAGE_VERSION}). Re-initializing project data...`,
  )
  console.log("  Removing .indexer-cli/...")

  try {
    await performUninstall(projectRoot)

    console.log("  Re-initializing...")
    await performInit(projectRoot, {skipIndexing: false})

    console.log("indexer-cli: migration complete.")
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`indexer-cli: migration failed: ${message}`)
    console.error(
      "  Run manually: indexer-cli uninstall -f && indexer-cli init",
    )
    process.exitCode = 1
    return false
  }
}
