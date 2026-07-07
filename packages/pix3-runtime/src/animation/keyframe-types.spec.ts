import { describe, expect, it } from 'vitest';
import {
  coerceKeyframeValue,
  createDefaultClip,
  findKeyframeClip,
  normalizeKeyframeAnimationSet,
  type PropertyTrack,
} from './keyframe-types';

describe('normalizeKeyframeAnimationSet', () => {
  it('normalizes garbage into a valid empty set', () => {
    expect(normalizeKeyframeAnimationSet(undefined)).toEqual({ version: '1.0.0', clips: [] });
    expect(normalizeKeyframeAnimationSet(42)).toEqual({ version: '1.0.0', clips: [] });
    expect(normalizeKeyframeAnimationSet({ clips: 'nope' })).toEqual({
      version: '1.0.0',
      clips: [],
    });
  });

  it('sorts keys by time and coerces value shapes to the track type', () => {
    const set = normalizeKeyframeAnimationSet({
      clips: [
        {
          name: 'walk',
          duration: 2,
          tracks: [
            {
              id: 't1',
              kind: 'property',
              targetPath: '.',
              property: 'position',
              valueType: 'vector2',
              keys: [
                { time: 1, value: [5, 'x'], easing: 'quadOut' },
                { time: 0, value: [1, 2, 3], easing: 'made-up' },
              ],
            },
          ],
        },
      ],
    });

    const track = set.clips[0].tracks[0] as PropertyTrack;
    expect(track.targetPath).toBe('');
    expect(track.keys.map(k => k.time)).toEqual([0, 1]);
    expect(track.keys[0].value).toEqual([1, 2]);
    expect(track.keys[0].easing).toBe('linear');
    expect(track.keys[1].value).toEqual([5, 0]);
    expect(track.keys[1].easing).toBe('quadOut');
  });

  it('drops property tracks without a property name and audio keys without a path', () => {
    const set = normalizeKeyframeAnimationSet({
      clips: [
        {
          name: 'fx',
          tracks: [
            { kind: 'property', targetPath: 'Child', keys: [] },
            {
              kind: 'audio',
              keys: [
                { time: 0.5, audioPath: 'res://boom.mp3', volume: 3 },
                { time: 1, audioPath: '' },
              ],
            },
          ],
        },
      ],
    });

    expect(set.clips[0].tracks).toHaveLength(1);
    const audio = set.clips[0].tracks[0];
    expect(audio.kind).toBe('audio');
    if (audio.kind === 'audio') {
      expect(audio.keys).toHaveLength(1);
      expect(audio.keys[0].volume).toBe(1);
    }
  });

  it('normalizes event tracks and drops keys without a signal', () => {
    const set = normalizeKeyframeAnimationSet({
      clips: [
        {
          name: 'cue',
          tracks: [
            {
              kind: 'event',
              targetPath: '.',
              keys: [
                { time: 1, signal: 'flash', args: '["white"]' },
                { time: 0, signal: '  ' },
                { time: 0.5, signal: 'boom' },
              ],
            },
          ],
        },
      ],
    });

    expect(set.clips[0].tracks).toHaveLength(1);
    const event = set.clips[0].tracks[0];
    expect(event.kind).toBe('event');
    if (event.kind === 'event') {
      expect(event.name).toBe('Events');
      expect(event.targetPath).toBe('');
      // Empty-signal key dropped, remaining sorted by time.
      expect(event.keys.map(k => k.signal)).toEqual(['boom', 'flash']);
      expect(event.keys[1].args).toBe('["white"]');
      // A missing args field normalizes to an empty string.
      expect(event.keys[0].args).toBe('');
    }
  });

  it('makes duplicate clip names and track ids unique', () => {
    const set = normalizeKeyframeAnimationSet({
      clips: [
        { name: 'idle', tracks: [] },
        { name: 'idle', tracks: [] },
        {
          name: 'run',
          tracks: [
            { id: 'dup', kind: 'audio', keys: [] },
            { id: 'dup', kind: 'audio', keys: [] },
          ],
        },
      ],
    });

    expect(set.clips.map(c => c.name)).toEqual(['idle', 'idle-2', 'run']);
    const [a, b] = set.clips[2].tracks;
    expect(a.id).toBe('dup');
    expect(b.id).not.toBe('dup');
    expect(b.id.length).toBeGreaterThan(0);
  });

  it('clamps duration and key times, keeps keys past duration', () => {
    const set = normalizeKeyframeAnimationSet({
      clips: [
        {
          name: 'clip',
          duration: -5,
          tracks: [
            {
              kind: 'property',
              property: 'opacity',
              valueType: 'number',
              keys: [
                { time: -1, value: 0.5 },
                { time: 99, value: 1 },
              ],
            },
          ],
        },
      ],
    });

    expect(set.clips[0].duration).toBeGreaterThan(0);
    const track = set.clips[0].tracks[0] as PropertyTrack;
    expect(track.keys[0].time).toBe(0);
    expect(track.keys[1].time).toBe(99);
  });
});

describe('coerceKeyframeValue', () => {
  it('coerces per type', () => {
    expect(coerceKeyframeValue('number', '3')).toBe(3);
    expect(coerceKeyframeValue('number', NaN)).toBe(0);
    expect(coerceKeyframeValue('boolean', 'true')).toBe(false);
    expect(coerceKeyframeValue('color', '#ABC')).toBe('#abc');
    expect(coerceKeyframeValue('color', 'red')).toBe('#ffffff');
    expect(coerceKeyframeValue('vector3', [1])).toEqual([1, 0, 0]);
    expect(coerceKeyframeValue('euler', { x: 1 })).toEqual([0, 0, 0]);
  });
});

describe('findKeyframeClip', () => {
  const set = normalizeKeyframeAnimationSet({
    clips: [createDefaultClip('a'), createDefaultClip('b')],
  });

  it('finds by name, defaults to first without a name, and misses explicitly', () => {
    expect(findKeyframeClip(set, 'b')?.name).toBe('b');
    expect(findKeyframeClip(set, null)?.name).toBe('a');
    expect(findKeyframeClip(set, 'zzz')).toBeNull();
    expect(findKeyframeClip(null, 'a')).toBeNull();
  });
});
