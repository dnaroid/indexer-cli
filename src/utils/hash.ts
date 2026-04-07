import { createHash } from 'node:crypto';

export function computeHash(text: string): string {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\uFEFF/g, '')
    .trimEnd();
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}
