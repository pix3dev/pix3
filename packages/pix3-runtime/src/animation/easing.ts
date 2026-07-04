/**
 * Easing functions for keyframe animation tweens.
 *
 * All functions map a normalized progress t in [0, 1] to an eased progress.
 * Based on the standard Penner easing equations.
 */

/**
 * Easing applied to the segment FROM a keyframe TO the next keyframe.
 * 'step' holds the left key's value until the next key (no interpolation).
 */
export type KeyframeEasing =
  | 'linear'
  | 'step'
  | 'sineIn'
  | 'sineOut'
  | 'sineInOut'
  | 'quadIn'
  | 'quadOut'
  | 'quadInOut'
  | 'cubicIn'
  | 'cubicOut'
  | 'cubicInOut'
  | 'expoIn'
  | 'expoOut'
  | 'expoInOut'
  | 'backIn'
  | 'backOut'
  | 'backInOut'
  | 'elasticIn'
  | 'elasticOut'
  | 'elasticInOut'
  | 'bounceIn'
  | 'bounceOut'
  | 'bounceInOut';

const BACK_C1 = 1.70158;
const BACK_C2 = BACK_C1 * 1.525;
const BACK_C3 = BACK_C1 + 1;
const ELASTIC_C4 = (2 * Math.PI) / 3;
const ELASTIC_C5 = (2 * Math.PI) / 4.5;

function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) {
    return n1 * t * t;
  }
  if (t < 2 / d1) {
    const u = t - 1.5 / d1;
    return n1 * u * u + 0.75;
  }
  if (t < 2.5 / d1) {
    const u = t - 2.25 / d1;
    return n1 * u * u + 0.9375;
  }
  const u = t - 2.625 / d1;
  return n1 * u * u + 0.984375;
}

const EASING_FUNCTIONS: Record<KeyframeEasing, (t: number) => number> = {
  linear: t => t,
  // 'step' is handled by the evaluator (hold-left); returning 0 keeps the
  // left key's value if this function is ever applied directly.
  step: () => 0,
  sineIn: t => 1 - Math.cos((t * Math.PI) / 2),
  sineOut: t => Math.sin((t * Math.PI) / 2),
  sineInOut: t => -(Math.cos(Math.PI * t) - 1) / 2,
  quadIn: t => t * t,
  quadOut: t => 1 - (1 - t) * (1 - t),
  quadInOut: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  cubicIn: t => t * t * t,
  cubicOut: t => 1 - Math.pow(1 - t, 3),
  cubicInOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  expoIn: t => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  expoOut: t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  expoInOut: t => {
    if (t === 0) {
      return 0;
    }
    if (t === 1) {
      return 1;
    }
    return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
  },
  backIn: t => BACK_C3 * t * t * t - BACK_C1 * t * t,
  backOut: t => 1 + BACK_C3 * Math.pow(t - 1, 3) + BACK_C1 * Math.pow(t - 1, 2),
  backInOut: t =>
    t < 0.5
      ? (Math.pow(2 * t, 2) * ((BACK_C2 + 1) * 2 * t - BACK_C2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((BACK_C2 + 1) * (t * 2 - 2) + BACK_C2) + 2) / 2,
  elasticIn: t => {
    if (t === 0) {
      return 0;
    }
    if (t === 1) {
      return 1;
    }
    return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ELASTIC_C4);
  },
  elasticOut: t => {
    if (t === 0) {
      return 0;
    }
    if (t === 1) {
      return 1;
    }
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_C4) + 1;
  },
  elasticInOut: t => {
    if (t === 0) {
      return 0;
    }
    if (t === 1) {
      return 1;
    }
    return t < 0.5
      ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2
      : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * ELASTIC_C5)) / 2 + 1;
  },
  bounceIn: t => 1 - bounceOut(1 - t),
  bounceOut,
  bounceInOut: t => (t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2),
};

/** All easing identifiers, in menu order (for editor UI). */
export const EASING_NAMES: readonly KeyframeEasing[] = Object.keys(
  EASING_FUNCTIONS
) as KeyframeEasing[];

export function isKeyframeEasing(value: unknown): value is KeyframeEasing {
  return typeof value === 'string' && value in EASING_FUNCTIONS;
}

/** Apply an easing curve to a normalized progress value (clamped to [0, 1]). */
export function applyEasing(easing: KeyframeEasing, t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const fn = EASING_FUNCTIONS[easing] ?? EASING_FUNCTIONS.linear;
  return fn(clamped);
}
