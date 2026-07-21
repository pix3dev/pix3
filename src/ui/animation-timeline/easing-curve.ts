/**
 * Editor-side easing presentation helpers for the animation timeline.
 *
 * The runtime (`@pix3/runtime`) owns the easing MATH (`applyEasing`,
 * `EASING_NAMES`) and stays a publishable, editor-agnostic library. This module
 * layers the *visual* concerns on top — curve sampling for drawing, cached SVG
 * polyline paths, human-readable metadata (family / direction / tooltip), and
 * the grouped layout the visual easing picker renders. Nothing here belongs in
 * the runtime package.
 *
 * The 23 easing curves are static, so their sparkline paths are computed once
 * and cached per size.
 */

import { applyEasing, type KeyframeEasing } from '@pix3/runtime';

export type EasingFamily =
  | 'basic'
  | 'sine'
  | 'quad'
  | 'cubic'
  | 'expo'
  | 'back'
  | 'elastic'
  | 'bounce';

export type EasingDirection = 'in' | 'out' | 'inOut' | null;

export interface EasingMeta {
  family: EasingFamily;
  direction: EasingDirection;
  /** Short human label for triggers/tooltips, e.g. "Cubic In". */
  label: string;
  /** One-line behaviour hint shown in tooltips/aria-labels. */
  tooltip: string;
}

/**
 * Sample an easing curve for DRAWING. Unlike `applyEasing`, `step` produces the
 * hold-then-jump shape (flat at 0 until the very end, then 1) instead of the
 * runtime's `() => 0` (which is applied specially by the evaluator). Overshoot
 * families (back / elastic) return values outside [0, 1] — callers that draw
 * within a fixed box must reserve headroom (see {@link easingDomain}).
 */
export function sampleEasing(easing: KeyframeEasing, t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (easing === 'step') {
    return clamped >= 1 ? 1 : 0;
  }
  return applyEasing(easing, clamped);
}

const OVERSHOOT_DOMAIN: readonly [number, number] = [-0.5, 1.5];
const NORMAL_DOMAIN: readonly [number, number] = [-0.12, 1.12];

/** Value range a curve should be drawn against so overshoot stays visible. */
export function easingDomain(easing: KeyframeEasing): readonly [number, number] {
  if (easing.startsWith('back') || easing.startsWith('elastic')) {
    return OVERSHOOT_DOMAIN;
  }
  return NORMAL_DOMAIN;
}

/** Map an easing value to a Y pixel inside a [pad, h-pad] box (top = high). */
function easingValueToY(
  value: number,
  height: number,
  pad: number,
  domain: readonly [number, number]
): number {
  const [vmin, vmax] = domain;
  const inner = height - 2 * pad;
  const norm = (value - vmin) / (vmax - vmin);
  return height - pad - norm * inner;
}

interface SparklineOptions {
  samples?: number;
  pad?: number;
}

const sparklineCache = new Map<string, string>();

/**
 * Build an SVG `points` string for the easing curve inside a `width`×`height`
 * box. Cached per (easing, size, samples, pad) — the curves never change.
 */
export function easingSparklinePath(
  easing: KeyframeEasing,
  width: number,
  height: number,
  options: SparklineOptions = {}
): string {
  const samples = options.samples ?? 32;
  const pad = options.pad ?? 4;
  const cacheKey = `${easing}:${width}x${height}:${samples}:${pad}`;
  const cached = sparklineCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const domain = easingDomain(easing);
  const innerW = width - 2 * pad;
  const points: string[] = [];

  if (easing === 'step') {
    // Flat along the bottom (value 0) then a vertical jump to the top (value 1).
    const y0 = easingValueToY(0, height, pad, domain);
    const y1 = easingValueToY(1, height, pad, domain);
    const xEnd = pad + innerW;
    points.push(`${pad.toFixed(2)},${y0.toFixed(2)}`);
    points.push(`${xEnd.toFixed(2)},${y0.toFixed(2)}`);
    points.push(`${xEnd.toFixed(2)},${y1.toFixed(2)}`);
  } else {
    for (let i = 0; i <= samples; i += 1) {
      const t = i / samples;
      const x = pad + t * innerW;
      const y = easingValueToY(sampleEasing(easing, t), height, pad, domain);
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
  }

  const path = points.join(' ');
  sparklineCache.set(cacheKey, path);
  return path;
}

/**
 * The linear reference diagonal for the same box. Drawn against the SAME domain
 * as the curve it sits behind, so it meets the curve at (t=0, v=0) and
 * (t=1, v=1) — including the wider overshoot domain used by back / elastic.
 */
export function linearGuidePath(
  easing: KeyframeEasing,
  width: number,
  height: number,
  pad = 4
): string {
  const domain = easingDomain(easing);
  const y0 = easingValueToY(0, height, pad, domain);
  const y1 = easingValueToY(1, height, pad, domain);
  return `${pad.toFixed(2)},${y0.toFixed(2)} ${(width - pad).toFixed(2)},${y1.toFixed(2)}`;
}

export const EASING_META: Record<KeyframeEasing, EasingMeta> = {
  linear: { family: 'basic', direction: null, label: 'Linear', tooltip: 'Linear — constant rate' },
  step: {
    family: 'basic',
    direction: null,
    label: 'Step',
    tooltip: 'Step — holds value, snaps at the next key',
  },
  sineIn: {
    family: 'sine',
    direction: 'in',
    label: 'Sine In',
    tooltip: 'Sine In — gentle slow start',
  },
  sineOut: {
    family: 'sine',
    direction: 'out',
    label: 'Sine Out',
    tooltip: 'Sine Out — gentle ease to a stop',
  },
  sineInOut: {
    family: 'sine',
    direction: 'inOut',
    label: 'Sine In-Out',
    tooltip: 'Sine In-Out — gentle at both ends',
  },
  quadIn: {
    family: 'quad',
    direction: 'in',
    label: 'Quad In',
    tooltip: 'Quad In — starts slow, accelerates',
  },
  quadOut: {
    family: 'quad',
    direction: 'out',
    label: 'Quad Out',
    tooltip: 'Quad Out — fast start, eases to a stop',
  },
  quadInOut: {
    family: 'quad',
    direction: 'inOut',
    label: 'Quad In-Out',
    tooltip: 'Quad In-Out — slow ends, faster middle',
  },
  cubicIn: {
    family: 'cubic',
    direction: 'in',
    label: 'Cubic In',
    tooltip: 'Cubic In — slow start, strong acceleration',
  },
  cubicOut: {
    family: 'cubic',
    direction: 'out',
    label: 'Cubic Out',
    tooltip: 'Cubic Out — fast start, strong ease-out',
  },
  cubicInOut: {
    family: 'cubic',
    direction: 'inOut',
    label: 'Cubic In-Out',
    tooltip: 'Cubic In-Out — slow ends, fast middle',
  },
  expoIn: {
    family: 'expo',
    direction: 'in',
    label: 'Expo In',
    tooltip: 'Expo In — very slow start, sharp finish',
  },
  expoOut: {
    family: 'expo',
    direction: 'out',
    label: 'Expo Out',
    tooltip: 'Expo Out — sharp start, long tail',
  },
  expoInOut: {
    family: 'expo',
    direction: 'inOut',
    label: 'Expo In-Out',
    tooltip: 'Expo In-Out — sharp acceleration in the middle',
  },
  backIn: {
    family: 'back',
    direction: 'in',
    label: 'Back In',
    tooltip: 'Back In — anticipates backward, then accelerates',
  },
  backOut: {
    family: 'back',
    direction: 'out',
    label: 'Back Out',
    tooltip: 'Back Out — overshoots past the target, then settles',
  },
  backInOut: {
    family: 'back',
    direction: 'inOut',
    label: 'Back In-Out',
    tooltip: 'Back In-Out — anticipates and overshoots',
  },
  elasticIn: {
    family: 'elastic',
    direction: 'in',
    label: 'Elastic In',
    tooltip: 'Elastic In — winds up, then springs',
  },
  elasticOut: {
    family: 'elastic',
    direction: 'out',
    label: 'Elastic Out',
    tooltip: 'Elastic Out — springs past and oscillates to rest',
  },
  elasticInOut: {
    family: 'elastic',
    direction: 'inOut',
    label: 'Elastic In-Out',
    tooltip: 'Elastic In-Out — springs at both ends',
  },
  bounceIn: {
    family: 'bounce',
    direction: 'in',
    label: 'Bounce In',
    tooltip: 'Bounce In — bounces up to the start',
  },
  bounceOut: {
    family: 'bounce',
    direction: 'out',
    label: 'Bounce Out',
    tooltip: 'Bounce Out — bounces on landing',
  },
  bounceInOut: {
    family: 'bounce',
    direction: 'inOut',
    label: 'Bounce In-Out',
    tooltip: 'Bounce In-Out — bounces at both ends',
  },
};

export interface EasingFamilyRow {
  family: EasingFamily;
  label: string;
  in: KeyframeEasing;
  out: KeyframeEasing;
  inOut: KeyframeEasing;
}

/** Basic easings that occupy the popover's first row (no In/Out split). */
export const EASING_BASIC: readonly KeyframeEasing[] = ['linear', 'step'];

/** Ordered family rows (In / Out / In-Out) for the picker grid. */
export const EASING_FAMILY_ROWS: readonly EasingFamilyRow[] = [
  { family: 'sine', label: 'Sine', in: 'sineIn', out: 'sineOut', inOut: 'sineInOut' },
  { family: 'quad', label: 'Quad', in: 'quadIn', out: 'quadOut', inOut: 'quadInOut' },
  { family: 'cubic', label: 'Cubic', in: 'cubicIn', out: 'cubicOut', inOut: 'cubicInOut' },
  { family: 'expo', label: 'Expo', in: 'expoIn', out: 'expoOut', inOut: 'expoInOut' },
  { family: 'back', label: 'Back', in: 'backIn', out: 'backOut', inOut: 'backInOut' },
  {
    family: 'elastic',
    label: 'Elastic',
    in: 'elasticIn',
    out: 'elasticOut',
    inOut: 'elasticInOut',
  },
  { family: 'bounce', label: 'Bounce', in: 'bounceIn', out: 'bounceOut', inOut: 'bounceInOut' },
];

/** Column order for family rows, matching Godot's In / Out / In-Out preset names. */
export const EASING_DIRECTION_COLUMNS: readonly {
  key: 'in' | 'out' | 'inOut';
  label: string;
}[] = [
  { key: 'in', label: 'In' },
  { key: 'out', label: 'Out' },
  { key: 'inOut', label: 'In-Out' },
];

/** Flat navigation order for keyboard/roving-tabindex traversal. */
export const EASING_FLAT_ORDER: readonly KeyframeEasing[] = [
  ...EASING_BASIC,
  ...EASING_FAMILY_ROWS.flatMap(row => [row.in, row.out, row.inOut]),
];

export function easingLabel(easing: KeyframeEasing): string {
  return EASING_META[easing]?.label ?? easing;
}

export function easingTooltip(easing: KeyframeEasing): string {
  return EASING_META[easing]?.tooltip ?? easing;
}
