export type ChunkType =
  | 'full_file'
  | 'imports'
  | 'preamble'
  | 'declaration'
  | 'module_section'
  | 'impl'
  | 'types';

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  type: ChunkType;
  primarySymbol?: string;
  symbols?: string[];
}

export interface ChunkingContext {
  filePath: string;
  content: string;
  language: string;
}

export interface ChunkingStrategy {
  chunk(context: ChunkingContext): Chunk[];
}
