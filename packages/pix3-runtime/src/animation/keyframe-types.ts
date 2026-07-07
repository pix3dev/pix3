/**
 * Keyframe animation data model.
 *
 * These structures are plain JSON and are stored inside the `config` of a
 * `core:AnimationPlayer` script component, so they serialize with the scene
 * verbatim. Vector values are stored as arrays (`[x, y]`, `[x, y, z]`); the
 * clip evaluator converts to the `{x, y[, z]}` shape expected by the property
 * schema only when applying values to nodes. Rotation values are stored in
 * degrees (matching the property schema contract).
 *
 * `KeyframeAnimationSet` is the versioned unit that could later be extracted
 * into standalone `.pix3clip` asset files without a data migration.
 */

import { isKeyframeEasing, type KeyframeEasing } from './easing';

/** JSON-safe keyframe value. Vectors are arrays in storage. */
export type KeyframeValue = number | boolean | string | [number, number] | [number, number, number];

/** Interpolation domain of a property track (subset of PropertyType). */
export type TrackValueType =
  | 'number'
  | 'vector2'
  | 'vector3'
  | 'euler'
  | 'color'
  | 'boolean'
  | 'string';

export interface PropertyKeyframe {
  /** Time in seconds, >= 0. */
  time: number;
  value: KeyframeValue;
  /** Easing of the segment FROM this key TO the next key. */
  easing: KeyframeEasing;
}

export interface PropertyTrack {
  /** Stable id within the clip (used by editor selection/coalescing). */
  id: string;
  kind: 'property';
  /**
   * Relative name path from the host node ('' or '.' = the host itself,
   * otherwise 'Child/GrandChild' with NodeBase.findByPath semantics).
   */
  targetPath: string;
  /** Property schema name, e.g. 'position', 'opacity', 'color'. */
  property: string;
  valueType: TrackValueType;
  /** Mute toggle; disabled tracks are skipped by the evaluator. */
  enabled: boolean;
  /** Keys sorted by time (normalization enforces the order). */
  keys: PropertyKeyframe[];
}

export interface AudioKeyframe {
  time: number;
  /** res:// path of the audio asset to play. */
  audioPath: string;
  /** 0..1, default 1. */
  volume: number;
}

export interface AudioTrack {
  id: string;
  kind: 'audio';
  /** Display label. */
  name: string;
  enabled: boolean;
  keys: AudioKeyframe[];
}

export interface EventKeyframe {
  time: number;
  /** Signal name emitted on the target node when the playhead crosses this key. */
  signal: string;
  /**
   * Raw argument string, parsed at fire time (see `parseEventArgs`):
   * empty → no args, JSON array → spread, JSON scalar → single arg,
   * unparseable → the raw string as a single arg.
   */
  args: string;
}

export interface EventTrack {
  id: string;
  kind: 'event';
  /** Display label. */
  name: string;
  /**
   * Relative name path from the host node ('' or '.' = the host itself,
   * otherwise 'Child/GrandChild' with NodeBase.findByPath semantics). The
   * signal is emitted on the resolved node.
   */
  targetPath: string;
  enabled: boolean;
  keys: EventKeyframe[];
}

export type ClipTrack = PropertyTrack | AudioTrack | EventTrack;

export interface KeyframeClip {
  /** Unique within the animation set. */
  name: string;
  /** Seconds, > 0. Keys past the duration are preserved; playback clamps. */
  duration: number;
  loop: boolean;
  tracks: ClipTrack[];
}

export interface KeyframeAnimationSet {
  version: string;
  clips: KeyframeClip[];
}

export const MIN_CLIP_DURATION = 0.01;
export const DEFAULT_CLIP_DURATION = 1;

const TRACK_VALUE_TYPES: readonly TrackValueType[] = [
  'number',
  'vector2',
  'vector3',
  'euler',
  'color',
  'boolean',
  'string',
];

export function isTrackValueType(value: unknown): value is TrackValueType {
  return typeof value === 'string' && (TRACK_VALUE_TYPES as readonly string[]).includes(value);
}

export function generateTrackId(): string {
  return `track-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toTrimmedString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function coerceColor(value: unknown): string {
  if (typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  return '#ffffff';
}

function coerceVector(value: unknown, size: 2): [number, number];
function coerceVector(value: unknown, size: 3): [number, number, number];
function coerceVector(value: unknown, size: 2 | 3): number[] {
  const source = Array.isArray(value) ? value : [];
  const result: number[] = [];
  for (let i = 0; i < size; i += 1) {
    result.push(toFiniteNumber(source[i], 0));
  }
  return result;
}

/** Coerce an arbitrary value into the storage shape for the given track type. */
export function coerceKeyframeValue(valueType: TrackValueType, value: unknown): KeyframeValue {
  switch (valueType) {
    case 'number':
      return toFiniteNumber(value, 0);
    case 'boolean':
      return toBoolean(value, false);
    case 'string':
      return typeof value === 'string' ? value : String(value ?? '');
    case 'color':
      return coerceColor(value);
    case 'vector2':
      return coerceVector(value, 2);
    case 'vector3':
    case 'euler':
      return coerceVector(value, 3);
  }
}

function normalizePropertyKeyframe(raw: unknown, valueType: TrackValueType): PropertyKeyframe {
  const candidate = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const easing = candidate.easing;
  return {
    time: Math.max(0, toFiniteNumber(candidate.time, 0)),
    value: coerceKeyframeValue(valueType, candidate.value),
    easing: isKeyframeEasing(easing) ? easing : 'linear',
  };
}

function normalizeAudioKeyframe(raw: unknown): AudioKeyframe {
  const candidate = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    time: Math.max(0, toFiniteNumber(candidate.time, 0)),
    audioPath: toTrimmedString(candidate.audioPath, ''),
    volume: Math.min(1, Math.max(0, toFiniteNumber(candidate.volume, 1))),
  };
}

function normalizeEventKeyframe(raw: unknown): EventKeyframe {
  const candidate = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    time: Math.max(0, toFiniteNumber(candidate.time, 0)),
    signal: toTrimmedString(candidate.signal, ''),
    args: typeof candidate.args === 'string' ? candidate.args : '',
  };
}

function normalizeTrack(raw: unknown, usedIds: Set<string>): ClipTrack | null {
  const candidate = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  let id = toTrimmedString(candidate.id, '');
  if (id.length === 0 || usedIds.has(id)) {
    id = generateTrackId();
  }
  usedIds.add(id);

  const enabled = toBoolean(candidate.enabled, true);
  const rawKeys = Array.isArray(candidate.keys) ? candidate.keys : [];

  if (candidate.kind === 'audio') {
    const keys = rawKeys.map(normalizeAudioKeyframe).filter(key => key.audioPath.length > 0);
    keys.sort((a, b) => a.time - b.time);
    return {
      id,
      kind: 'audio',
      name: toTrimmedString(candidate.name, 'Audio'),
      enabled,
      keys,
    };
  }

  if (candidate.kind === 'event') {
    const keys = rawKeys.map(normalizeEventKeyframe).filter(key => key.signal.length > 0);
    keys.sort((a, b) => a.time - b.time);
    const targetPathRaw =
      typeof candidate.targetPath === 'string' ? candidate.targetPath.trim() : '';
    return {
      id,
      kind: 'event',
      name: toTrimmedString(candidate.name, 'Events'),
      targetPath: targetPathRaw === '.' ? '' : targetPathRaw,
      enabled,
      keys,
    };
  }

  const property = toTrimmedString(candidate.property, '');
  if (property.length === 0) {
    return null;
  }

  const valueType = isTrackValueType(candidate.valueType) ? candidate.valueType : 'number';
  const targetPathRaw = typeof candidate.targetPath === 'string' ? candidate.targetPath.trim() : '';
  const keys = rawKeys.map(key => normalizePropertyKeyframe(key, valueType));
  keys.sort((a, b) => a.time - b.time);

  return {
    id,
    kind: 'property',
    targetPath: targetPathRaw === '.' ? '' : targetPathRaw,
    property,
    valueType,
    enabled,
    keys,
  };
}

function normalizeClip(raw: unknown, index: number, usedNames: Set<string>): KeyframeClip {
  const candidate = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  let name = toTrimmedString(candidate.name, `clip-${index + 1}`);
  if (usedNames.has(name)) {
    let suffix = 2;
    while (usedNames.has(`${name}-${suffix}`)) {
      suffix += 1;
    }
    name = `${name}-${suffix}`;
  }
  usedNames.add(name);

  const usedTrackIds = new Set<string>();
  const rawTracks = Array.isArray(candidate.tracks) ? candidate.tracks : [];
  const tracks = rawTracks
    .map(track => normalizeTrack(track, usedTrackIds))
    .filter((track): track is ClipTrack => track !== null);

  return {
    name,
    duration: Math.max(
      MIN_CLIP_DURATION,
      toFiniteNumber(candidate.duration, DEFAULT_CLIP_DURATION)
    ),
    loop: toBoolean(candidate.loop, false),
    tracks,
  };
}

/**
 * Defensively normalize arbitrary data into a valid `KeyframeAnimationSet`.
 * Invalid tracks are dropped, keys are sorted by time, values are coerced to
 * their track's value type, and clip names / track ids are made unique.
 */
export function normalizeKeyframeAnimationSet(value: unknown): KeyframeAnimationSet {
  const candidate =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const rawClips = Array.isArray(candidate.clips) ? candidate.clips : [];
  const usedNames = new Set<string>();

  return {
    version: toTrimmedString(candidate.version, '1.0.0'),
    clips: rawClips.map((clip, index) => normalizeClip(clip, index, usedNames)),
  };
}

export function createEmptyAnimationSet(): KeyframeAnimationSet {
  return { version: '1.0.0', clips: [] };
}

export function createDefaultClip(name: string): KeyframeClip {
  return {
    name,
    duration: DEFAULT_CLIP_DURATION,
    loop: false,
    tracks: [],
  };
}

export function findKeyframeClip(
  set: KeyframeAnimationSet | null | undefined,
  clipName: string | null | undefined
): KeyframeClip | null {
  if (!set || set.clips.length === 0) {
    return null;
  }
  if (!clipName) {
    return set.clips[0] ?? null;
  }
  return set.clips.find(clip => clip.name === clipName) ?? null;
}
