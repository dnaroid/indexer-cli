import type {
  ChunkOptions,
  CodeRange,
  LanguageCodeChunk,
  LanguageImport,
  LanguagePlugin,
  LanguageSymbol,
  ParsedFile,
  SourceFile,
} from './plugin.js';

type PythonAst = {
  source: string;
  lines: string[];
};

export class PythonPlugin implements LanguagePlugin {
  readonly id = 'python';
  readonly displayName = 'Python';
  readonly fileExtensions = ['.py', '.pyi'];
  readonly frameworks = ['django', 'flask', 'fastapi'];

  parse(file: SourceFile): ParsedFile {
    return {
      languageId: this.id,
      path: file.path,
      ast: {
        source: file.content,
        lines: file.content.split(/\r?\n/),
      } satisfies PythonAst,
    };
  }

  getEntrypoints(filePaths: string[]): string[] {
    return filePaths
      .filter((filePath) => /(^|\/)(main|app|manage|cli|__main__)\.py$/i.test(filePath))
      .slice(0, 20);
  }

  extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
    const ast = parsed.ast as PythonAst;
    const symbols: LanguageSymbol[] = [];
    const classStack: Array<{ indent: number; name: string }> = [];

    for (let index = 0; index < ast.lines.length; index += 1) {
      const line = ast.lines[index];
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      while (classStack.length > 0 && indent <= classStack[classStack.length - 1].indent) {
        classStack.pop();
      }

      const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (classMatch) {
        const name = classMatch[1];
        classStack.push({ indent, name });
        symbols.push(
          this.makeSymbol(
            parsed.path,
            'class',
            name,
            index + 1,
            line,
            indent,
            !name.startsWith('_')
          )
        );
        continue;
      }

      const fnMatch = line.match(/^\s*(?:async\s+def|def)\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (fnMatch) {
        const name = fnMatch[1];
        const containerName = classStack[classStack.length - 1]?.name;
        symbols.push({
          ...this.makeSymbol(
            parsed.path,
            containerName ? 'method' : 'function',
            name,
            index + 1,
            line,
            indent,
            !name.startsWith('_')
          ),
          containerName,
        });
      }
    }

    return symbols;
  }

  extractImports(parsed: ParsedFile): LanguageImport[] {
    const ast = parsed.ast as PythonAst;
    const imports: LanguageImport[] = [];

    for (let index = 0; index < ast.lines.length; index += 1) {
      const line = ast.lines[index].trim();
      const importMatch = line.match(/^import\s+(.+)$/);
      if (importMatch) {
        const modules = importMatch[1]
          .split(',')
          .map((part) => part.trim().split(/\s+as\s+/)[0])
          .filter(Boolean);
        for (const moduleName of modules) {
          imports.push(this.makeImport(parsed.path, moduleName, index + 1, ast.lines[index]));
        }
        continue;
      }

      const fromMatch = line.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+/);
      if (fromMatch) {
        imports.push(this.makeImport(parsed.path, fromMatch[1], index + 1, ast.lines[index]));
      }
    }

    return imports;
  }

  splitIntoChunks(_parsed: ParsedFile, _opts: ChunkOptions): LanguageCodeChunk[] {
    return [];
  }

  private makeSymbol(
    filePath: string,
    kind: string,
    name: string,
    line: number,
    text: string,
    indent: number,
    exported: boolean
  ): LanguageSymbol {
    const column = indent + text.trimStart().indexOf(name) + 1;
    return {
      id: `${filePath}:${kind}:${name}:${line}`,
      kind,
      name,
      filePath,
      range: this.range(line, column, name.length),
      exported,
      signature: text.trim(),
    };
  }

  private makeImport(filePath: string, spec: string, line: number, text: string): LanguageImport {
    return {
      id: `${filePath}:import:${spec}:${line}`,
      kind: 'import',
      spec,
      filePath,
      range: this.range(line, Math.max(1, text.indexOf(spec) + 1), spec.length),
    };
  }

  private range(line: number, startCol: number, length: number): CodeRange {
    return {
      startLine: line,
      startCol,
      endLine: line,
      endCol: startCol + length,
    };
  }
}
