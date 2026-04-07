import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SystemLogger } from '../core/logger.js';

const logger = new SystemLogger('gitignore');

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.indexer-cli',
  '.DS_Store',
  '*.pyc',
  '__pycache__',
  '.venv',
  'venv',
  '.env',
  '.idea',
  '.vscode',
  '*.min.js',
  '*.min.css',
  '*.map',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

export interface GitignoreFilter {
  ignores(path: string): boolean;
}

export function parseGitignore(rootDir: string): GitignoreFilter {
  const patterns: string[] = [...DEFAULT_IGNORE_PATTERNS];

  const gitignorePath = join(rootDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, 'utf-8');
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));

      patterns.push(...lines);
    } catch (err) {
      logger.warn('Failed to read .gitignore:', err);
    }
  }

  return {
    ignores(filePath: string): boolean {
      const normalized = filePath.replace(/\\/g, '/');
      const parts = normalized.split('/');

      for (const pattern of patterns) {
        if (pattern.startsWith('!')) continue;

        const cleanPattern = pattern.replace(/\/$/, '');

        if (normalized === cleanPattern || normalized.startsWith(cleanPattern + '/')) {
          return true;
        }

        for (const part of parts) {
          if (matchGlob(cleanPattern, part)) {
            return true;
          }
        }
      }

      return false;
    },
  };
}

function matchGlob(pattern: string, input: string): boolean {
  if (!pattern.includes('*')) {
    return input === pattern;
  }

  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${regexStr}$`).test(input);
  } catch {
    return false;
  }
}
