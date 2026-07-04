import { describe, expect, it } from 'vitest';
import { EASING_NAMES } from '@pix3/runtime';
import {
  EASING_FLAT_ORDER,
  EASING_META,
  easingDomain,
  easingSparklinePath,
  linearGuidePath,
  sampleEasing,
} from './easing-curve';

describe('sampleEasing', () => {
  it('holds then jumps for step (unlike runtime applyEasing which is 0)', () => {
    expect(sampleEasing('step', 0)).toBe(0);
    expect(sampleEasing('step', 0.5)).toBe(0);
    expect(sampleEasing('step', 0.999)).toBe(0);
    expect(sampleEasing('step', 1)).toBe(1);
  });

  it('is the identity for linear and clamps out-of-range t', () => {
    expect(sampleEasing('linear', 0)).toBe(0);
    expect(sampleEasing('linear', 0.5)).toBe(0.5);
    expect(sampleEasing('linear', 1)).toBe(1);
    expect(sampleEasing('linear', -1)).toBe(0);
    expect(sampleEasing('linear', 2)).toBe(1);
  });

  it('overshoots past 1 for back/elastic out easings', () => {
    const peak = Math.max(...Array.from({ length: 21 }, (_, i) => sampleEasing('backOut', i / 20)));
    expect(peak).toBeGreaterThan(1);
  });
});

describe('easingDomain', () => {
  it('widens for overshoot families and stays tight otherwise', () => {
    expect(easingDomain('backOut')).toEqual([-0.5, 1.5]);
    expect(easingDomain('elasticIn')).toEqual([-0.5, 1.5]);
    expect(easingDomain('cubicInOut')).toEqual([-0.12, 1.12]);
    expect(easingDomain('linear')).toEqual([-0.12, 1.12]);
  });
});

describe('easingSparklinePath', () => {
  it('produces a 3-point hold-then-jump polyline for step', () => {
    const path = easingSparklinePath('step', 52, 30, { pad: 5 });
    expect(path.split(' ')).toHaveLength(3);
  });

  it('caches identical requests (same reference-equal string)', () => {
    const a = easingSparklinePath('cubicOut', 52, 30, { pad: 5 });
    const b = easingSparklinePath('cubicOut', 52, 30, { pad: 5 });
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('linearGuidePath', () => {
  it('meets the curve endpoints in the same domain the curve uses', () => {
    // For an overshoot easing the guide must use the wider domain, so v=1 maps
    // higher (smaller y) than it would in the normal domain.
    const overshoot = linearGuidePath('backOut', 52, 30, 5);
    const normal = linearGuidePath('linear', 52, 30, 5);
    expect(overshoot).not.toEqual(normal);
  });
});

describe('EASING_FLAT_ORDER / EASING_META', () => {
  it('covers exactly the runtime easing set', () => {
    expect(new Set(EASING_FLAT_ORDER)).toEqual(new Set(EASING_NAMES));
    expect(EASING_FLAT_ORDER).toHaveLength(EASING_NAMES.length);
    for (const name of EASING_NAMES) {
      expect(EASING_META[name]).toBeTruthy();
      expect(EASING_META[name].label.length).toBeGreaterThan(0);
    }
  });
});
