import path from 'node:path';
import type {
  DependencyRecord,
  FileRecord,
  MetadataStore,
  ProjectId,
  SnapshotId,
} from '../core/types.js';
import type { LanguagePlugin } from '../languages/plugin.js';

interface DirectoryNode {
  name: string;
  path: string;
  type: 'directory';
  children: (DirectoryNode | FileNode)[];
}

interface FileNode {
  name: string;
  path: string;
  type: 'file';
  size: number;
  language: string;
}

export class ArchitectureGenerator {
  constructor(
    private metadataStore: MetadataStore,
    private languagePlugins: LanguagePlugin[] = []
  ) {}

  async generate(projectId: ProjectId, snapshotId: SnapshotId): Promise<void> {
    const files = await this.metadataStore.listFiles(projectId, snapshotId);
    const dependencies = await this.buildDependencies(projectId, snapshotId, files);
    const structure = this.buildDirectoryTree(files);
    const file_stats = this.calculateFileStats(files);
    const entrypoints = this.findEntrypoints(files);

    await this.metadataStore.upsertArtifact(projectId, {
      snapshotId,
      projectId,
      artifactType: 'architecture_snapshot',
      scope: 'project',
      dataJson: JSON.stringify({
        structure,
        entrypoints,
        dependencies: dependencies.summary,
        dependency_map: dependencies.detail,
        file_stats,
      }),
    });
  }

  private buildDirectoryTree(files: FileRecord[]): DirectoryNode {
    const root: DirectoryNode = {
      name: 'root',
      path: '.',
      type: 'directory',
      children: [],
    };

    const map = new Map<string, DirectoryNode>([['.', root]]);

    for (const file of files) {
      const parts = file.path.split('/');
      let currentPath = '.';

      for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        const parentPath = currentPath;
        currentPath = currentPath === '.' ? part : `${currentPath}/${part}`;

        if (!map.has(currentPath)) {
          const node: DirectoryNode = {
            name: part,
            path: currentPath,
            type: 'directory',
            children: [],
          };
          map.set(currentPath, node);
          map.get(parentPath)?.children.push(node);
        }
      }

      const fileName = parts[parts.length - 1];
      const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
      map.get(parentPath)?.children.push({
        name: fileName,
        path: file.path,
        type: 'file',
        size: file.size,
        language: file.languageId,
      });
    }

    return root;
  }

  private calculateFileStats(files: FileRecord[]): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const file of files) {
      const language = file.languageId || 'unknown';
      stats[language] = (stats[language] || 0) + 1;
    }
    return stats;
  }

  private findEntrypoints(files: FileRecord[]): string[] {
    const entrypoints: string[] = [];

    for (const plugin of this.languagePlugins) {
      if (!plugin.getEntrypoints) {
        continue;
      }

      const extensions = new Set(plugin.fileExtensions.map((ext) => ext.toLowerCase()));
      const pluginFiles = files
        .filter((file) => !this.isTestPath(file.path))
        .filter((file) => extensions.has(path.extname(file.path).toLowerCase()))
        .map((file) => file.path);

      if (pluginFiles.length === 0) {
        continue;
      }

      entrypoints.push(...plugin.getEntrypoints(pluginFiles));
    }

    return this.dedupePreserveOrder(entrypoints);
  }

  private dedupePreserveOrder(paths: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const value of paths) {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      result.push(value);
    }

    return result;
  }

  private async buildDependencies(
    projectId: ProjectId,
    snapshotId: SnapshotId,
    files: FileRecord[]
  ): Promise<{
    summary: Record<string, number>;
    detail: {
      internal: Record<string, string[]>;
      external: Record<string, string[]>;
      builtin: Record<string, string[]>;
      unresolved: Record<string, string[]>;
    };
  }> {
    const dependencies = await this.metadataStore.listDependencies(projectId, snapshotId);
    const fileSet = new Set(files.map((file) => this.normalizePath(file.path)));
    const buckets = {
      internal: new Map<string, Set<string>>(),
      external: new Map<string, Set<string>>(),
      builtin: new Map<string, Set<string>>(),
      unresolved: new Map<string, Set<string>>(),
    };

    const add = (bucket: keyof typeof buckets, from: string, to: string) => {
      if (!to) return;
      if (!buckets[bucket].has(from)) {
        buckets[bucket].set(from, new Set());
      }
      buckets[bucket].get(from)?.add(to);
    };

    for (const dependency of dependencies) {
      this.addDependencyToBuckets(dependency, fileSet, add);
    }

    const detail = {
      internal: this.mapToSortedRecord(buckets.internal),
      external: this.mapToSortedRecord(buckets.external),
      builtin: this.mapToSortedRecord(buckets.builtin),
      unresolved: this.mapToSortedRecord(buckets.unresolved),
    };

    return {
      summary: this.summarizeDependencies(detail),
      detail,
    };
  }

  private addDependencyToBuckets(
    dependency: DependencyRecord,
    fileSet: Set<string>,
    add: (
      bucket: 'internal' | 'external' | 'builtin' | 'unresolved',
      from: string,
      to: string
    ) => void
  ): void {
    const fromPath = this.normalizePath(dependency.fromPath);
    const fromModule = this.getModuleKey(fromPath);
    const dependencyType = dependency.dependencyType ?? 'unresolved';

    if (dependencyType === 'internal' && dependency.toPath) {
      const toPath = this.normalizePath(dependency.toPath);
      const toModule = this.getModuleKey(this.canonicalizePath(toPath, fileSet));
      if (toModule && toModule !== fromModule) {
        add('internal', fromModule, toModule);
      }
      return;
    }

    const target = dependency.toSpecifier || dependency.toPath;
    if (!target) {
      return;
    }

    if (dependencyType === 'external') {
      add('external', fromModule, target);
    } else if (dependencyType === 'builtin') {
      add('builtin', fromModule, target);
    } else {
      add('unresolved', fromModule, target);
    }
  }

  private summarizeDependencies(detail: {
    internal: Record<string, string[]>;
    external: Record<string, string[]>;
    builtin: Record<string, string[]>;
    unresolved: Record<string, string[]>;
  }): Record<string, number> {
    const summary = new Map<string, number>();
    const bump = (name: string) => summary.set(name, (summary.get(name) || 0) + 1);

    for (const bucket of Object.values(detail)) {
      for (const deps of Object.values(bucket)) {
        for (const dep of new Set(deps)) {
          bump(dep);
        }
      }
    }

    return Object.fromEntries(
      Array.from(summary.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    );
  }

  private mapToSortedRecord(map: Map<string, Set<string>>): Record<string, string[]> {
    const entries = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return Object.fromEntries(entries.map(([key, values]) => [key, Array.from(values).sort()]));
  }

  private normalizePath(value: string): string {
    return value.replace(/\\/g, '/');
  }

  private canonicalizePath(value: string, fileSet: Set<string>): string {
    const normalized = this.normalizePath(value);
    if (!normalized.includes('/dist/')) return normalized;
    if (!normalized.endsWith('.js') && !normalized.endsWith('.jsx')) return normalized;

    const tsCandidate = normalized.replace('/dist/', '/src/').replace(/\.jsx?$/, '.ts');
    if (fileSet.has(tsCandidate)) return tsCandidate;

    const tsxCandidate = tsCandidate.replace(/\.ts$/, '.tsx');
    if (fileSet.has(tsxCandidate)) return tsxCandidate;

    return normalized;
  }

  private getModuleKey(filePath: string): string {
    const parts = this.normalizePath(filePath).split('/');
    if (parts.length === 1) return 'root';

    const rootGroup = parts[0];
    if (['packages', 'services', 'apps', 'libs', 'modules'].includes(rootGroup) && parts[1]) {
      return `${rootGroup}/${parts[1]}`;
    }

    return rootGroup;
  }

  private isTestPath(filePath: string): boolean {
    const normalized = this.normalizePath(filePath).toLowerCase();
    if (normalized.includes('/__tests__/')) return true;
    if (normalized.includes('/__test__/')) return true;
    if (normalized.includes('/tests/')) return true;
    if (normalized.includes('/test/')) return true;
    if (normalized.includes('/fixtures/')) return true;
    return /(\.|\/)(spec|test)\.[^/]+$/.test(normalized);
  }
}
