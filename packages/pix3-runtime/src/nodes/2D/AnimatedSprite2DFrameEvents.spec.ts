import { describe, expect, it } from 'vitest';

import { AnimatedSprite2D } from './AnimatedSprite2D';
import { normalizeAnimationResource } from '../../core/AnimationResource';

function makeSprite(): AnimatedSprite2D {
  const sprite = new AnimatedSprite2D({
    id: 's',
    name: 'S',
    currentClip: 'walk',
    isPlaying: true,
  });
  const resource = normalizeAnimationResource({
    version: '1.0.0',
    texturePath: '',
    clips: [
      {
        name: 'walk',
        fps: 10,
        loop: true,
        playbackMode: 'normal',
        frames: [
          { textureIndex: 0 },
          { textureIndex: 1, events: [{ signal: 'footstep', args: '"left"' }] },
          {
            textureIndex: 2,
            events: [
              { signal: 'footstep', args: '"right"' },
              { signal: 'beat', args: '' },
            ],
          },
        ],
      },
    ],
  });
  sprite.setAnimationResource(resource);
  return sprite;
}

describe('AnimatedSprite2D frame events', () => {
  it('emits a frame event when the play-driven advance enters that frame', () => {
    const sprite = makeSprite();
    const calls: unknown[][] = [];
    sprite.connect('footstep', {}, (...args) => calls.push(args));

    sprite.tick(0.1); // frame 0 -> 1
    expect(calls).toEqual([['left']]);

    sprite.tick(0.1); // frame 1 -> 2
    expect(calls).toEqual([['left'], ['right']]);
  });

  it('fires every event on a frame with its parsed args', () => {
    const sprite = makeSprite();
    const beats: unknown[][] = [];
    sprite.connect('beat', {}, (...args) => beats.push(args));

    sprite.tick(0.1); // -> 1 (footstep only)
    sprite.tick(0.1); // -> 2 (footstep + beat with no args)
    expect(beats).toEqual([[]]);
  });

  it('does NOT emit when the frame is changed via the setter (inspector scrub)', () => {
    const sprite = makeSprite();
    const calls: unknown[][] = [];
    sprite.connect('footstep', {}, (...args) => calls.push(args));

    sprite.currentFrame = 1;
    sprite.currentFrame = 2;
    expect(calls).toEqual([]);
  });

  it('does not fire events for frames that have none (e.g. loop back to frame 0)', () => {
    const sprite = makeSprite();
    const calls: unknown[][] = [];
    sprite.connect('footstep', {}, (...args) => calls.push(args));

    sprite.tick(0.1); // -> 1 left
    sprite.tick(0.1); // -> 2 right
    sprite.tick(0.1); // -> 0 (loop, no events)
    expect(calls).toEqual([['left'], ['right']]);
  });
});
