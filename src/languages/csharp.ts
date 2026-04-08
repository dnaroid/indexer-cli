import Parser from "tree-sitter"
import CSharpLanguage from "tree-sitter-c-sharp"

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

type CSharpAst = {
  source: string;
  tree: Parser.Tree;
  frameworkHint: string | null;
};

const UNITY_LIFECYCLE_METHODS = new Set([
  "Awake",
  "Start",
  "Update",
  "FixedUpdate",
  "LateUpdate",
  "OnEnable",
  "OnDisable",
  "OnDestroy",
])

export class CSharpPlugin implements LanguagePlugin {
  readonly id = "csharp"
  readonly displayName = "C#"
  readonly fileExtensions = [".cs"]
  readonly frameworks = ["unity"]

  private readonly parser: Parser

  constructor() {
    this.parser = new Parser()
    const language = CSharpLanguage as unknown as Parameters<Parser["setLanguage"]>[0]
    this.parser.setLanguage(language)
  }

  parse(file: SourceFile): ParsedFile {
    const tree = this.parser.parse(file.content)
    const frameworkHint = this.detectUnity(tree.rootNode, file.content)

    const ast: CSharpAst = {
      source: file.content,
      tree,
      frameworkHint,
    }

    return {
      languageId: "csharp",
      path: file.path,
      ast,
      meta: {
        frameworkHint,
      },
    }
  }

  extractSymbols(parsed: ParsedFile): LanguageSymbol[] {
    const ast = parsed.ast as CSharpAst
    const symbols: LanguageSymbol[] = []
    const isUnity = ast.frameworkHint === "unity"

    this.walk(ast.tree.rootNode, (node) => {
      if (node.type !== "class_declaration" && node.type !== "method_declaration") {
        return
      }

      if (node.type === "class_declaration") {
        const nameNode = node.childForFieldName("name")
        if (!nameNode) {
          return
        }

        const className = this.nodeText(ast.source, nameNode)
        const declarationText = this.firstLine(this.nodeText(ast.source, node))
        const baseTypes = this.extractBaseTypes(declarationText)
        const exported = this.isPublicOrInternal(declarationText)
        const isUnityComponent =
          isUnity &&
          baseTypes.some((base) => base === "MonoBehaviour" || base === "ScriptableObject")

        symbols.push({
          id: `${parsed.path}:class:${className}:${nameNode.startPosition.row + 1}`,
          kind: "class",
          name: className,
          filePath: parsed.path,
          range: this.rangeFromNode(nameNode),
          exported,
          signature: declarationText,
          metadata: {
            framework: isUnity ? "unity" : "csharp",
            baseTypes,
            unityComponent: isUnityComponent,
          },
        })
        return
      }

      const nameNode = node.childForFieldName("name")
      if (!nameNode) {
        return
      }

      const methodName = this.nodeText(ast.source, nameNode)
      const methodText = this.firstLine(this.nodeText(ast.source, node))
      const container = this.findAncestor(node, "class_declaration")
      const containerNameNode = container?.childForFieldName("name")
      const containerName = containerNameNode
        ? this.nodeText(ast.source, containerNameNode)
        : undefined

      symbols.push({
        id: `${parsed.path}:method:${methodName}:${nameNode.startPosition.row + 1}`,
        kind: "method",
        name: methodName,
        filePath: parsed.path,
        range: this.rangeFromNode(nameNode),
        exported: this.isPublicOrInternal(methodText),
        containerName,
        signature: methodText,
        metadata: {
          framework: isUnity ? "unity" : "csharp",
          lifecycle: isUnity && UNITY_LIFECYCLE_METHODS.has(methodName),
        },
      })
    })

    return symbols
  }

  extractImports(parsed: ParsedFile): LanguageImport[] {
    const ast = parsed.ast as CSharpAst
    const imports: LanguageImport[] = []
    const lines = ast.source.split(/\r?\n/)

    this.walk(ast.tree.rootNode, (node) => {
      if (node.type !== "using_directive") {
        return
      }

      const statement = this.nodeText(ast.source, node).trim()
      const match = statement.match(/^using\s+(?:static\s+)?([^;]+);$/)
      if (!match) {
        return
      }

      const spec = match[1].trim()
      imports.push({
        id: `${parsed.path}:using:${spec}:${node.startPosition.row + 1}`,
        kind: "using",
        spec,
        filePath: parsed.path,
        range: this.rangeForToken(lines, node.startPosition.row, spec, node),
      })
    })

    return imports
  }

  splitIntoChunks(parsed: ParsedFile, opts: ChunkOptions): LanguageCodeChunk[] {
    const ast = parsed.ast as CSharpAst
    const content = ast.source

    if (!content.trim()) {
      return []
    }

    const lines = content.split(/\r?\n/)
    const importNodes: Parser.SyntaxNode[] = []
    const declarationNodes: Parser.SyntaxNode[] = []

    this.walk(ast.tree.rootNode, (node) => {
      if (node.type === "using_directive") {
        importNodes.push(node)
      }

      if (
        node.type === "class_declaration" ||
        node.type === "interface_declaration" ||
        node.type === "enum_declaration" ||
        node.type === "struct_declaration" ||
        node.type === "record_declaration" ||
        node.type === "method_declaration" ||
        node.type === "constructor_declaration"
      ) {
        declarationNodes.push(node)
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
          languageId: "csharp",
          estimatedTokens: Math.max(1, Math.ceil(importContent.length / 4)),
          metadata: {
            chunkType: "imports",
          },
        })
      }
    }

    const sortedDeclarations = declarationNodes.sort(
      (a, b) => a.startPosition.row - b.startPosition.row
    )
    for (const node of sortedDeclarations) {
      const nodeContent = this.nodeText(content, node).trim()
      if (!nodeContent) continue
      const range = this.rangeFromNode(node)
      const firstLine = this.firstLine(nodeContent)
      const symbolMatch = firstLine.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|:|\{|$)/)
      const isTypeNode =
        node.type === "interface_declaration" ||
        node.type === "enum_declaration" ||
        node.type === "struct_declaration"
      chunks.push({
        id: `${parsed.path}:chunk:${range.startLine}`,
        filePath: parsed.path,
        range,
        content: nodeContent,
        languageId: "csharp",
        estimatedTokens: Math.max(1, Math.ceil(nodeContent.length / 4)),
        metadata: {
          chunkType: isTypeNode ? "types" : "impl",
          primarySymbol: symbolMatch?.[1],
        },
      })
    }

    if (chunks.length > 0) {
      return chunks
    }

    return [
      {
        id: `${parsed.path}:chunk:1`,
        filePath: parsed.path,
        range: {
          startLine: 1,
          startCol: 1,
          endLine: lines.length,
          endCol: (lines[lines.length - 1]?.length ?? 0) + 1,
        },
        content,
        languageId: "csharp",
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
      (filePath) => filePath.endsWith("GameManager.cs") || filePath.endsWith("Bootstrap.cs")
    )
  }

  private detectUnity(root: Parser.SyntaxNode, source: string): string | null {
    let unityDetected = false
    this.walk(root, (node) => {
      if (unityDetected || node.type !== "using_directive") {
        return
      }

      const statement = this.nodeText(source, node).trim()
      const match = statement.match(/^using\s+(?:static\s+)?([^;]+);$/)
      const spec = match?.[1]?.trim()
      if (spec && (spec === "UnityEngine" || spec.startsWith("UnityEngine."))) {
        unityDetected = true
      }
    })

    return unityDetected ? "unity" : null
  }

  private extractBaseTypes(declarationText: string): string[] {
    const match = declarationText.match(/:\s*([^\{]+)/)
    if (!match) {
      return []
    }

    return match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  }

  private isPublicOrInternal(signature: string): boolean {
    return /\b(public|internal)\b/.test(signature)
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

  private nodeText(source: string, node: Parser.SyntaxNode): string {
    return source.slice(node.startIndex, node.endIndex)
  }

  private firstLine(value: string): string {
    return value.split(/\r?\n/, 1)[0]?.trim() ?? ""
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

export const plugin = new CSharpPlugin()
export default plugin
