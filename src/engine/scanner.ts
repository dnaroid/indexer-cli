import { readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { parseGitignore } from '../utils/gitignore.js';

export async function scanProjectFiles(
  rootPath: string,
  codeExtensions: string[]
): Promise<string[]> {
  const gitignore = parseGitignore(rootPath);
  const allowed = new Set(codeExtensions.map((ext) => ext.toLowerCase()));
  const files: string[] = [];
  const directories = [rootPath];

  while (directories.length > 0) {
    const currentDir = directories.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relativePath = relative(rootPath, fullPath).replace(/\\/g, '/');

      if (!relativePath || relativePath === '.') {
        continue;
      }

      if (gitignore.ignores(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        directories.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (allowed.has(extname(relativePath).toLowerCase())) {
        files.push(relativePath);
      }
    }
  }

  files.sort((a, b) => a.localeCompare(b));
  return files;
}
