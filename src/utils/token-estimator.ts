export class TokenEstimator {
  estimate(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return Math.max(1, Math.ceil(trimmed.length / 4));
  }
}
