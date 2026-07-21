import { describe, expect, it } from 'vitest';

import {
  FrameSequencePlayer,
  type FrameSequenceDescriptor,
} from './FrameSequencePlayer';

// fps 10 → each frame lasts 0.1s. Advancing by 0.1 crosses exactly one boundary.
const linearLoop: FrameSequenceDescriptor = {
  frameCount: 3,
  fps: 10,
  loop: true,
  playbackMode: 'linear',
};

const linearOnce: FrameSequenceDescriptor = {
  frameCount: 3,
  fps: 10,
  loop: false,
  playbackMode: 'linear',
};

const pingPongLoop: FrameSequenceDescriptor = {
  frameCount: 3,
  fps: 10,
  loop: true,
  playbackMode: 'ping-pong',
};

const pingPongOnce: FrameSequenceDescriptor = {
  frameCount: 3,
  fps: 10,
  loop: false,
  playbackMode: 'ping-pong',
};

describe('FrameSequencePlayer', () => {
  it('advances a linear looping sequence and wraps back to 0', () => {
    const player = new FrameSequencePlayer();

    let r = player.advance(0.1, linearLoop, 0);
    expect(r.nextIndex).toBe(1);
    expect(r.framesAdvanced).toEqual([1]);
    expect(r.finished).toBe(false);

    r = player.advance(0.1, linearLoop, 1);
    expect(r.nextIndex).toBe(2);
    expect(r.framesAdvanced).toEqual([2]);

    r = player.advance(0.1, linearLoop, 2);
    expect(r.nextIndex).toBe(0); // wrap
    expect(r.framesAdvanced).toEqual([0]);
    expect(r.finished).toBe(false);
  });

  it('does not advance when accumulated time is below a frame duration', () => {
    const player = new FrameSequencePlayer();
    const r = player.advance(0.05, linearLoop, 0);
    expect(r.nextIndex).toBe(0);
    expect(r.framesAdvanced).toEqual([]);
    expect(r.finished).toBe(false);

    // Second sub-frame step crosses the boundary (0.05 + 0.05 = 0.1).
    const r2 = player.advance(0.05, linearLoop, 0);
    expect(r2.nextIndex).toBe(1);
    expect(r2.framesAdvanced).toEqual([1]);
  });

  it('stops a linear non-looping sequence at the last frame, finished exactly once', () => {
    const player = new FrameSequencePlayer();

    let index = 0;
    let r = player.advance(0.1, linearOnce, index); // 0 -> 1
    index = r.nextIndex;
    expect(index).toBe(1);
    expect(r.finished).toBe(false);

    r = player.advance(0.1, linearOnce, index); // 1 -> 2 (last)
    index = r.nextIndex;
    expect(index).toBe(2);
    expect(r.finished).toBe(false);

    r = player.advance(0.1, linearOnce, index); // attempt past end → finished
    expect(r.nextIndex).toBe(2);
    expect(r.framesAdvanced).toEqual([]);
    expect(r.finished).toBe(true);

    // Latched: subsequent calls report finished=false and do not move.
    r = player.advance(0.1, linearOnce, 2);
    expect(r.nextIndex).toBe(2);
    expect(r.framesAdvanced).toEqual([]);
    expect(r.finished).toBe(false);

    r = player.advance(0.1, linearOnce, 2);
    expect(r.finished).toBe(false);
  });

  it('bounces a ping-pong looping sequence at both ends', () => {
    const player = new FrameSequencePlayer();

    // Up: 0 -> 1 -> 2, then bounce down 2 -> 1 -> 0, then back up.
    const landed: number[] = [];
    let index = 0;
    for (let i = 0; i < 6; i += 1) {
      const r = player.advance(0.1, pingPongLoop, index);
      index = r.nextIndex;
      landed.push(index);
      expect(r.finished).toBe(false);
    }
    // frames: 1,2,(bounce)1,0,(bounce)1,2
    expect(landed).toEqual([1, 2, 1, 0, 1, 2]);
  });

  it('finishes a ping-pong non-looping sequence at the far end', () => {
    const player = new FrameSequencePlayer();

    let index = 0;
    let r = player.advance(0.1, pingPongOnce, index); // 0 -> 1
    index = r.nextIndex;
    expect(index).toBe(1);

    r = player.advance(0.1, pingPongOnce, index); // 1 -> 2 (last)
    index = r.nextIndex;
    expect(index).toBe(2);
    expect(r.finished).toBe(false);

    r = player.advance(0.1, pingPongOnce, index); // attempt past end → finished
    expect(r.nextIndex).toBe(2);
    expect(r.finished).toBe(true);
  });

  it('finishes a ping-pong non-looping sequence bouncing back to the start', () => {
    const player = new FrameSequencePlayer();
    // Force the direction to -1 by bouncing off the far end first via a loop
    // descriptor, then confirm the non-loop start-edge finishes.
    // Simpler: start at index 0 with direction already -1 is not directly
    // settable, so drive from the far end using the loop variant to flip
    // direction, then switch to non-loop.
    let index = 2;
    // First advance under loop from the top to set direction = -1.
    let r = player.advance(0.1, pingPongLoop, index); // 2 -> 1 (direction now -1)
    index = r.nextIndex;
    expect(index).toBe(1);

    r = player.advance(0.1, pingPongOnce, index); // 1 -> 0
    index = r.nextIndex;
    expect(index).toBe(0);
    expect(r.finished).toBe(false);

    r = player.advance(0.1, pingPongOnce, index); // attempt below 0 → finished
    expect(r.nextIndex).toBe(0);
    expect(r.finished).toBe(true);
  });

  it('honors per-frame duration multipliers', () => {
    const player = new FrameSequencePlayer();
    const descriptor: FrameSequenceDescriptor = {
      frameCount: 3,
      fps: 10, // base 0.1s
      loop: true,
      playbackMode: 'linear',
      frameDurationMultiplier: (i) => (i === 0 ? 2 : 1), // frame 0 dwells 0.2s
    };

    // 0.1s is not enough to leave frame 0 (needs 0.2s).
    let r = player.advance(0.1, descriptor, 0);
    expect(r.framesAdvanced).toEqual([]);
    expect(r.nextIndex).toBe(0);

    // Another 0.1s (total 0.2s) crosses frame 0's doubled duration.
    r = player.advance(0.1, descriptor, 0);
    expect(r.nextIndex).toBe(1);
    expect(r.framesAdvanced).toEqual([1]);
  });

  it('catches up multiple frames on a single large dt', () => {
    const player = new FrameSequencePlayer();
    // 0.35s at 0.1s/frame → cross 3 boundaries: 0 -> 1 -> 2 -> 0 (loop).
    const r = player.advance(0.35, linearLoop, 0);
    expect(r.framesAdvanced).toEqual([1, 2, 0]);
    expect(r.nextIndex).toBe(0);
    expect(r.finished).toBe(false);
  });

  it('catch-up on a non-loop sequence lands every frame then finishes once', () => {
    const player = new FrameSequencePlayer();
    // Huge dt: 0 -> 1 -> 2 (last) -> finished, all in one call.
    const r = player.advance(10, linearOnce, 0);
    expect(r.framesAdvanced).toEqual([1, 2]);
    expect(r.nextIndex).toBe(2);
    expect(r.finished).toBe(true);
  });

  it('reset() clears the finished latch and lets the sequence play again', () => {
    const player = new FrameSequencePlayer();
    let r = player.advance(10, linearOnce, 0); // finish
    expect(r.finished).toBe(true);

    r = player.advance(0.1, linearOnce, 2); // latched
    expect(r.finished).toBe(false);
    expect(r.framesAdvanced).toEqual([]);

    player.reset();
    r = player.advance(0.1, linearOnce, 0); // plays from the start again
    expect(r.nextIndex).toBe(1);
    expect(r.framesAdvanced).toEqual([1]);
  });

  it('is a no-op guard-friendly kernel: fps<=0 / frameCount<=1 handled by the caller', () => {
    // The player assumes valid input (nodes guard frameCount<=1 / fps<=0 before
    // calling), but a defensive check: a single-frame linear loop never moves.
    const player = new FrameSequencePlayer();
    const single: FrameSequenceDescriptor = { frameCount: 1, fps: 10, loop: true };
    const r = player.advance(1, single, 0);
    // Linear wrap on frameCount 1: next = 1, not < 1, loop → 0 (same index).
    expect(r.nextIndex).toBe(0);
    expect(r.framesAdvanced).toEqual([]);
    expect(r.finished).toBe(false);
  });
});
