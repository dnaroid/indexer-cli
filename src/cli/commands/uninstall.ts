import { constants as fsConstants } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';

type CliColors = {
  green(text: string): string;
  red(text: string): string;
  gray(text: string): string;
};

async function loadChalk(): Promise<CliColors> {
  return (await import('chalk')).default as unknown as CliColors;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall [projectPath]')
    .description('Remove indexer data for a project')
    .action(async (projectPath?: string) => {
      const chalk = await loadChalk();
      const resolvedProjectPath = path.resolve(process.cwd(), projectPath || '.');
      const dataDir = path.join(resolvedProjectPath, '.indexer-cli');

      try {
        if (!(await pathExists(dataDir))) {
          console.log(chalk.gray(`Nothing to remove at ${dataDir}`));
          return;
        }

        const rl = createInterface({ input, output });

        try {
          const answer = await rl.question(`Delete ${dataDir}? [y/N] `);
          if (!/^y(es)?$/i.test(answer.trim())) {
            console.log(chalk.gray('Uninstall cancelled.'));
            return;
          }
        } finally {
          rl.close();
        }

        await rm(dataDir, { recursive: true, force: true });
        console.log(chalk.green(`Removed ${dataDir}`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Uninstall failed: ${message}`));
        process.exitCode = 1;
      }
    });
}
