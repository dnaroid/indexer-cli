import path from 'node:path';
import type { Command } from 'commander';
import { setLogLevel } from '../../core/logger.js';
import type { Project } from '../../core/types.js';
import { SqliteMetadataStore } from '../../storage/sqlite.js';

type CliColors = {
  green(text: string): string;
  red(text: string): string;
  gray(text: string): string;
};

async function loadChalk(): Promise<CliColors> {
  return (await import('chalk')).default as unknown as CliColors;
}

type ArchitectureSnapshot = {
  file_stats?: Record<string, number>;
  entrypoints?: string[];
  dependency_map?: {
    internal?: Record<string, string[]>;
    external?: Record<string, string[]>;
    builtin?: Record<string, string[]>;
    unresolved?: Record<string, string[]>;
  };
  dependencies?: Record<string, number>;
};

async function loadProject(metadata: SqliteMetadataStore, repoRoot: string): Promise<Project> {
  const project = (await metadata.listProjects()).find(
    (entry) => path.resolve(entry.workdir) === repoRoot || path.resolve(entry.repoRoot) === repoRoot
  );

  if (!project) {
    throw new Error('Project not initialized. Run `indexer init` first.');
  }

  return project;
}

function printRecord(title: string, values: Record<string, number>, chalk: CliColors): void {
  console.log(chalk.green(title));
  const entries = Object.entries(values).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    console.log(chalk.gray('  none'));
    return;
  }
  for (const [key, value] of entries) {
    console.log(`  ${key}: ${value}`);
  }
}

function printList(title: string, values: string[], chalk: CliColors): void {
  console.log(chalk.green(title));
  if (values.length === 0) {
    console.log(chalk.gray('  none'));
    return;
  }
  for (const value of values) {
    console.log(`  ${value}`);
  }
}

function printDependencyGraph(
  title: string,
  values: Record<string, string[]>,
  chalk: CliColors
): void {
  console.log(chalk.green(title));
  const entries = Object.entries(values).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    console.log(chalk.gray('  none'));
    return;
  }
  for (const [from, to] of entries) {
    console.log(`  ${from} -> ${to.join(', ')}`);
  }
}

function summarizeExternalDependencies(values: Record<string, string[]>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const dependencies of Object.values(values)) {
    for (const dependency of dependencies) {
      counts.set(dependency, (counts.get(dependency) ?? 0) + 1);
    }
  }
  return Object.fromEntries(Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0])));
}

export function registerArchitectureCommand(program: Command): void {
  program
    .command('architecture [projectPath]')
    .description('Print the latest architecture snapshot')
    .action(async (projectPath?: string) => {
      const chalk = await loadChalk();
      const resolvedProjectPath = path.resolve(process.cwd(), projectPath || '.');
      const dataDir = path.join(resolvedProjectPath, '.indexer-cli');
      const dbPath = path.join(dataDir, 'db.sqlite');

      setLogLevel('error');

      const metadata = new SqliteMetadataStore(dbPath);

      try {
        await metadata.initialize();
        const project = await loadProject(metadata, resolvedProjectPath);
        const snapshot = await metadata.getLatestCompletedSnapshot(project.id);

        if (!snapshot) {
          console.log('Run `indexer index` first');
          return;
        }

        const artifact = await metadata.getArtifact(
          project.id,
          snapshot.id,
          'architecture_snapshot',
          'project'
        );

        if (!artifact) {
          console.log('Run `indexer index` first');
          return;
        }

        const architecture = JSON.parse(artifact.dataJson) as ArchitectureSnapshot;
        printRecord('File stats by language', architecture.file_stats ?? {}, chalk);
        printList('Entrypoints', architecture.entrypoints ?? [], chalk);
        printDependencyGraph(
          'Module dependency graph',
          architecture.dependency_map?.internal ?? {},
          chalk
        );
        printRecord(
          'External dependencies summary',
          summarizeExternalDependencies(architecture.dependency_map?.external ?? {}),
          chalk
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Architecture command failed: ${message}`));
        process.exitCode = 1;
      } finally {
        await metadata.close().catch(() => undefined);
      }
    });
}
