/**
 * Pure geometry helpers for the animation timeline panel.
 */

/** Horizontal pixels representing one second at zoom = 1. */
export const BASE_PX_PER_SECOND = 120;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;
/** Left padding inside timeline lanes before t=0, in pixels. */
export const LANE_PADDING_LEFT = 8;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function pxPerSecond(zoom: number): number {
  return BASE_PX_PER_SECOND * clampZoom(zoom);
}

export function timeToX(time: number, zoom: number): number {
  return LANE_PADDING_LEFT + time * pxPerSecond(zoom);
}

export function xToTime(x: number, zoom: number): number {
  return Math.max(0, (x - LANE_PADDING_LEFT) / pxPerSecond(zoom));
}

export function snapTime(time: number, step: number, enabled: boolean): number {
  if (!enabled || step <= 0) {
    return Math.max(0, time);
  }
  return Math.max(0, Math.round(time / step) * step);
}

export function formatTime(time: number): string {
  return `${time.toFixed(2)}s`;
}

export interface RulerTick {
  time: number;
  major: boolean;
  label: string | null;
}

const TICK_STEPS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
/** Minimum pixel distance between labelled (major) ticks. */
const MIN_MAJOR_SPACING_PX = 56;

/** Pick a major tick step so labels stay readable at the given zoom. */
export function getMajorTickStep(zoom: number): number {
  const pps = pxPerSecond(zoom);
  for (const step of TICK_STEPS) {
    if (step * pps >= MIN_MAJOR_SPACING_PX) {
      return step;
    }
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/**
 * Build ruler ticks covering [0, endTime]. Major ticks carry labels; each
 * major interval is subdivided into minor ticks.
 */
export function getRulerTicks(endTime: number, zoom: number): RulerTick[] {
  const major = getMajorTickStep(zoom);
  const minor = major / 5;
  const ticks: RulerTick[] = [];
  const count = Math.ceil(endTime / minor);

  for (let i = 0; i <= count; i += 1) {
    const time = i * minor;
    const isMajor = i % 5 === 0;
    ticks.push({
      time,
      major: isMajor,
      label: isMajor ? trimNumber(time) : null,
    });
  }
  return ticks;
}

function trimNumber(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return `${rounded}`;
}
