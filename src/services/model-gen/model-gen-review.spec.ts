import { describe, expect, it } from 'vitest';
import { coerceReviewResult } from '@/services/model-gen/model-gen-review';

describe('coerceReviewResult', () => {
  it('passes a well-formed review through', () => {
    const result = coerceReviewResult({
      globalScore: 0.82,
      featureScores: [
        { feature: 'silhouette', score: 0.9 },
        { feature: 'color', score: 0.7 },
      ],
      decision: 'continue',
      rationale: 'Close match.',
    });
    expect(result).toEqual({
      globalScore: 0.82,
      featureScores: [
        { feature: 'silhouette', score: 0.9 },
        { feature: 'color', score: 0.7 },
      ],
      decision: 'continue',
      rationale: 'Close match.',
    });
  });

  it('clamps globalScore into [0,1]', () => {
    expect(coerceReviewResult({ globalScore: 1.7 }).globalScore).toBe(1);
    expect(coerceReviewResult({ globalScore: -3 }).globalScore).toBe(0);
  });

  it('clamps feature scores and drops malformed feature entries', () => {
    const result = coerceReviewResult({
      featureScores: [
        { feature: 'a', score: 5 },
        { feature: 'b', score: 'nope' },
        { score: 0.5 },
        null,
        'garbage',
        { feature: '', score: 0.5 },
      ],
    });
    expect(result.featureScores).toEqual([
      { feature: 'a', score: 1 },
      { feature: 'b', score: 0 },
    ]);
  });

  it('defaults a missing or invalid decision to continue', () => {
    expect(coerceReviewResult({}).decision).toBe('continue');
    expect(coerceReviewResult({ decision: 'nonsense' }).decision).toBe('continue');
  });

  it('preserves each valid decision value', () => {
    for (const decision of ['continue', 'refine-code', 'refine-spec', 'stop'] as const) {
      expect(coerceReviewResult({ decision }).decision).toBe(decision);
    }
  });

  it('defaults a non-string rationale to empty and a non-number globalScore to 0', () => {
    const result = coerceReviewResult({ globalScore: 'high', rationale: 42 });
    expect(result.globalScore).toBe(0);
    expect(result.rationale).toBe('');
  });

  it('never throws on garbage input', () => {
    for (const input of [null, undefined, 'nope', 42, []]) {
      const result = coerceReviewResult(input);
      expect(result.decision).toBe('continue');
      expect(result.globalScore).toBe(0);
      expect(result.featureScores).toEqual([]);
    }
  });
});
