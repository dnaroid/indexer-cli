import {readFileSync} from "node:fs"
import {join} from "node:path"

export const FIXTURES_ROOT = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "projects",
)

export function readFixtureFile(relativePath: string): string {
  const fullPath = join(FIXTURES_ROOT, relativePath)
  return readFileSync(fullPath, "utf-8")
}

export function readFixtureAsSource(relativePath: string) {
  return {
    path: relativePath,
    content: readFixtureFile(relativePath),
  }
}
