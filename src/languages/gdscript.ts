import Parser from 'tree-sitter';
import GDScriptLanguage from 'tree-sitter-gdscript';

import type {
  LanguagePlugin,
  SourceFile,
  ParsedFile,
  LanguageSymbol,
  LanguageImport,
  LanguageCodeChunk,
  ChunkOptions,
  CodeRange,
} from './plugin.js';

type GDScriptAst = {
  source: string;
  tree: Parser.Tree;
  frameworkHint: string | null;
};

const GODOT_LIFECYCLE_METHODS = new Set([
  '_enter_tree',
  '_ready',
  '_process',
  '_physics_process',
  '_input',
  '_unhandled_input',
  '_exit_tree',
]);

export class GDScriptPlugin implements LanguagePlugin {
  readonly id = 'gdscript';
  readonly displayName = 'GDScript';
  readonly fileExtensions = ['.gd'];
  readonly frameworks = ['godot'];
  readonly capabilities = {
    frameworkAware: true,
    supportsCustomMetadata: true,
    supportsAssetReferences: true,
    supportsEntryPointDiscovery: true,
  };

  private readonly parser: Parser;

  constructor() {
    this.parser = new Parser();
    const language = GDScriptLanguage as unknown as Parameters<Parser['setLanguage']>[0];
    this.parser.setLanguage(language);
  }

  parse(file: SourceFile): ParsedFile {
    const tree = this.parser.parse(file.content);
    const frameworkHint = this.detectFramework(file.content);

    const ast: GDScriptAst = {
      source: file.content,
      tree,
      frameworkHint,
    };

    return {
      languageId: 'gdscript',
      path: file.path,
      ast,
      meta: {
        frameworkHint,
      },
    };
  }

  extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
    const ast = parsed.ast as GDScriptAst;
    const symbols: LanguageSymbol[] = [];
    const lines = ast.source.split(/\r?\n/);

    this.walk(ast.tree.rootNode, (node) => {
      if (node.type === 'class_name_statement' || node.type === 'class_definition') {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) {
          return;
        }

        const name = this.nodeText(ast.source, nameNode);
        const signature = this.firstLine(this.nodeText(ast.source, node));
        symbols.push({
          id: `${parsed.path}:class:${name}:${nameNode.startPosition.row + 1}`,
          kind: 'class',
          name,
          filePath: parsed.path,
          range: this.rangeFromNode(nameNode),
          exported: !name.startsWith('_'),
          signature,
          metadata: {
            framework: 'godot',
            globalClass: node.type === 'class_name_statement',
          },
        });
        return;
      }

      if (node.type === 'signal_statement') {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) {
          return;
        }

        const name = this.nodeText(ast.source, nameNode);
        symbols.push({
          id: `${parsed.path}:signal:${name}:${nameNode.startPosition.row + 1}`,
          kind: 'signal',
          name,
          filePath: parsed.path,
          range: this.rangeFromNode(nameNode),
          exported: true,
          signature: this.firstLine(this.nodeText(ast.source, node)),
          metadata: {
            framework: 'godot',
          },
        });
        return;
      }

      if (node.type === 'function_definition') {
        const nameNode = node.childForFieldName('name');
        const signature = this.firstLine(this.nodeText(ast.source, node));
        const container = this.findAncestor(node, 'class_definition');
        const containerName = container
          ? this.nodeText(ast.source, container.childForFieldName('name') ?? container)
          : undefined;

        const name = nameNode
          ? this.nodeText(ast.source, nameNode)
          : this.extractFunctionNameFromSignature(signature);
        if (!name) {
          return;
        }

        const range = nameNode
          ? this.rangeFromNode(nameNode)
          : this.rangeForToken(lines, node.startPosition.row, name, node);

        symbols.push({
          id: `${parsed.path}:function:${name}:${node.startPosition.row + 1}`,
          kind: container ? 'method' : 'function',
          name,
          filePath: parsed.path,
          range,
          exported: !name.startsWith('_'),
          containerName,
          signature,
          metadata: {
            framework: 'godot',
            lifecycle: GODOT_LIFECYCLE_METHODS.has(name),
          },
        });
      }
    });

    return symbols;
  }

  extractImports(parsed: ParsedFile): LanguageImport[] {
    const ast = parsed.ast as GDScriptAst;
    const imports: LanguageImport[] = [];
    const lines = ast.source.split(/\r?\n/);

    this.walk(ast.tree.rootNode, (node) => {
      if (node.type === 'extends_statement') {
        const specNode = node.namedChildren[0];
        if (!specNode) {
          return;
        }

        const spec = this.stripQuotes(this.nodeText(ast.source, specNode).trim());
        imports.push({
          id: `${parsed.path}:extends:${spec}:${node.startPosition.row + 1}`,
          kind: 'import',
          spec,
          filePath: parsed.path,
          range: this.rangeForToken(lines, node.startPosition.row, spec, node),
          metadata: {
            syntax: 'extends',
          },
        });
        return;
      }

      if (
        node.type !== 'const_statement' &&
        node.type !== 'variable_statement' &&
        node.type !== 'export_variable_statement' &&
        node.type !== 'onready_variable_statement'
      ) {
        return;
      }

      const statement = this.nodeText(ast.source, node);
      const preloadMatch = statement.match(
        /(?:const|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:=]?.*=\s*preload\(\s*["']([^"']+)["']\s*\)/
      );
      if (!preloadMatch) {
        return;
      }

      const alias = preloadMatch[1];
      const spec = preloadMatch[2];

      imports.push({
        id: `${parsed.path}:asset:${alias}:${node.startPosition.row + 1}`,
        kind: 'asset_reference',
        spec,
        filePath: parsed.path,
        range: this.rangeForToken(lines, node.startPosition.row, spec, node),
        metadata: {
          alias,
          syntax: 'preload',
        },
      });
    });

    return imports;
  }

  splitIntoChunks(parsed: ParsedFile, opts: ChunkOptions): LanguageCodeChunk[] {
    const ast = parsed.ast as GDScriptAst;
    const content = ast.source;
    if (!content.trim()) {
      return [];
    }

    const lines = content.split(/\r?\n/);
    const chunks: LanguageCodeChunk[] = [];
    const importNodes: Parser.SyntaxNode[] = [];
    const definitionNodes: Array<{
      node: Parser.SyntaxNode;
      chunkType: 'types' | 'impl';
      primarySymbol?: string;
    }> = [];

    this.walk(ast.tree.rootNode, (node) => {
      if (node.type === 'extends_statement') {
        importNodes.push(node);
        return;
      }

      if (node.type === 'class_name_statement') {
        importNodes.push(node);
        const nameNode = node.childForFieldName('name');
        const primarySymbol = nameNode ? this.nodeText(content, nameNode) : undefined;
        definitionNodes.push({
          node,
          chunkType: 'types',
          primarySymbol,
        });
        return;
      }

      if (node.type === 'class_definition') {
        const nameNode = node.childForFieldName('name');
        const primarySymbol = nameNode ? this.nodeText(content, nameNode) : undefined;
        definitionNodes.push({
          node,
          chunkType: 'types',
          primarySymbol,
        });
        return;
      }

      if (node.type === 'signal_statement') {
        const nameNode = node.childForFieldName('name');
        const primarySymbol = nameNode ? this.nodeText(content, nameNode) : undefined;
        definitionNodes.push({
          node,
          chunkType: 'impl',
          primarySymbol,
        });
        return;
      }

      if (node.type === 'function_definition') {
        const nameNode = node.childForFieldName('name');
        const primarySymbol = nameNode
          ? this.nodeText(content, nameNode)
          : this.extractFunctionNameFromSignature(this.firstLine(this.nodeText(content, node)));
        definitionNodes.push({
          node,
          chunkType: 'impl',
          primarySymbol: primarySymbol ?? undefined,
        });
      }
    });

    if (importNodes.length > 0) {
      const importStart = Math.min(...importNodes.map((node) => node.startPosition.row + 1));
      const importEnd = Math.max(...importNodes.map((node) => node.endPosition.row + 1));
      const importContent = lines
        .slice(importStart - 1, importEnd)
        .join('\n')
        .trim();

      if (importContent) {
        chunks.push({
          id: `${parsed.path}:chunk:imports`,
          filePath: parsed.path,
          range: {
            startLine: importStart,
            startCol: 1,
            endLine: importEnd,
            endCol: (lines[importEnd - 1]?.length ?? 0) + 1,
          },
          content: importContent,
          languageId: 'gdscript',
          estimatedTokens: Math.max(1, Math.ceil(importContent.length / 4)),
          metadata: {
            chunkType: 'imports',
          },
        });
      }
    }

    const sortedDefinitions = definitionNodes.sort(
      (a, b) => a.node.startPosition.row - b.node.startPosition.row
    );
    for (let i = 0; i < sortedDefinitions.length; i += 1) {
      const current = sortedDefinitions[i];
      const next = sortedDefinitions[i + 1];
      const startLine = current.node.startPosition.row + 1;
      const endLine = next ? Math.max(startLine, next.node.startPosition.row) : lines.length;
      const nodeContent = lines
        .slice(startLine - 1, endLine)
        .join('\n')
        .trim();
      if (!nodeContent) continue;

      chunks.push({
        id: `${parsed.path}:chunk:${startLine}`,
        filePath: parsed.path,
        range: {
          startLine,
          startCol: 1,
          endLine,
          endCol: (lines[endLine - 1]?.length ?? 0) + 1,
        },
        content: nodeContent,
        languageId: 'gdscript',
        estimatedTokens: Math.max(1, Math.ceil(nodeContent.length / 4)),
        metadata: {
          chunkType: current.chunkType,
          primarySymbol: current.primarySymbol,
        },
      });
    }

    if (chunks.length > 0) {
      return chunks;
    }

    const range: CodeRange = {
      startLine: 1,
      startCol: 1,
      endLine: lines.length,
      endCol: (lines[lines.length - 1]?.length ?? 0) + 1,
    };

    return [
      {
        id: `${parsed.path}:chunk:1`,
        filePath: parsed.path,
        range,
        content,
        languageId: 'gdscript',
        estimatedTokens: Math.max(opts.targetTokens, Math.ceil(content.length / 4)),
        metadata: {
          chunkStrategy: 'tree-sitter-single-chunk',
          chunkType: 'impl',
        },
      },
    ];
  }

  getEntrypoints(filePaths: string[]): string[] {
    return filePaths.filter((filePath) => {
      const normalized = filePath.replace(/\\/g, '/').toLowerCase();
      return (
        normalized.endsWith('/main.gd') ||
        normalized.endsWith('/bootstrap.gd') ||
        normalized.endsWith('/game_manager.gd')
      );
    });
  }

  private detectFramework(content: string): string | null {
    return /\bextends\b|\bclass_name\b|\b@export\b|\bsignal\b/.test(content) ? 'godot' : null;
  }

  private extractFunctionNameFromSignature(signature: string): string | null {
    const match = signature.match(/func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    return match?.[1] ?? null;
  }

  private stripQuotes(value: string): string {
    return value.replace(/^['"]|['"]$/g, '');
  }

  private findAncestor(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
      if (current.type === type) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  private nodeText(source: string, node: Parser.SyntaxNode): string {
    return source.slice(node.startIndex, node.endIndex);
  }

  private firstLine(value: string): string {
    return value.split(/\r?\n/, 1)[0]?.trim() ?? '';
  }

  private rangeFromNode(node: Parser.SyntaxNode): CodeRange {
    const startCol = node.startPosition.column + 1;
    const endCol = Math.max(startCol + 1, node.endPosition.column + 1);
    return {
      startLine: node.startPosition.row + 1,
      startCol,
      endLine: node.endPosition.row + 1,
      endCol,
    };
  }

  private rangeForToken(
    lines: string[],
    lineIndex: number,
    token: string,
    fallbackNode: Parser.SyntaxNode
  ): CodeRange {
    const line = lines[lineIndex] ?? '';
    const tokenIndex = line.indexOf(token);
    if (tokenIndex < 0) {
      return this.rangeFromNode(fallbackNode);
    }

    return {
      startLine: lineIndex + 1,
      startCol: tokenIndex + 1,
      endLine: lineIndex + 1,
      endCol: tokenIndex + Math.max(2, token.length + 1),
    };
  }

  private walk(node: Parser.SyntaxNode, visitor: (node: Parser.SyntaxNode) => void): void {
    visitor(node);
    for (const child of node.namedChildren) {
      this.walk(child, visitor);
    }
  }
}

export const plugin = new GDScriptPlugin();
export default plugin;
