import { describe, expect, it } from 'vitest';
import { Node2D } from '../nodes/Node2D';
import {
  applyClipAtTime,
  collectAudioKeysInRange,
  collectEventKeysInRange,
  createClipBindings,
  fireEventKey,
  fromSchemaValue,
  interpolateValue,
  parseEventArgs,
  resolveTrackTarget,
  sampleTrack,
  toSchemaValue,
} from './clip-evaluator';
import {
  normalizeKeyframeAnimationSet,
  type AudioTrack,
  type EventTrack,
  type KeyframeClip,
  type PropertyTrack,
} from './keyframe-types';

function propertyTrack(overrides: Partial<PropertyTrack>): PropertyTrack {
  return {
    id: 'track',
    kind: 'property',
    targetPath: '',
    property: 'opacity',
    valueType: 'number',
    enabled: true,
    keys: [],
    ...overrides,
  };
}

function audioTrack(keys: AudioTrack['keys']): AudioTrack {
  return { id: 'audio', kind: 'audio', name: 'Audio', enabled: true, keys };
}

function eventTrack(keys: EventTrack['keys'], overrides: Partial<EventTrack> = {}): EventTrack {
  return {
    id: 'event',
    kind: 'event',
    name: 'Events',
    targetPath: '',
    enabled: true,
    keys,
    ...overrides,
  };
}

describe('sampleTrack', () => {
  const track = propertyTrack({
    keys: [
      { time: 1, value: 10, easing: 'linear' },
      { time: 3, value: 30, easing: 'linear' },
    ],
  });

  it('returns null for empty tracks', () => {
    expect(sampleTrack(propertyTrack({}), 0)).toBeNull();
  });

  it('holds the first value before the first key and the last after the last key', () => {
    expect(sampleTrack(track, 0)).toBe(10);
    expect(sampleTrack(track, 5)).toBe(30);
  });

  it('interpolates linearly between keys', () => {
    expect(sampleTrack(track, 2)).toBe(20);
  });

  it('applies the left key easing to the segment', () => {
    const eased = propertyTrack({
      keys: [
        { time: 0, value: 0, easing: 'quadIn' },
        { time: 1, value: 100, easing: 'linear' },
      ],
    });
    expect(sampleTrack(eased, 0.5)).toBeCloseTo(25, 6);
  });

  it('holds the left value for step easing and discrete types', () => {
    const step = propertyTrack({
      keys: [
        { time: 0, value: 1, easing: 'step' },
        { time: 1, value: 2, easing: 'linear' },
      ],
    });
    expect(sampleTrack(step, 0.999)).toBe(1);

    const text = propertyTrack({
      valueType: 'string',
      keys: [
        { time: 0, value: 'a', easing: 'linear' },
        { time: 1, value: 'b', easing: 'linear' },
      ],
    });
    expect(sampleTrack(text, 0.5)).toBe('a');
  });
});

describe('interpolateValue', () => {
  it('interpolates vectors componentwise', () => {
    expect(interpolateValue('vector2', [0, 10], [10, 20], 0.5)).toEqual([5, 15]);
    expect(interpolateValue('euler', [0, 0, 0], [0, 90, 0], 0.5)).toEqual([0, 45, 0]);
  });

  it('interpolates colors per sRGB channel', () => {
    expect(interpolateValue('color', '#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(interpolateValue('color', '#ff0000', '#00ff00', 1)).toBe('#00ff00');
  });

  it('falls back to the left color when parsing fails', () => {
    expect(interpolateValue('color', 'oops', '#ffffff', 0.5)).toBe('oops');
  });
});

describe('collectAudioKeysInRange', () => {
  const track = audioTrack([
    { time: 0, audioPath: 'res://a.mp3', volume: 1 },
    { time: 0.5, audioPath: 'res://b.mp3', volume: 1 },
    { time: 1, audioPath: 'res://c.mp3', volume: 1 },
  ]);

  it('uses the (from, to] boundary rule', () => {
    const keys = collectAudioKeysInRange(track, 0, 0.5);
    expect(keys.map(k => k.audioPath)).toEqual(['res://b.mp3']);
  });

  it('includes a key at exactly from with includeStart', () => {
    const keys = collectAudioKeysInRange(track, 0, 0.5, { includeStart: true });
    expect(keys.map(k => k.audioPath)).toEqual(['res://a.mp3', 'res://b.mp3']);
  });

  it('collects across a loop wrap', () => {
    const keys = collectAudioKeysInRange(track, 0.75, 0.25, { wrapDuration: 1 });
    expect(keys.map(k => k.audioPath)).toEqual(['res://a.mp3', 'res://c.mp3']);
  });

  it('skips disabled tracks', () => {
    expect(collectAudioKeysInRange({ ...track, enabled: false }, 0, 1)).toEqual([]);
  });
});

describe('collectEventKeysInRange', () => {
  const track = eventTrack([
    { time: 0, signal: 'a', args: '' },
    { time: 0.5, signal: 'b', args: '' },
    { time: 1, signal: 'c', args: '' },
  ]);

  it('uses the (from, to] boundary rule so keys fire exactly once', () => {
    expect(collectEventKeysInRange(track, 0, 0.5).map(k => k.signal)).toEqual(['b']);
  });

  it('includes a key at exactly from with includeStart', () => {
    expect(collectEventKeysInRange(track, 0, 0.5, { includeStart: true }).map(k => k.signal)).toEqual(
      ['a', 'b']
    );
  });

  it('collects across a loop wrap', () => {
    expect(collectEventKeysInRange(track, 0.75, 0.25, { wrapDuration: 1 }).map(k => k.signal)).toEqual(
      ['a', 'c']
    );
  });

  it('skips disabled tracks', () => {
    expect(collectEventKeysInRange({ ...track, enabled: false }, 0, 1)).toEqual([]);
  });
});

describe('parseEventArgs', () => {
  it('returns no args for empty / whitespace', () => {
    expect(parseEventArgs('')).toEqual([]);
    expect(parseEventArgs('   ')).toEqual([]);
  });

  it('spreads a JSON array into positional args', () => {
    expect(parseEventArgs('["a", 1, true]')).toEqual(['a', 1, true]);
  });

  it('wraps a JSON scalar / object as a single arg', () => {
    expect(parseEventArgs('42')).toEqual([42]);
    expect(parseEventArgs('"hi"')).toEqual(['hi']);
    expect(parseEventArgs('{"x":1}')).toEqual([{ x: 1 }]);
  });

  it('passes unparseable text through as a single trimmed string', () => {
    expect(parseEventArgs('  play_intro  ')).toEqual(['play_intro']);
  });
});

describe('fireEventKey', () => {
  it('emits the signal on the node with parsed args', () => {
    const node = new Node2D({ id: 'n', name: 'N' });
    const received: unknown[][] = [];
    const listener = { onSignal: (...args: unknown[]) => received.push(args) };
    node.connect('boom', listener, listener.onSignal);

    fireEventKey(node, { time: 0, signal: 'boom', args: '[1, "x"]' });
    expect(received).toEqual([[1, 'x']]);
  });

  it('is a no-op for an empty signal name', () => {
    const node = new Node2D({ id: 'n', name: 'N' });
    let calls = 0;
    node.connect('', node, () => {
      calls += 1;
    });
    fireEventKey(node, { time: 0, signal: '', args: '' });
    expect(calls).toBe(0);
  });
});

describe('schema value conversion', () => {
  it('converts storage arrays to schema objects and back', () => {
    expect(toSchemaValue('vector2', [1, 2])).toEqual({ x: 1, y: 2 });
    expect(toSchemaValue('vector3', [1, 2, 3])).toEqual({ x: 1, y: 2, z: 3 });
    expect(toSchemaValue('number', 5)).toBe(5);

    expect(fromSchemaValue('vector2', { x: 1, y: 2 })).toEqual([1, 2]);
    expect(fromSchemaValue('euler', { x: 0, y: 90, z: 0 })).toEqual([0, 90, 0]);
    expect(fromSchemaValue('number', 'nope')).toBeNull();
    expect(fromSchemaValue('vector2', null)).toBeNull();
  });
});

describe('createClipBindings / applyClipAtTime', () => {
  function buildScene(): { host: Node2D; child: Node2D } {
    const host = new Node2D({ id: 'host', name: 'Host' });
    const child = new Node2D({ id: 'child', name: 'Icon' });
    host.adoptChild(child);
    return { host, child };
  }

  function buildClip(tracks: unknown[]): KeyframeClip {
    return normalizeKeyframeAnimationSet({ clips: [{ name: 'clip', duration: 2, tracks }] })
      .clips[0];
  }

  it('resolves the host with an empty path and descendants by name path', () => {
    const { host, child } = buildScene();
    expect(resolveTrackTarget(host, '')).toBe(host);
    expect(resolveTrackTarget(host, '.')).toBe(host);
    expect(resolveTrackTarget(host, 'Icon')).toBe(child);
    expect(resolveTrackTarget(host, 'Missing')).toBeNull();
  });

  it('records missing targets and skips them when applying', () => {
    const { host } = buildScene();
    const clip = buildClip([
      {
        kind: 'property',
        targetPath: 'Missing',
        property: 'opacity',
        valueType: 'number',
        keys: [{ time: 0, value: 0.5 }],
      },
      {
        kind: 'property',
        targetPath: '',
        property: 'nonexistentProp',
        valueType: 'number',
        keys: [{ time: 0, value: 0.5 }],
      },
    ]);

    const binding = createClipBindings(host, clip);
    expect(binding.entries).toHaveLength(0);
    expect(binding.missingTargets).toHaveLength(2);
    expect(() => applyClipAtTime(binding, 1)).not.toThrow();
  });

  it('writes sampled values through the real Node2D schema', () => {
    const { host, child } = buildScene();
    const clip = buildClip([
      {
        kind: 'property',
        targetPath: '',
        property: 'position',
        valueType: 'vector2',
        keys: [
          { time: 0, value: [0, 0], easing: 'linear' },
          { time: 2, value: [100, 50], easing: 'linear' },
        ],
      },
      {
        kind: 'property',
        targetPath: 'Icon',
        property: 'opacity',
        valueType: 'number',
        keys: [
          { time: 0, value: 1, easing: 'linear' },
          { time: 2, value: 0, easing: 'linear' },
        ],
      },
    ]);

    const binding = createClipBindings(host, clip);
    expect(binding.missingTargets).toHaveLength(0);

    applyClipAtTime(binding, 1);
    expect(host.position.x).toBeCloseTo(50, 6);
    expect(host.position.y).toBeCloseTo(25, 6);
    expect(child.opacity).toBeCloseTo(0.5, 6);
  });

  it('resolves event tracks into eventEntries and records missing targets', () => {
    const { host, child } = buildScene();
    const clip = buildClip([
      {
        kind: 'event',
        name: 'Events',
        targetPath: '',
        keys: [{ time: 0, signal: 'started' }],
      },
      {
        kind: 'event',
        name: 'Child events',
        targetPath: 'Icon',
        keys: [{ time: 1, signal: 'hit' }],
      },
      {
        kind: 'event',
        name: 'Broken',
        targetPath: 'Missing',
        keys: [{ time: 0, signal: 'nope' }],
      },
    ]);

    const binding = createClipBindings(host, clip);
    expect(binding.eventEntries).toHaveLength(2);
    expect(binding.eventEntries[0].node).toBe(host);
    expect(binding.eventEntries[1].node).toBe(child);
    expect(binding.missingTargets).toHaveLength(1);
  });

  it('pins the degrees contract: rotation keys are degrees, node stores radians', () => {
    const { host } = buildScene();
    const clip = buildClip([
      {
        kind: 'property',
        targetPath: '',
        property: 'rotation',
        valueType: 'number',
        keys: [
          { time: 0, value: 0, easing: 'linear' },
          { time: 2, value: 90, easing: 'linear' },
        ],
      },
    ]);

    applyClipAtTime(createClipBindings(host, clip), 2);
    expect(host.rotation.z).toBeCloseTo(Math.PI / 2, 6);
  });

  it('skips disabled tracks and clamps time to the clip duration', () => {
    const { host } = buildScene();
    const clip = buildClip([
      {
        kind: 'property',
        targetPath: '',
        property: 'opacity',
        valueType: 'number',
        enabled: false,
        keys: [{ time: 0, value: 0.25 }],
      },
    ]);

    host.opacity = 1;
    applyClipAtTime(createClipBindings(host, clip), 99);
    expect(host.opacity).toBe(1);
  });
});
