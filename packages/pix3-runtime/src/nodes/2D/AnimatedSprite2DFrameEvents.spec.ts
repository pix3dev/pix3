import { describe, expect, it, vi } from 'vitest';

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

function makeOneShotSprite(): AnimatedSprite2D {
  const sprite = new AnimatedSprite2D({ id: 'b', name: 'B', currentClip: 'burst', isPlaying: true });
  sprite.setAnimationResource(
    normalizeAnimationResource({
      version: '1.0.0',
      texturePath: '',
      clips: [
        {
          name: 'burst',
          fps: 10,
          loop: false,
          playbackMode: 'normal',
          frames: [{ textureIndex: 0 }, { textureIndex: 1 }, { textureIndex: 2 }],
        },
      ],
    })
  );
  return sprite;
}

describe('AnimatedSprite2D animation-finished', () => {
  it('emits animation-finished exactly once, with the clip name, when a non-looping clip ends', () => {
    const sprite = makeOneShotSprite();
    const finished: unknown[][] = [];
    sprite.connect('animation-finished', {}, (...args) => finished.push(args));

    sprite.tick(0.1); // 0 -> 1
    sprite.tick(0.1); // 1 -> 2
    expect(finished).toEqual([]); // not yet — still on the last frame with more to play
    sprite.tick(0.1); // 2 -> stop (last frame), isPlaying flips off
    expect(finished).toEqual([['burst']]);

    // Further ticks after it has stopped do not re-emit.
    sprite.tick(0.1);
    sprite.tick(0.1);
    expect(finished).toEqual([['burst']]);
  });

  it('does NOT emit for a looping clip', () => {
    const sprite = makeSprite(); // walk clip, loop: true
    const finished: unknown[][] = [];
    sprite.connect('animation-finished', {}, (...args) => finished.push(args));

    for (let i = 0; i < 6; i++) sprite.tick(0.1);
    expect(finished).toEqual([]);
  });

  it('freeOnFinish queueFrees the node once when a non-looping clip ends', () => {
    const sprite = makeOneShotSprite();
    sprite.freeOnFinish = true;
    const free = vi.fn();
    sprite.queueFree = free;

    sprite.tick(0.1); // 0 -> 1
    sprite.tick(0.1); // 1 -> 2
    expect(free).not.toHaveBeenCalled();
    sprite.tick(0.1); // stop → free
    expect(free).toHaveBeenCalledTimes(1);

    sprite.tick(0.1); // already stopped — no second free
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('freeOnFinish defaults off — a non-looping clip stays alive on the last frame', () => {
    const sprite = makeOneShotSprite();
    const free = vi.fn();
    sprite.queueFree = free;

    for (let i = 0; i < 5; i++) sprite.tick(0.1);
    expect(free).not.toHaveBeenCalled();
    expect(sprite.currentFrame).toBe(2);
  });
});
