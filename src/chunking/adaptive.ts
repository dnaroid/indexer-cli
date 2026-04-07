export interface AdaptiveChunk {
  content: string;
  startLine: number;
  endLine: number;
  type?: string;
  primarySymbol?: string;
}

export interface AdaptiveChunkContext {
  filePath: string;
  content: string;
  language: string;
}

export class AdaptiveChunker {
  chunk(context: AdaptiveChunkContext): AdaptiveChunk[] {
    const lines = context.content.split(/\r?\n/);
    if (lines.length === 0 || context.content.trim().length === 0) {
      return [];
    }

    if (lines.length <= 220) {
      return [
        {
          content: context.content.trim(),
          startLine: 1,
          endLine: lines.length,
          type: 'full_file',
        },
      ];
    }

    const chunks: AdaptiveChunk[] = [];
    const chunkSize = context.language === 'typescript' ? 180 : 220;
    const overlap = 20;

    for (let start = 0; start < lines.length; start += chunkSize - overlap) {
      const endExclusive = Math.min(lines.length, start + chunkSize);
      const content = lines.slice(start, endExclusive).join('\n').trim();
      if (!content) {
        continue;
      }

      chunks.push({
        content,
        startLine: start + 1,
        endLine: endExclusive,
        type: chunks.length === 0 ? 'module_section' : 'impl',
      });

      if (endExclusive >= lines.length) {
        break;
      }
    }

    return chunks;
  }
}
