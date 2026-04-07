import ts from 'typescript';
import type { Chunk, ChunkingContext, ChunkingStrategy } from './types.js';

export class FunctionLevelChunker implements ChunkingStrategy {
  chunk(context: ChunkingContext): Chunk[] {
    const { filePath, content } = context;
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const chunks: Chunk[] = [];
    let importsEndPos = 0;
    let preambleEndPos = 0;

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
        importsEndPos = statement.getEnd();
        preambleEndPos = statement.getEnd();
        continue;
      }

      if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
        preambleEndPos = statement.getEnd();
        continue;
      }

      break;
    }

    if (importsEndPos > 0) {
      const importsContent = content.slice(0, importsEndPos);
      const endLine = sourceFile.getLineAndCharacterOfPosition(importsEndPos).line + 1;

      chunks.push({
        content: importsContent,
        startLine: 0,
        endLine,
        type: 'imports',
        symbols: [],
      });
    }

    if (preambleEndPos > importsEndPos) {
      const preambleStartPos = importsEndPos;
      const preambleContent = content.slice(preambleStartPos, preambleEndPos);
      const startLine = sourceFile.getLineAndCharacterOfPosition(preambleStartPos).line;
      const endLine = sourceFile.getLineAndCharacterOfPosition(preambleEndPos).line + 1;

      chunks.push({
        content: preambleContent,
        startLine,
        endLine,
        type: 'preamble',
        symbols: [],
      });
    }

    sourceFile.forEachChild((node) => {
      if (node.getEnd() <= preambleEndPos) return;

      if (this.isTopLevelDeclaration(node)) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

        const symbol = this.extractSymbol(node);

        chunks.push({
          content: node.getText(),
          startLine: start.line,
          endLine: end.line + 1,
          type: 'declaration',
          primarySymbol: symbol?.name,
          symbols: symbol ? [symbol.name] : [],
        });
      }
    });

    return chunks;
  }

  private isTopLevelDeclaration(node: ts.Node): boolean {
    return (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isVariableStatement(node) ||
      ts.isModuleDeclaration(node)
    );
  }

  private extractSymbol(node: ts.Node): { name: string; kind: string } | null {
    if (ts.isFunctionDeclaration(node) && node.name) {
      return { name: node.name.getText(), kind: 'function' };
    }

    if (ts.isClassDeclaration(node) && node.name) {
      return { name: node.name.getText(), kind: 'class' };
    }

    if (ts.isVariableStatement(node)) {
      const declaration = node.declarationList.declarations[0];
      if (declaration && ts.isIdentifier(declaration.name)) {
        return { name: declaration.name.getText(), kind: 'variable' };
      }
    }

    if (ts.isModuleDeclaration(node) && node.name) {
      return { name: node.name.getText(), kind: 'module' };
    }

    return null;
  }
}
