import { execSync } from 'node:child_process';
import type { GitDiff, GitOperations } from '../core/types.js';

function runGit(repoRoot: string, args: string[]): string {
  return execSync(`git ${args.join(' ')}`, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export class SimpleGitOperations implements GitOperations {
  async getHeadCommit(repoRoot: string): Promise<string | null> {
    try {
      const commit = runGit(repoRoot, ['rev-parse', 'HEAD']);
      return commit.length > 0 ? commit : null;
    } catch {
      return null;
    }
  }

  async isDirty(repoRoot: string): Promise<boolean> {
    try {
      return runGit(repoRoot, ['status', '--porcelain']).length > 0;
    } catch {
      return false;
    }
  }

  async getChangedFiles(repoRoot: string, sinceCommit: string): Promise<GitDiff> {
    try {
      const output = runGit(repoRoot, ['diff', '--name-status', `${sinceCommit}..HEAD`]);
      const diff: GitDiff = {
        added: [],
        modified: [],
        deleted: [],
      };

      if (!output) {
        return diff;
      }

      for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const [status, ...rest] = trimmed.split(/\s+/);
        const filePath = normalizePath(rest[rest.length - 1] ?? '');
        if (!filePath) continue;

        if (status.startsWith('A')) {
          diff.added.push(filePath);
        } else if (status.startsWith('D')) {
          diff.deleted.push(filePath);
        } else {
          diff.modified.push(filePath);
        }
      }

      return diff;
    } catch {
      return { added: [], modified: [], deleted: [] };
    }
  }

  async getChurnByFile(
    repoRoot: string,
    options?: { sinceDays?: number }
  ): Promise<Record<string, number>> {
    const sinceDays = Math.max(1, options?.sinceDays ?? 30);

    try {
      const output = runGit(repoRoot, [
        'log',
        `--since=${JSON.stringify(`${sinceDays} days ago`)}`,
        '--numstat',
        '--format=',
      ]);

      const churn: Record<string, number> = {};
      if (!output) {
        return churn;
      }

      for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const match = trimmed.match(/^(\S+)\s+(\S+)\s+(.+)$/);
        if (!match) continue;

        const added = match[1] === '-' ? 0 : Number.parseInt(match[1], 10) || 0;
        const removed = match[2] === '-' ? 0 : Number.parseInt(match[2], 10) || 0;
        const filePath = normalizePath(match[3]);
        churn[filePath] = (churn[filePath] ?? 0) + added + removed;
      }

      return churn;
    } catch {
      return {};
    }
  }
}
