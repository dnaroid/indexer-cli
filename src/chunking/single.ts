import type { Chunk, ChunkingContext, ChunkingStrategy } from './types.js';

export class SingleFileChunker implements ChunkingStrategy {
  chunk(context: ChunkingContext): Chunk[] {
    const lines = context.content.split('\n');
    return [
      {
        content: context.content,
        startLine: 0,
        endLine: lines.length,
        type: 'full_file',
        symbols: [],
      },
    ];
  }
}
