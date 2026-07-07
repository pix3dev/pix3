/**
 * Pure editing helpers for keyframe animation sets.
 *
 * These functions mutate a draft `KeyframeAnimationSet` in place and are meant
 * to be used inside `UpdateAnimationPlayerClipsOperation` updater closures
 * (the operation clones the current set before invoking the updater and
 * normalizes the result afterwards).
 */

import {
  createDefaultClip,
  findKeyframeClip,
  generateTrackId,
  MIN_CLIP_DURATION,
  type AudioTrack,
  type ClipTrack,
  type EventTrack,
  type KeyframeAnimationSet,
  type KeyframeClip,
  type KeyframeEasing,
  type KeyframeValue,
  type PropertyTrack,
  type TrackValueType,
} from '@pix3/runtime';

/** Two key times within this distance are treated as the same key. */
export const KEY_TIME_EPSILON = 1e-4;

function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) < KEY_TIME_EPSILON;
}

function sortKeysInPlace(track: ClipTrack): void {
  (track.keys as Array<{ time: number }>).sort((a, b) => a.time - b.time);
}

export function uniqueClipName(set: KeyframeAnimationSet, base: string): string {
  const trimmed = base.trim() || 'clip';
  if (!set.clips.some(clip => clip.name === trimmed)) {
    return trimmed;
  }
  let suffix = 2;
  while (set.clips.some(clip => clip.name === `${trimmed}-${suffix}`)) {
    suffix += 1;
  }
  return `${trimmed}-${suffix}`;
}

export function addClip(set: KeyframeAnimationSet, name = 'new-clip'): KeyframeClip {
  const clip = createDefaultClip(uniqueClipName(set, name));
  set.clips.push(clip);
  return clip;
}

export function renameClip(set: KeyframeAnimationSet, oldName: string, newName: string): boolean {
  const clip = findKeyframeClip(set, oldName);
  const trimmed = newName.trim();
  if (!clip || trimmed.length === 0 || clip.name === trimmed) {
    return false;
  }
  if (set.clips.some(other => other !== clip && other.name === trimmed)) {
    return false;
  }
  clip.name = trimmed;
  return true;
}

export function duplicateClip(set: KeyframeAnimationSet, name: string): KeyframeClip | null {
  const clip = findKeyframeClip(set, name);
  if (!clip) {
    return null;
  }
  const copy = structuredClone(clip);
  copy.name = uniqueClipName(set, clip.name);
  for (const track of copy.tracks) {
    track.id = generateTrackId();
  }
  set.clips.push(copy);
  return copy;
}

export function deleteClip(set: KeyframeAnimationSet, name: string): boolean {
  const index = set.clips.findIndex(clip => clip.name === name);
  if (index < 0) {
    return false;
  }
  set.clips.splice(index, 1);
  return true;
}

export function findTrack(clip: KeyframeClip, trackId: string): ClipTrack | null {
  return clip.tracks.find(track => track.id === trackId) ?? null;
}

export interface AddPropertyTrackParams {
  targetPath: string;
  property: string;
  valueType: TrackValueType;
  /** Seed key value at t=0 (usually the node's current value). */
  initialValue?: KeyframeValue;
}

/**
 * Add a property track. Returns null when a track for the same
 * targetPath+property pair already exists.
 */
export function addPropertyTrack(
  clip: KeyframeClip,
  params: AddPropertyTrackParams
): PropertyTrack | null {
  const targetPath = params.targetPath.trim() === '.' ? '' : params.targetPath.trim();
  const duplicate = clip.tracks.some(
    track =>
      track.kind === 'property' &&
      track.targetPath === targetPath &&
      track.property === params.property
  );
  if (duplicate) {
    return null;
  }

  const track: PropertyTrack = {
    id: generateTrackId(),
    kind: 'property',
    targetPath,
    property: params.property,
    valueType: params.valueType,
    enabled: true,
    keys:
      params.initialValue !== undefined
        ? [{ time: 0, value: params.initialValue, easing: 'linear' }]
        : [],
  };
  clip.tracks.push(track);
  return track;
}

export function addAudioTrack(clip: KeyframeClip, name = 'Audio'): AudioTrack {
  const track: AudioTrack = {
    id: generateTrackId(),
    kind: 'audio',
    name,
    enabled: true,
    keys: [],
  };
  clip.tracks.push(track);
  return track;
}

export function addEventTrack(clip: KeyframeClip, name = 'Events'): EventTrack {
  const track: EventTrack = {
    id: generateTrackId(),
    kind: 'event',
    name,
    targetPath: '',
    enabled: true,
    keys: [],
  };
  clip.tracks.push(track);
  return track;
}

export function removeTrack(clip: KeyframeClip, trackId: string): boolean {
  const index = clip.tracks.findIndex(track => track.id === trackId);
  if (index < 0) {
    return false;
  }
  clip.tracks.splice(index, 1);
  return true;
}

export function setTrackEnabled(clip: KeyframeClip, trackId: string, enabled: boolean): boolean {
  const track = findTrack(clip, trackId);
  if (!track) {
    return false;
  }
  track.enabled = enabled;
  return true;
}

/** Insert or replace (within epsilon) a property key. Keeps keys sorted. */
export function upsertKey(
  track: PropertyTrack,
  time: number,
  value: KeyframeValue,
  easing: KeyframeEasing = 'linear'
): void {
  const clamped = Math.max(0, time);
  const existing = track.keys.find(key => sameTime(key.time, clamped));
  if (existing) {
    existing.value = value;
    existing.easing = easing;
    return;
  }
  track.keys.push({ time: clamped, value, easing });
  sortKeysInPlace(track);
}

/** Insert or replace (within epsilon) an audio key. Keeps keys sorted. */
export function upsertAudioKey(
  track: AudioTrack,
  time: number,
  audioPath: string,
  volume = 1
): void {
  const clamped = Math.max(0, time);
  const existing = track.keys.find(key => sameTime(key.time, clamped));
  if (existing) {
    existing.audioPath = audioPath;
    existing.volume = volume;
    return;
  }
  track.keys.push({ time: clamped, audioPath, volume });
  sortKeysInPlace(track);
}

/** Insert or replace (within epsilon) an event key. Keeps keys sorted. */
export function upsertEventKey(track: EventTrack, time: number, signal: string, args = ''): void {
  const clamped = Math.max(0, time);
  const existing = track.keys.find(key => sameTime(key.time, clamped));
  if (existing) {
    existing.signal = signal;
    existing.args = args;
    return;
  }
  track.keys.push({ time: clamped, signal, args });
  sortKeysInPlace(track);
}

/**
 * Shift the keys at the given times by delta (clamped to [0, maxTime]).
 * Unselected keys colliding with a moved key (within epsilon) are replaced.
 * Returns the new times in the same order as the input.
 */
export function moveKeys(
  track: ClipTrack,
  times: number[],
  delta: number,
  maxTime = Number.POSITIVE_INFINITY
): number[] {
  const keys = track.keys as Array<{ time: number }>;
  const moving = new Set<{ time: number }>();
  const newTimes: number[] = [];

  for (const time of times) {
    const key = keys.find(candidate => !moving.has(candidate) && sameTime(candidate.time, time));
    if (!key) {
      newTimes.push(time);
      continue;
    }
    moving.add(key);
    newTimes.push(Math.min(Math.max(0, key.time + delta), maxTime));
  }

  let index = 0;
  for (const key of moving) {
    key.time = newTimes[index];
    index += 1;
  }

  // Drop non-moved keys that now collide with a moved key.
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    const key = keys[i];
    if (moving.has(key)) {
      continue;
    }
    const collides = [...moving].some(moved => sameTime(moved.time, key.time));
    if (collides) {
      keys.splice(i, 1);
    }
  }

  sortKeysInPlace(track);
  return newTimes;
}

export function deleteKeys(track: ClipTrack, times: number[]): number {
  const keys = track.keys as Array<{ time: number }>;
  let removed = 0;
  for (const time of times) {
    const index = keys.findIndex(key => sameTime(key.time, time));
    if (index >= 0) {
      keys.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

export function setKeyEasing(track: PropertyTrack, time: number, easing: KeyframeEasing): boolean {
  const key = track.keys.find(candidate => sameTime(candidate.time, time));
  if (!key) {
    return false;
  }
  key.easing = easing;
  return true;
}

export function setKeyValue(track: PropertyTrack, time: number, value: KeyframeValue): boolean {
  const key = track.keys.find(candidate => sameTime(candidate.time, time));
  if (!key) {
    return false;
  }
  key.value = value;
  return true;
}

export function setClipDuration(clip: KeyframeClip, duration: number): void {
  clip.duration = Math.max(MIN_CLIP_DURATION, duration);
}

export function setClipLoop(clip: KeyframeClip, loop: boolean): void {
  clip.loop = loop;
}
