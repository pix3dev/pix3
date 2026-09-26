/** Levenshtein distance; inputs are short identifiers. */
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
};

/**
 * The candidate closest to `input` — a case-insensitive match first, else the nearest within an
 * edit distance of 2 (3 for long names). `undefined` when nothing is close enough to be a typo.
 */
export const nearest = (input: string, candidates: Iterable<string>): string | undefined => {
  const lower = input.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === input) continue;
    if (candidate.toLowerCase() === lower) return candidate;
    const distance = editDistance(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const limit = input.length >= 10 ? 3 : 2;
  return bestDistance <= limit ? best : undefined;
};
