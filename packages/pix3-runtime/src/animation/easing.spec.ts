import { describe, expect, it } from 'vitest';
import { applyEasing, EASING_NAMES, isKeyframeEasing, type KeyframeEasing } from './easing';

const CONTINUOUS_EASINGS = EASING_NAMES.filter(name => name !== 'step');

describe('easing', () => {
  it('maps 0 to 0 and 1 to 1 for every continuous easing', () => {
    for (const easing of CONTINUOUS_EASINGS) {
      expect(applyEasing(easing, 0), `${easing}(0)`).toBeCloseTo(0, 6);
      expect(applyEasing(easing, 1), `${easing}(1)`).toBeCloseTo(1, 6);
    }
  });

  it('clamps progress outside [0, 1]', () => {
    expect(applyEasing('linear', -0.5)).toBe(0);
    expect(applyEasing('linear', 1.5)).toBe(1);
  });

  it('mirrors in/out variants: easeIn(t) = 1 - easeOut(1 - t)', () => {
    const pairs: Array<[KeyframeEasing, KeyframeEasing]> = [
      ['sineIn', 'sineOut'],
      ['quadIn', 'quadOut'],
      ['cubicIn', 'cubicOut'],
      ['expoIn', 'expoOut'],
      ['bounceIn', 'bounceOut'],
    ];
    for (const [easeIn, easeOut] of pairs) {
      for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        expect(applyEasing(easeIn, t), `${easeIn}(${t})`).toBeCloseTo(
          1 - applyEasing(easeOut, 1 - t),
          6
        );
      }
    }
  });

  it('backOut overshoots above 1 mid-curve', () => {
    const values = [0.5, 0.6, 0.7, 0.8].map(t => applyEasing('backOut', t));
    expect(Math.max(...values)).toBeGreaterThan(1);
  });

  it('elasticOut oscillates around 1 mid-curve', () => {
    const values = [0.2, 0.3, 0.4, 0.5, 0.6].map(t => applyEasing('elasticOut', t));
    expect(Math.max(...values)).toBeGreaterThan(1);
    expect(Math.min(...values)).toBeLessThan(1);
  });

  it('step easing holds the left value', () => {
    expect(applyEasing('step', 0.99)).toBe(0);
  });

  it('validates easing names', () => {
    expect(isKeyframeEasing('bounceInOut')).toBe(true);
    expect(isKeyframeEasing('easeInOutQuad')).toBe(false);
    expect(isKeyframeEasing(42)).toBe(false);
  });

  it('falls back to linear for unknown easing values', () => {
    expect(applyEasing('nope' as KeyframeEasing, 0.25)).toBeCloseTo(0.25, 6);
  });
});
