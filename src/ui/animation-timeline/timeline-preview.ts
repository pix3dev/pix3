/**
 * Pure builders for the in-lane track PREVIEW layer (drawn behind the keys).
 *
 * The signature feature Godot only gives dedicated Bezier tracks — an inline
 * value-over-time curve — we get for free from the discrete keyframe model:
 * every property track draws its interpolated value, bent by each segment's
 * easing. Colors draw a ramp, booleans a step wave, strings/audio a text chip.
 *
 * All geometry is in lane pixels (1 unit = 1px), so it lines up with the keys
 * and playhead that use the same {@link timeToX} mapping.
 */

import { sampleEasing } from './easing-curve';
import { timeToX } from './timeline-geometry';
import type {
  AudioTrack,
  ClipTrack,
  KeyframeValue,
  PropertyTrack,
  TrackValueType,
} from '@pix3/runtime';

export const PREVIEW_PAD = 3;
/** Per-vector-component stroke colors: x / y / z(w). */
const CHANNEL_COLORS = ['#ff6b6b', '#4ade80', '#60a5fa'];
const SINGLE_CHANNEL_COLOR = '#cbd5e1';

export interface CurvePath {
  color: string;
  points: string;
  width: number;
}

export interface ColorSegment {
  x0: number;
  x1: number;
  id: string;
  stops: Array<{ offset: number; color: string }>;
}

export interface TextSegment {
  x: number;
  width: number;
  text: string;
}

export type LanePreview =
  | { kind: 'curves'; paths: CurvePath[] }
  | { kind: 'color'; segments: ColorSegment[] }
  | { kind: 'text'; segments: TextSegment[] }
  | { kind: 'none' };

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Extract a key's animated value as an array of numeric channels. */
function toChannels(valueType: TrackValueType, value: KeyframeValue): number[] {
  switch (valueType) {
    case 'number':
      return [num(value)];
    case 'boolean':
      return [value === true ? 1 : 0];
    case 'vector2':
      return Array.isArray(value) ? [num(value[0]), num(value[1])] : [0, 0];
    case 'vector3':
    case 'euler':
      return Array.isArray(value) ? [num(value[0]), num(value[1]), num(value[2])] : [0, 0, 0];
    default:
      return [];
  }
}

function buildCurves(
  track: PropertyTrack,
  height: number,
  zoom: number,
  endTime: number
): CurvePath[] {
  const keys = track.keys;
  if (keys.length === 0) {
    return [];
  }
  const perKey = keys.map(key => toChannels(track.valueType, key.value));
  const channels = perKey[0]?.length ?? 0;
  if (channels === 0) {
    return [];
  }
  const isBool = track.valueType === 'boolean';
  const paths: CurvePath[] = [];

  for (let c = 0; c < channels; c += 1) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const cv of perKey) {
      min = Math.min(min, cv[c]);
      max = Math.max(max, cv[c]);
    }
    let vmin = min;
    let vmax = max;
    if (isBool) {
      vmin = 0;
      vmax = 1;
    } else if (min === max) {
      vmin = min - 1;
      vmax = max + 1;
    } else {
      const padValue = (max - min) * 0.15;
      vmin = min - padValue;
      vmax = max + padValue;
    }
    const inner = height - 2 * PREVIEW_PAD;
    const yOf = (v: number): number => height - PREVIEW_PAD - ((v - vmin) / (vmax - vmin)) * inner;

    const points: string[] = [`${timeToX(0, zoom).toFixed(1)},${yOf(perKey[0][c]).toFixed(1)}`];
    for (let i = 0; i < keys.length - 1; i += 1) {
      const tA = keys[i].time;
      const tB = keys[i + 1].time;
      const vA = perKey[i][c];
      const vB = perKey[i + 1][c];
      const easing = keys[i].easing;
      const xA = timeToX(tA, zoom);
      const xB = timeToX(tB, zoom);
      points.push(`${xA.toFixed(1)},${yOf(vA).toFixed(1)}`);
      if (isBool || easing === 'step') {
        // Hold the left value, then jump at the next key.
        points.push(`${xB.toFixed(1)},${yOf(vA).toFixed(1)}`);
        points.push(`${xB.toFixed(1)},${yOf(vB).toFixed(1)}`);
      } else {
        const steps = Math.max(2, Math.min(48, Math.round((xB - xA) / 6)));
        for (let s = 1; s <= steps; s += 1) {
          const t = s / steps;
          const v = vA + (vB - vA) * sampleEasing(easing, t);
          const x = timeToX(tA + (tB - tA) * t, zoom);
          points.push(`${x.toFixed(1)},${yOf(v).toFixed(1)}`);
        }
      }
    }
    points.push(
      `${timeToX(endTime, zoom).toFixed(1)},${yOf(perKey[keys.length - 1][c]).toFixed(1)}`
    );

    paths.push({
      color: channels > 1 ? (CHANNEL_COLORS[c] ?? SINGLE_CHANNEL_COLOR) : SINGLE_CHANNEL_COLOR,
      points: points.join(' '),
      width: 1.25,
    });
  }
  return paths;
}

function normalizeHex(hex: string): [number, number, number] {
  const value = hex.trim().replace(/^#/, '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map(ch => ch + ch)
          .join('')
      : value.padEnd(6, '0').slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = normalizeHex(a);
  const [br, bg, bb] = normalizeHex(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${[r, g, bl].map(n => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')}`;
}

function buildColor(track: PropertyTrack, zoom: number, endTime: number): ColorSegment[] {
  const keys = track.keys;
  if (keys.length === 0) {
    return [];
  }
  const segments: ColorSegment[] = [];
  const first = String(keys[0].value);
  // Leading solid block before the first key.
  const firstX = timeToX(keys[0].time, zoom);
  if (firstX > timeToX(0, zoom)) {
    segments.push({
      x0: timeToX(0, zoom),
      x1: firstX,
      id: `atlgrad-${track.id}-lead`,
      stops: [
        { offset: 0, color: first },
        { offset: 1, color: first },
      ],
    });
  }
  for (let i = 0; i < keys.length - 1; i += 1) {
    const from = String(keys[i].value);
    const to = String(keys[i + 1].value);
    const easing = keys[i].easing;
    const x0 = timeToX(keys[i].time, zoom);
    const x1 = timeToX(keys[i + 1].time, zoom);
    let stops: Array<{ offset: number; color: string }>;
    if (easing === 'step') {
      stops = [
        { offset: 0, color: from },
        { offset: 1, color: from },
      ];
    } else {
      const count = Math.max(2, Math.min(10, Math.round((x1 - x0) / 16)));
      stops = Array.from({ length: count }, (_, s) => {
        const t = s / (count - 1);
        return { offset: t, color: mixHex(from, to, sampleEasing(easing, t)) };
      });
    }
    segments.push({ x0, x1, id: `atlgrad-${track.id}-${i}`, stops });
  }
  // Trailing solid block after the last key.
  const last = String(keys[keys.length - 1].value);
  const lastX = timeToX(keys[keys.length - 1].time, zoom);
  const endX = timeToX(endTime, zoom);
  if (endX > lastX) {
    segments.push({
      x0: lastX,
      x1: endX,
      id: `atlgrad-${track.id}-tail`,
      stops: [
        { offset: 0, color: last },
        { offset: 1, color: last },
      ],
    });
  }
  return segments;
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function buildText(
  keys: Array<{ time: number; label: string }>,
  zoom: number,
  endTime: number
): TextSegment[] {
  return keys.map((key, i) => {
    const x = timeToX(key.time, zoom);
    const nextTime = i < keys.length - 1 ? keys[i + 1].time : endTime;
    return { x, width: Math.max(0, timeToX(nextTime, zoom) - x), text: key.label };
  });
}

/** Build the preview for a lane. Audio and string render text chips per key. */
export function buildLanePreview(
  track: ClipTrack,
  zoom: number,
  laneHeight: number,
  endTime: number
): LanePreview {
  if (track.kind === 'audio') {
    const audio = track as AudioTrack;
    return {
      kind: 'text',
      segments: buildText(
        audio.keys.map(key => ({ time: key.time, label: basename(key.audioPath) })),
        zoom,
        endTime
      ),
    };
  }

  const property = track as PropertyTrack;
  switch (property.valueType) {
    case 'number':
    case 'vector2':
    case 'vector3':
    case 'euler':
    case 'boolean':
      return { kind: 'curves', paths: buildCurves(property, laneHeight, zoom, endTime) };
    case 'color':
      return { kind: 'color', segments: buildColor(property, zoom, endTime) };
    case 'string':
      return {
        kind: 'text',
        segments: buildText(
          property.keys.map(key => ({ time: key.time, label: String(key.value ?? '') })),
          zoom,
          endTime
        ),
      };
    default:
      return { kind: 'none' };
  }
}
