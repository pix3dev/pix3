import { describe, expect, it } from 'vitest';
import type { AudioTrack, PropertyKeyframe, PropertyTrack, TrackValueType } from '@pix3/runtime';
import { buildLanePreview } from './timeline-preview';

function propertyTrack(
  valueType: TrackValueType,
  keys: Array<Partial<PropertyKeyframe> & { time: number; value: PropertyKeyframe['value'] }>
): PropertyTrack {
  return {
    id: `track-${valueType}`,
    kind: 'property',
    targetPath: '',
    property: 'p',
    valueType,
    enabled: true,
    keys: keys.map(k => ({ easing: 'linear', ...k })),
  };
}

describe('buildLanePreview', () => {
  it('builds one value curve for a number track', () => {
    const track = propertyTrack('number', [
      { time: 0, value: 0 },
      { time: 1, value: 10, easing: 'cubicOut' },
    ]);
    const preview = buildLanePreview(track, 1, 28, 1.25);
    expect(preview.kind).toBe('curves');
    if (preview.kind === 'curves') {
      expect(preview.paths).toHaveLength(1);
      expect(preview.paths[0].points.length).toBeGreaterThan(0);
    }
  });

  it('builds one curve per component for vector tracks', () => {
    const v2 = propertyTrack('vector2', [
      { time: 0, value: [0, 0] },
      { time: 1, value: [5, 9] },
    ]);
    const v3 = propertyTrack('vector3', [
      { time: 0, value: [0, 0, 0] },
      { time: 1, value: [1, 2, 3] },
    ]);
    const p2 = buildLanePreview(v2, 1, 28, 1);
    const p3 = buildLanePreview(v3, 1, 28, 1);
    expect(p2.kind === 'curves' && p2.paths).toHaveLength(2);
    expect(p3.kind === 'curves' && p3.paths).toHaveLength(3);
  });

  it('handles a constant single-key number track without NaN', () => {
    const track = propertyTrack('number', [{ time: 0.5, value: 4 }]);
    const preview = buildLanePreview(track, 1, 28, 1);
    expect(preview.kind).toBe('curves');
    if (preview.kind === 'curves') {
      expect(preview.paths[0].points).not.toMatch(/NaN/);
    }
  });

  it('returns no curve paths for an empty track', () => {
    const track = propertyTrack('number', []);
    const preview = buildLanePreview(track, 1, 28, 1);
    expect(preview.kind === 'curves' && preview.paths).toHaveLength(0);
  });

  it('builds color segments with leading + trailing solid blocks', () => {
    const track = propertyTrack('color', [
      { time: 0.25, value: '#ff0000' },
      { time: 0.75, value: '#0000ff', easing: 'linear' },
    ]);
    const preview = buildLanePreview(track, 1, 28, 1);
    expect(preview.kind).toBe('color');
    if (preview.kind === 'color') {
      // lead (0..0.25) + middle (0.25..0.75) + tail (0.75..1)
      expect(preview.segments).toHaveLength(3);
      // Every gradient id is unique so lanes/segments don't collide.
      const ids = preview.segments.map(s => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      // Interpolated middle stops must be valid 6-digit hex.
      for (const stop of preview.segments[1].stops) {
        expect(stop.color).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('renders shorthand #rgb colors without producing invalid hex', () => {
    const track = propertyTrack('color', [
      { time: 0, value: '#f00' },
      { time: 1, value: '#00f' },
    ]);
    const preview = buildLanePreview(track, 1, 28, 1);
    if (preview.kind === 'color') {
      for (const seg of preview.segments) {
        for (const stop of seg.stops) {
          expect(stop.color).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it('builds text segments for string tracks', () => {
    const track = propertyTrack('string', [
      { time: 0, value: 'idle' },
      { time: 1, value: 'run' },
    ]);
    const preview = buildLanePreview(track, 1, 28, 1);
    expect(preview.kind).toBe('text');
    if (preview.kind === 'text') {
      expect(preview.segments.map(s => s.text)).toEqual(['idle', 'run']);
    }
  });

  it('shows the basename for audio track keys', () => {
    const track: AudioTrack = {
      id: 'audio-1',
      kind: 'audio',
      name: 'SFX',
      enabled: true,
      keys: [
        { time: 0, audioPath: 'res://sfx/jump.wav', volume: 1 },
        { time: 0.5, audioPath: 'res://music/loop.ogg', volume: 0.8 },
      ],
    };
    const preview = buildLanePreview(track, 1, 28, 1);
    expect(preview.kind).toBe('text');
    if (preview.kind === 'text') {
      expect(preview.segments.map(s => s.text)).toEqual(['jump.wav', 'loop.ogg']);
    }
  });
});
