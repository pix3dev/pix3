import { describe, expect, it, vi } from 'vitest';
import { GameTime } from './GameTime';

describe('GameTime', () => {
  it('defaults to normal speed', () => {
    const time = new GameTime();
    expect(time.scale).toBe(1);
    expect(time.isFrozen).toBe(false);
  });

  it('freezes to scale 0 for the hitstop duration in real time', () => {
    const time = new GameTime();
    time.hitstop(100); // 0.1s

    time.advance(0.05);
    expect(time.scale).toBe(0);
    expect(time.isFrozen).toBe(true);

    // Second 0.05s tick drains the remaining freeze; scale returns to base.
    time.advance(0.05);
    expect(time.scale).toBe(1);
    expect(time.isFrozen).toBe(false);
  });

  it('stacks hitstops by taking the longest single request', () => {
    const time = new GameTime();
    time.hitstop(50);
    time.hitstop(120); // longer wins
    time.hitstop(30); // shorter ignored

    time.advance(0.06);
    expect(time.scale).toBe(0); // 0.12 - 0.06 still frozen
    time.advance(0.06);
    expect(time.scale).toBe(1);
  });

  it('snaps the base scale immediately with setScale', () => {
    const time = new GameTime();
    time.setScale(0.5);
    expect(time.scale).toBe(0.5);
  });

  it('blends into a slow-motion target over blendMs', () => {
    const time = new GameTime();
    time.slowMotion(0.2, { blendMs: 100 });

    time.advance(0.05);
    expect(time.scale).toBeCloseTo(0.6, 5); // halfway: 1 + (0.2-1)*0.5

    time.advance(0.05);
    expect(time.scale).toBeCloseTo(0.2, 5);

    // With no duration the slow-mo holds indefinitely.
    time.advance(1);
    expect(time.scale).toBeCloseTo(0.2, 5);
  });

  it('auto-releases slow-motion back to 1 after the hold duration', () => {
    const time = new GameTime();
    time.slowMotion(0.5, { durationMs: 100, blendMs: 0 });

    // blendMs 0 → snaps to target immediately.
    time.advance(0.05);
    expect(time.scale).toBeCloseTo(0.5, 5);

    // Hold elapses (0.1s total), then blend (0ms) back to 1.
    time.advance(0.05);
    expect(time.scale).toBeCloseTo(1, 5);
  });

  it('lets hitstop override an active slow-motion and restores the base after', () => {
    const time = new GameTime();
    time.setScale(0.5);
    time.hitstop(100);

    time.advance(0.05);
    expect(time.scale).toBe(0); // frozen even though base is 0.5

    time.advance(0.06);
    expect(time.scale).toBeCloseTo(0.5, 5); // hitstop expired → back to base
  });

  it('expires even when a script re-arms it every single frame', () => {
    // The `.plans/prompt-to-playable-flow.md` §11.3 report: "hitstop called every frame from
    // onUpdate while an overlap lasts leaves the game frozen". Under the old "longest PENDING
    // freeze" rule this loop never unfroze — and it could not unfreeze itself, because gameplay dt
    // is 0 while frozen, so the overlap that drives the call can never separate.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const time = new GameTime();
    const frame = 1 / 60;
    let movingFrames = 0;

    for (let i = 0; i < 120; i += 1) {
      time.hitstop(50); // same contact, same strength, every frame
      time.advance(frame);
      if (time.scale > 0) movingFrames += 1;
    }

    // A 50 ms freeze costs three 16.7 ms frames, then one frame of gameplay gets through: the game
    // is slowed to a third, not stopped, so the contact can separate and the calls can stop.
    expect(movingFrames).toBeGreaterThanOrEqual(30);

    // And the script is told where the real fix lives — once, not 120 times.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('consecutive frames');
    warn.mockRestore();
  });

  it('does not let a repeat of the same strength postpone the freeze in progress', () => {
    const time = new GameTime();
    time.hitstop(100);

    time.advance(0.05); // 0.05 left
    expect(time.scale).toBe(0);
    time.hitstop(100); // same strength again — must NOT restart the 0.1s window

    time.advance(0.05);
    expect(time.scale).toBe(1);
    expect(time.isFrozen).toBe(false);
  });

  it('still lets a strictly stronger hit extend an active freeze', () => {
    const time = new GameTime();
    time.hitstop(50);
    time.advance(0.04); // 0.01 left

    time.hitstop(120); // stronger: a fresh 0.12s window
    time.advance(0.05);
    expect(time.scale).toBe(0);

    time.advance(0.08);
    expect(time.scale).toBe(1);
  });

  it('freezes again for a later, unrelated hit', () => {
    const time = new GameTime();
    time.hitstop(50);
    time.advance(0.05);
    expect(time.isFrozen).toBe(false);

    time.hitstop(50); // new contact, freeze window starts over
    time.advance(0.02);
    expect(time.scale).toBe(0);
  });

  it('reset clears hitstop and slow-motion', () => {
    const time = new GameTime();
    time.setScale(0.25);
    time.hitstop(500);
    time.advance(0.016);
    expect(time.scale).toBe(0);

    time.reset();
    expect(time.scale).toBe(1);
    expect(time.isFrozen).toBe(false);
  });

  it('keeps baseScale at the slow-mo value while hitstop forces scale to 0', () => {
    const time = new GameTime();
    time.hitstop(100);

    time.advance(0.016);
    // Load-bearing for the audio muffle: a hitstop freezes `scale` but must NOT
    // pull `baseScale` down (otherwise every micro-freeze would pump the filter).
    expect(time.scale).toBe(0);
    expect(time.baseScale).toBe(1);
  });

  it('reports the blended slow-mo value via baseScale, independent of hitstop', () => {
    const time = new GameTime();
    time.slowMotion(0.3, { blendMs: 0 });
    time.advance(0);
    expect(time.baseScale).toBeCloseTo(0.3, 5);

    time.hitstop(100);
    time.advance(0);
    expect(time.scale).toBe(0);
    expect(time.baseScale).toBeCloseTo(0.3, 5);
  });

  it('ignores non-finite / negative inputs', () => {
    const time = new GameTime();
    time.setScale(Number.NaN);
    expect(time.scale).toBe(1); // fallback
    time.setScale(-3);
    expect(time.scale).toBe(1); // negative rejected
    time.advance(Number.NaN); // no throw, no change
    expect(time.scale).toBe(1);
  });
});
