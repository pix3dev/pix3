import { describe, expect, it } from 'vitest';
import { getPassPlan } from '@/services/model-gen/prompts';
import type { PassId } from '@/services/model-gen/model-gen-types';

const ids = (mode: 'fast' | 'quality'): PassId[] => getPassPlan(mode).map(pass => pass.id);

describe('getPassPlan', () => {
  it('returns the full 6-pass plan in order for quality mode', () => {
    expect(ids('quality')).toEqual([
      'blockout',
      'structure',
      'form',
      'material',
      'lighting',
      'optimization',
    ]);
  });

  it('returns the 2-pass merged plan in order for fast mode', () => {
    expect(ids('fast')).toEqual(['blockout', 'form-material']);
  });

  it('gives every pass a non-empty label, goal and rubric', () => {
    for (const mode of ['fast', 'quality'] as const) {
      for (const pass of getPassPlan(mode)) {
        expect(pass.label.length).toBeGreaterThan(0);
        expect(pass.goal.length).toBeGreaterThan(0);
        expect(pass.reviewRubric.length).toBeGreaterThan(0);
      }
    }
  });

  it('returns a fresh array each call (callers may seed mutable state from it)', () => {
    const a = getPassPlan('quality');
    const b = getPassPlan('quality');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
