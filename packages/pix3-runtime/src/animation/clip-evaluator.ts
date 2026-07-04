/**
 * Keyframe clip evaluator.
 *
 * Split in two layers:
 * - a pure sampling layer (no scene-graph dependency) used by both the
 *   runtime player and the editor timeline preview, and
 * - a node-applying layer that resolves track targets against a host node
 *   and writes sampled values through the property schema.
 */

import type { NodeBase } from '../nodes/NodeBase';
import type { PropertyDefinition } from '../fw/property-schema';
import { getNodePropertySchema, getPropertyDefinition } from '../fw/property-schema-utils';
import { applyEasing } from './easing';
import type {
  AudioKeyframe,
  AudioTrack,
  KeyframeClip,
  KeyframeValue,
  PropertyTrack,
  TrackValueType,
} from './keyframe-types';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  let hex = match[1];
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map(ch => ch + ch)
      .join('');
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function formatHexColor(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  const toHex = (v: number) => clamp(v).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Interpolate two keyframe values of the given type with progress t in [0, 1]. */
export function interpolateValue(
  valueType: TrackValueType,
  a: KeyframeValue,
  b: KeyframeValue,
  t: number
): KeyframeValue {
  switch (valueType) {
    case 'number':
      return lerp(a as number, b as number, t);
    case 'vector2': {
      const va = a as [number, number];
      const vb = b as [number, number];
      return [lerp(va[0], vb[0], t), lerp(va[1], vb[1], t)];
    }
    case 'vector3':
    case 'euler': {
      const va = a as [number, number, number];
      const vb = b as [number, number, number];
      return [lerp(va[0], vb[0], t), lerp(va[1], vb[1], t), lerp(va[2], vb[2], t)];
    }
    case 'color': {
      const ca = parseHexColor(a as string);
      const cb = parseHexColor(b as string);
      if (!ca || !cb) {
        return a;
      }
      return formatHexColor(lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t));
    }
    case 'boolean':
    case 'string':
      // Discrete types hold the left key's value.
      return a;
  }
}

/**
 * Sample a property track at the given time.
 * Hold semantics outside the key range: before the first key the first
 * value is returned, after the last key the last value. Returns null for
 * empty tracks.
 */
export function sampleTrack(track: PropertyTrack, time: number): KeyframeValue | null {
  const keys = track.keys;
  if (keys.length === 0) {
    return null;
  }
  if (time <= keys[0].time) {
    return keys[0].value;
  }
  const last = keys[keys.length - 1];
  if (time >= last.time) {
    return last.value;
  }

  // Binary search for the segment [a, b] with a.time <= time < b.time.
  let low = 0;
  let high = keys.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (keys[mid].time <= time) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const a = keys[low];
  const b = keys[high];
  if (a.easing === 'step' || track.valueType === 'boolean' || track.valueType === 'string') {
    return a.value;
  }

  const span = b.time - a.time;
  const t = span > 0 ? (time - a.time) / span : 1;
  return interpolateValue(track.valueType, a.value, b.value, applyEasing(a.easing, t));
}

export interface AudioKeyRangeOptions {
  /**
   * Loop wrap support: when `to < from`, keys are collected from
   * `(from, wrapDuration]` and `[0, to]` (the `[0, ...]` part is inclusive
   * so keys at exactly t=0 fire on wrap).
   */
  wrapDuration?: number;
  /** Include a key at exactly `from` (used on the first frame after play()). */
  includeStart?: boolean;
}

/**
 * Collect audio keys crossed while advancing from `from` to `to`.
 * The shared boundary rule is `from < time <= to`; both the runtime player
 * and the editor preview use this function so keys fire exactly once.
 */
export function collectAudioKeysInRange(
  track: AudioTrack,
  from: number,
  to: number,
  options: AudioKeyRangeOptions = {}
): AudioKeyframe[] {
  if (!track.enabled || track.keys.length === 0) {
    return [];
  }

  const includeStart = options.includeStart === true;
  const inRange = (time: number, start: number, end: number, inclusiveStart: boolean): boolean =>
    (inclusiveStart ? time >= start : time > start) && time <= end;

  if (options.wrapDuration !== undefined && to < from) {
    const duration = options.wrapDuration;
    return track.keys.filter(
      key => inRange(key.time, from, duration, includeStart) || inRange(key.time, 0, to, true)
    );
  }

  return track.keys.filter(key => inRange(key.time, from, to, includeStart));
}

/** Convert a stored keyframe value into the shape expected by PropertyDefinition.setValue. */
export function toSchemaValue(valueType: TrackValueType, value: KeyframeValue): unknown {
  switch (valueType) {
    case 'vector2': {
      const v = value as [number, number];
      return { x: v[0], y: v[1] };
    }
    case 'vector3':
    case 'euler': {
      const v = value as [number, number, number];
      return { x: v[0], y: v[1], z: v[2] };
    }
    default:
      return value;
  }
}

/**
 * Convert a value read from PropertyDefinition.getValue into the JSON storage
 * shape. Returns null when the value does not match the track type.
 */
export function fromSchemaValue(valueType: TrackValueType, value: unknown): KeyframeValue | null {
  switch (valueType) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    case 'string':
    case 'color':
      return typeof value === 'string' ? value : null;
    case 'vector2': {
      const v = value as { x?: unknown; y?: unknown } | null;
      if (v && typeof v.x === 'number' && typeof v.y === 'number') {
        return [v.x, v.y];
      }
      return null;
    }
    case 'vector3':
    case 'euler': {
      const v = value as { x?: unknown; y?: unknown; z?: unknown } | null;
      if (v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
        return [v.x, v.y, v.z];
      }
      return null;
    }
  }
}

/**
 * Resolve a track target path against the host node.
 * '' or '.' resolves to the host itself; other paths use findByPath semantics.
 */
export function resolveTrackTarget(host: NodeBase, targetPath: string): NodeBase | null {
  const trimmed = targetPath.trim();
  if (trimmed.length === 0 || trimmed === '.') {
    return host;
  }
  return host.findByPath(trimmed);
}

export interface PropertyBindingEntry {
  track: PropertyTrack;
  node: NodeBase;
  propDef: PropertyDefinition;
}

export interface ClipBinding {
  clip: KeyframeClip;
  entries: PropertyBindingEntry[];
  audioTracks: AudioTrack[];
  /** targetPath/property pairs that could not be resolved (missing node or property). */
  missingTargets: string[];
}

/**
 * Resolve every track of a clip against the host node once.
 * Unresolved property tracks are recorded in `missingTargets` and skipped by
 * `applyClipAtTime`; call again after structural scene changes.
 */
export function createClipBindings(host: NodeBase, clip: KeyframeClip): ClipBinding {
  const entries: PropertyBindingEntry[] = [];
  const audioTracks: AudioTrack[] = [];
  const missingTargets: string[] = [];

  for (const track of clip.tracks) {
    if (track.kind === 'audio') {
      audioTracks.push(track);
      continue;
    }

    const node = resolveTrackTarget(host, track.targetPath);
    if (!node) {
      missingTargets.push(`${track.targetPath || '.'} → ${track.property} (node not found)`);
      continue;
    }

    const propDef = getPropertyDefinition(getNodePropertySchema(node), track.property);
    if (!propDef) {
      missingTargets.push(`${track.targetPath || '.'} → ${track.property} (property not found)`);
      continue;
    }

    entries.push({ track, node, propDef });
  }

  return { clip, entries, audioTracks, missingTargets };
}

/**
 * Apply all resolved property tracks of the binding at the given time.
 * Disabled tracks and empty tracks are skipped. Audio tracks are not touched
 * (audio firing is time-window based and owned by the caller).
 */
export function applyClipAtTime(binding: ClipBinding, time: number): void {
  const clampedTime = Math.min(Math.max(0, time), binding.clip.duration);
  for (const entry of binding.entries) {
    if (!entry.track.enabled) {
      continue;
    }
    const value = sampleTrack(entry.track, clampedTime);
    if (value === null) {
      continue;
    }
    entry.propDef.setValue(entry.node, toSchemaValue(entry.track.valueType, value));
  }
}
