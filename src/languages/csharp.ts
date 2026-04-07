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

type CSharpAst = {
  source: string;
  lines: string[];
};

export class CSharpPlugin implements LanguagePlugin {
  readonly id = 'csharp';
  readonly displayName = 'C#';
  readonly fileExtensions = ['.cs'];
  readonly frameworks = ['unity'];

  parse(file: SourceFile): ParsedFile {
    return {
      languageId: this.id,
      path: file.path,
      ast: {
        source: file.content,
        lines: file.content.split(/\r?\n/),
      } satisfies CSharpAst,
    };
  }

  getEntrypoints(filePaths: string[]): string[] {
    return filePaths
      .filter((filePath) => /(^|\/)(Program|Startup|App)\.cs$/i.test(filePath))
      .slice(0, 20);
  }

  extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
    const ast = parsed.ast as CSharpAst;
    const symbols: LanguageSymbol[] = [];
    let currentClass: string | undefined;
    let braceDepth = 0;
    let classBraceDepth = 0;

    for (let index = 0; index < ast.lines.length; index += 1) {
      const line = ast.lines[index];
      const classMatch = line.match(
        /\b(class|interface|enum|struct|record)\s+([A-Za-z_][A-Za-z0-9_]*)/
      );
      if (classMatch) {
        currentClass = classMatch[2];
        classBraceDepth = braceDepth + (line.includes('{') ? 1 : 0);
        symbols.push(
          this.makeSymbol(
            parsed.path,
            'class',
            currentClass,
            index + 1,
            line,
            this.isExported(line)
          )
        );
      } else {
        const methodMatch = line.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*(?:\{|=>)/);
        if (
          methodMatch &&
          !/\b(if|for|foreach|while|switch|catch|using|return|new)\b/.test(line) &&
          currentClass
        ) {
          const name = methodMatch[1];
          symbols.push({
            ...this.makeSymbol(parsed.path, 'method', name, index + 1, line, this.isExported(line)),
            containerName: currentClass,
          });
        }
      }

      braceDepth += (line.match(/\{/g) ?? []).length;
      braceDepth -= (line.match(/\}/g) ?? []).length;
      if (currentClass && braceDepth < classBraceDepth) {
        currentClass = undefined;
        classBraceDepth = 0;
      }
    }

    return symbols;
  }

  extractImports(parsed: ParsedFile): LanguageImport[] {
    const ast = parsed.ast as CSharpAst;
    const imports: LanguageImport[] = [];

    for (let index = 0; index < ast.lines.length; index += 1) {
      const match = ast.lines[index].trim().match(/^using\s+([^;]+);$/);
      if (!match) {
        continue;
      }
      imports.push(this.makeImport(parsed.path, match[1].trim(), index + 1, ast.lines[index]));
    }

    return imports;
  }

  splitIntoChunks(_parsed: ParsedFile, _opts: ChunkOptions): LanguageCodeChunk[] {
    return [];
  }

  private isExported(line: string): boolean {
    return /\b(public|internal)\b/.test(line);
  }

  private makeSymbol(
    filePath: string,
    kind: string,
    name: string,
    line: number,
    text: string,
    exported: boolean
  ): LanguageSymbol {
    const startCol = Math.max(1, text.indexOf(name) + 1);
    return {
      id: `${filePath}:${kind}:${name}:${line}`,
      kind,
      name,
      filePath,
      range: this.range(line, startCol, name.length),
      exported,
      signature: text.trim(),
    };
  }

  private makeImport(filePath: string, spec: string, line: number, text: string): LanguageImport {
    return {
      id: `${filePath}:using:${spec}:${line}`,
      kind: 'using',
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
