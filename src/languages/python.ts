import Parser from "tree-sitter"
import PythonLanguage from "tree-sitter-python"

import type {
  ChunkOptions,
  CodeRange,
  LanguageCodeChunk,
  LanguageImport,
  LanguagePlugin,
  LanguageSymbol,
  ParsedFile,
  SourceFile,
} from "./plugin.js"

type PythonAst = {
  source: string;
  tree: Parser.Tree;
};

export class PythonPlugin implements LanguagePlugin {
  readonly id = "python"
  readonly displayName = "Python"
  readonly fileExtensions = [".py", ".pyi"]
  readonly frameworks = ["django", "flask", "fastapi"]

  private readonly parser: Parser

  constructor() {
    this.parser = new Parser()
    const language = PythonLanguage as unknown as Parameters<Parser["setLanguage"]>[0]
    this.parser.setLanguage(language)
  }

  parse(file: SourceFile): ParsedFile {
    const tree = this.parser.parse(file.content)
    const ast: PythonAst = {source: file.content, tree}
    const frameworkHint = this.detectFramework(file.content)

    return {
      languageId: "python",
      path: file.path,
      ast,
      meta: {
        languageVersion: "unknown",
        frameworkHint,
      },
    }
  }

  extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
    const ast = parsed.ast as PythonAst
    const symbols: LanguageSymbol[] = []

    this.walk(ast.tree.rootNode, (node) => {
      if (node.type !== "class_definition" && node.type !== "function_definition") {
        return
      }

      const nameNode = node.childForFieldName("name")
      if (!nameNode) {
        return
      }

      const name = this.nodeText(ast.source, nameNode)
      const signature = this.firstLine(this.nodeText(ast.source, node))

      if (node.type === "class_definition") {
        const classText = this.nodeText(ast.source, node)
        const baseClasses = this.extractBaseClasses(classText)

        symbols.push({
          id: `${parsed.path}:class:${name}:${nameNode.startPosition.row + 1}`,
          kind: "class",
          name,
          filePath: parsed.path,
          range: this.rangeFromNode(nameNode),
          exported: !name.startsWith("_"),
          signature,
          metadata: baseClasses.length > 0 ? {baseClasses} : undefined,
        })
        return
      }

      const container = this.findAncestor(node, "class_definition")
      const containerName = container
        ? this.nodeText(ast.source, container.childForFieldName("name") ?? container)
        : undefined

      symbols.push({
        id: `${parsed.path}:function:${name}:${nameNode.startPosition.row + 1}`,
        kind: container ? "method" : "function",
        name,
        filePath: parsed.path,
        range: this.rangeFromNode(nameNode),
        exported: !name.startsWith("_"),
        containerName,
        signature,
      })
    })

    return symbols
  }

  extractImports(parsed: ParsedFile): LanguageImport[] {
    const ast = parsed.ast as PythonAst
    const imports: LanguageImport[] = []
    const lines = ast.source.split(/\r?\n/)

    this.walk(ast.tree.rootNode, (node) => {
      if (node.type !== "import_statement" && node.type !== "import_from_statement") {
        return
      }

      const statement = this.nodeText(ast.source, node).trim()
      if (!statement) {
        return
      }

      if (node.type === "import_statement") {
        const modulePart = statement.replace(/^import\s+/, "")
        const modules = modulePart
          .split(",")
          .map((part) => part.trim().split(/\s+as\s+/)[0])
          .filter(Boolean)

        for (const moduleName of modules) {
          imports.push({
            id: `${parsed.path}:import:${moduleName}:${node.startPosition.row + 1}`,
            kind: "import",
            spec: moduleName,
            filePath: parsed.path,
            range: this.rangeForToken(lines, node.startPosition.row, moduleName, node),
          })
        }
        return
      }

      const fromMatch = statement.match(/^from\s+([A-Za-z0-9_\.]+)\s+import\s+(.+)$/)
      if (!fromMatch) {
        return
      }

      const moduleName = fromMatch[1]
      const imported = fromMatch[2]
        .split(",")
        .map((part) => part.trim().split(/\s+as\s+/)[0])
        .filter(Boolean)

      imports.push({
        id: `${parsed.path}:import:${moduleName}:${node.startPosition.row + 1}`,
        kind: "import",
        spec: moduleName,
        filePath: parsed.path,
        range: this.rangeForToken(lines, node.startPosition.row, moduleName, node),
        metadata: imported.length > 0 ? {imported} : undefined,
      })
    })

    return imports
  }

  splitIntoChunks(parsed: ParsedFile, opts: ChunkOptions): LanguageCodeChunk[] {
    const ast = parsed.ast as PythonAst
    const content = ast.source

    if (!content.trim()) {
      return []
    }

    const lines = content.split(/\r?\n/)
    const importNodes: Parser.SyntaxNode[] = []
    const definitionNodes: Parser.SyntaxNode[] = []

    this.walk(ast.tree.rootNode, (node) => {
      if (node.type === "import_statement" || node.type === "import_from_statement") {
        importNodes.push(node)
      }
      if (node.type === "function_definition" || node.type === "class_definition") {
        definitionNodes.push(node)
      }
    })

    const chunks: LanguageCodeChunk[] = []

    if (importNodes.length > 0) {
      const importStart = Math.min(...importNodes.map((node) => node.startPosition.row + 1))
      const importEnd = Math.max(...importNodes.map((node) => node.endPosition.row + 1))
      const importContent = lines
        .slice(importStart - 1, importEnd)
        .join("\n")
        .trim()
      if (importContent.length > 0) {
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
          languageId: "python",
          estimatedTokens: Math.max(1, Math.ceil(importContent.length / 4)),
          metadata: {
            chunkType: "imports",
          },
        })
      }
    }

    const sortedDefinitions = definitionNodes.sort(
      (a, b) => a.startPosition.row - b.startPosition.row
    )
    for (const node of sortedDefinitions) {
      const nodeContent = this.nodeText(content, node).trim()
      if (!nodeContent) continue
      const range = this.rangeFromNode(node)
      const firstLine = this.firstLine(nodeContent)
      const symbolMatch = firstLine.match(/^(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/)
      chunks.push({
        id: `${parsed.path}:chunk:${range.startLine}`,
        filePath: parsed.path,
        range,
        content: nodeContent,
        languageId: "python",
        estimatedTokens: Math.max(1, Math.ceil(nodeContent.length / 4)),
        metadata: {
          chunkType: node.type === "class_definition" ? "types" : "impl",
          primarySymbol: symbolMatch?.[1],
        },
      })
    }

    if (chunks.length > 0) {
      return chunks
    }

    const range: CodeRange = {
      startLine: 1,
      startCol: 1,
      endLine: lines.length,
      endCol: (lines[lines.length - 1]?.length ?? 0) + 1,
    }

    return [
      {
        id: `${parsed.path}:chunk:1`,
        filePath: parsed.path,
        range,
        content,
        languageId: "python",
        estimatedTokens: Math.max(opts.targetTokens, Math.ceil(content.length / 4)),
        metadata: {
          chunkStrategy: "tree-sitter-single-chunk",
          chunkType: "impl",
        },
      },
    ]
  }

  getEntrypoints(filePaths: string[]): string[] {
    return filePaths.filter(
      (filePath) => filePath.endsWith("__main__.py") || filePath.endsWith("manage.py")
    )
  }

  private detectFramework(content: string): string | null {
    if (content.includes("django")) {
      return "django"
    }
    if (content.includes("fastapi")) {
      return "fastapi"
    }
    if (content.includes("flask")) {
      return "flask"
    }
    return null
  }

  private extractBaseClasses(classText: string): string[] {
    const firstLine = this.firstLine(classText)
    const match = firstLine.match(/^class\s+[A-Za-z_]\w*\s*\(([^)]*)\)\s*:/)
    if (!match) {
      return []
    }

    return match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  }

  private nodeText(source: string, node: Parser.SyntaxNode): string {
    return source.slice(node.startIndex, node.endIndex)
  }

  private firstLine(value: string): string {
    return value.split(/\r?\n/, 1)[0]?.trim() ?? ""
  }

  private findAncestor(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    let current: Parser.SyntaxNode | null = node.parent
    while (current) {
      if (current.type === type) {
        return current
      }
      current = current.parent
    }
    return null
  }

  private rangeFromNode(node: Parser.SyntaxNode): CodeRange {
    const startCol = node.startPosition.column + 1
    const endCol = Math.max(startCol + 1, node.endPosition.column + 1)
    return {
      startLine: node.startPosition.row + 1,
      startCol,
      endLine: node.endPosition.row + 1,
      endCol,
    }
  }

  private rangeForToken(
    lines: string[],
    lineIndex: number,
    token: string,
    fallbackNode: Parser.SyntaxNode
  ): CodeRange {
    const line = lines[lineIndex] ?? ""
    const tokenIndex = line.indexOf(token)
    if (tokenIndex < 0) {
      return this.rangeFromNode(fallbackNode)
    }

    return {
      startLine: lineIndex + 1,
      startCol: tokenIndex + 1,
      endLine: lineIndex + 1,
      endCol: tokenIndex + Math.max(2, token.length + 1),
    }
  }

  private walk(node: Parser.SyntaxNode, visitor: (node: Parser.SyntaxNode) => void): void {
    visitor(node)
    for (const child of node.namedChildren) {
      this.walk(child, visitor)
    }
  }
}

export const plugin = new PythonPlugin()
export default plugin
