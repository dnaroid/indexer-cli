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

type GDScriptAst = {
  source: string;
  lines: string[];
};

export class GDScriptPlugin implements LanguagePlugin {
  readonly id = 'gdscript';
  readonly displayName = 'GDScript';
  readonly fileExtensions = ['.gd'];
  readonly frameworks = ['godot'];

  parse(file: SourceFile): ParsedFile {
    return {
      languageId: this.id,
      path: file.path,
      ast: {
        source: file.content,
        lines: file.content.split(/\r?\n/),
      } satisfies GDScriptAst,
    };
  }

  getEntrypoints(filePaths: string[]): string[] {
    return filePaths
      .filter((filePath) => /(^|\/)(main|Main|game|Game)\.gd$/i.test(filePath))
      .slice(0, 20);
  }

  extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
    const ast = parsed.ast as GDScriptAst;
    const symbols: LanguageSymbol[] = [];

    for (let index = 0; index < ast.lines.length; index += 1) {
      const line = ast.lines[index];
      const classMatch = line.match(/^\s*(?:class_name|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (classMatch) {
        symbols.push(this.makeSymbol(parsed.path, 'class', classMatch[1], index + 1, line, true));
        continue;
      }

      const signalMatch = line.match(/^\s*signal\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (signalMatch) {
        symbols.push(this.makeSymbol(parsed.path, 'signal', signalMatch[1], index + 1, line, true));
        continue;
      }

      const fnMatch = line.match(/^\s*(?:static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (fnMatch) {
        const name = fnMatch[1];
        symbols.push(
          this.makeSymbol(parsed.path, 'function', name, index + 1, line, !name.startsWith('_'))
        );
      }
    }

    return symbols;
  }

  extractImports(parsed: ParsedFile): LanguageImport[] {
    const ast = parsed.ast as GDScriptAst;
    const imports: LanguageImport[] = [];

    for (let index = 0; index < ast.lines.length; index += 1) {
      const line = ast.lines[index];
      const extendsMatch = line.trim().match(/^extends\s+(.+)$/);
      if (extendsMatch) {
        const spec = this.stripQuotes(extendsMatch[1].trim());
        imports.push(this.makeImport(parsed.path, 'import', spec, index + 1, line));
      }

      const preloadMatch = line.match(/preload\(\s*["']([^"']+)["']\s*\)/);
      if (preloadMatch) {
        imports.push(
          this.makeImport(parsed.path, 'asset_reference', preloadMatch[1], index + 1, line)
        );
      }
    }

    return imports;
  }

  splitIntoChunks(_parsed: ParsedFile, _opts: ChunkOptions): LanguageCodeChunk[] {
    return [];
  }

  private stripQuotes(value: string): string {
    return value.replace(/^["']|["']$/g, '');
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

  private makeImport(
    filePath: string,
    kind: 'import' | 'asset_reference',
    spec: string,
    line: number,
    text: string
  ): LanguageImport {
    return {
      id: `${filePath}:${kind}:${spec}:${line}`,
      kind,
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
