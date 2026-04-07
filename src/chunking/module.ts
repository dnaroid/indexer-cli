import type { Chunk, ChunkingContext, ChunkingStrategy } from './types.js';

export class ModuleLevelChunker implements ChunkingStrategy {
  private readonly MAX_CHUNK_LINES = 200;
  private readonly OVERLAP_LINES = 20;

  chunk(context: ChunkingContext): Chunk[] {
    const lines = context.content.split('\n');
    const chunks: Chunk[] = [];
    let currentLine = 0;

    while (currentLine < lines.length) {
      const endLine = Math.min(currentLine + this.MAX_CHUNK_LINES, lines.length);
      const chunkLines = lines.slice(currentLine, endLine);

      let content = chunkLines.join('\n');

      if (currentLine > 0) {
        content = `// ...\n${content}`;
      }

      chunks.push({
        content,
        startLine: currentLine,
        endLine,
        type: 'module_section',
        symbols: [],
      });

      if (endLine >= lines.length) break;

      currentLine = endLine - this.OVERLAP_LINES;
    }

    return chunks;
  }
}
