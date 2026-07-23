import { describe, expect, it } from 'vitest';
import { getSceneEditPassPlan, getScenePassPlan } from '@/services/model-gen/scene/prompts';
import type { PassId } from '@/services/model-gen/model-gen-types';

const ids = (mode: 'fast' | 'quality'): PassId[] => getScenePassPlan(mode).map(pass => pass.id);
const editIds = (mode: 'fast' | 'quality'): PassId[] =>
  getSceneEditPassPlan(mode).map(pass => pass.id);

describe('getScenePassPlan', () => {
  it('returns the full 5-pass plan in order for quality mode', () => {
    expect(ids('quality')).toEqual(['layout', 'placement', 'dressing', 'lighting', 'polish']);
  });

  it('returns the 3-pass merged plan in order for fast mode', () => {
    expect(ids('fast')).toEqual(['layout', 'dressing', 'polish']);
  });

  it('gives every pass a non-empty label, goal and rubric', () => {
    for (const mode of ['fast', 'quality'] as const) {
      for (const pass of getScenePassPlan(mode)) {
        expect(pass.label.length).toBeGreaterThan(0);
        expect(pass.goal.length).toBeGreaterThan(0);
        expect(pass.reviewRubric.length).toBeGreaterThan(0);
      }
    }
  });

  it('returns a fresh array each call (callers may seed mutable state from it)', () => {
    const a = getScenePassPlan('quality');
    const b = getScenePassPlan('quality');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('getSceneEditPassPlan', () => {
  it('skips layout/placement and runs dressing → lighting → polish for quality mode', () => {
    expect(editIds('quality')).toEqual(['dressing', 'lighting', 'polish']);
  });

  it('collapses to dressing → polish for fast mode', () => {
    expect(editIds('fast')).toEqual(['dressing', 'polish']);
  });

  it('gives every edit pass a non-empty label, goal and rubric', () => {
    for (const mode of ['fast', 'quality'] as const) {
      for (const pass of getSceneEditPassPlan(mode)) {
        expect(pass.label.length).toBeGreaterThan(0);
        expect(pass.goal.length).toBeGreaterThan(0);
        expect(pass.reviewRubric.length).toBeGreaterThan(0);
      }
    }
  });

  it('returns a fresh array each call', () => {
    const a = getSceneEditPassPlan('quality');
    const b = getSceneEditPassPlan('quality');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
