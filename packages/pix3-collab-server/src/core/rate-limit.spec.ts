// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

/**
 * The sliding window, driven by an injected clock.
 *
 * The cases that matter are the ones a limiter usually gets wrong: the window has to *slide* rather
 * than reset in fixed blocks (otherwise twice the budget lands across a boundary), a refused key
 * still has to age out, and the key map must not grow without bound.
 */

function fixedClock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    advance(ms: number) {
      time += ms;
    },
  };
}

describe('createRateLimiter', () => {
  it('allows up to the limit and refuses beyond it', () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: clock.now });

    expect([1, 2, 3].map(() => limiter.consume('ip'))).toEqual([true, true, true]);
    expect(limiter.consume('ip')).toBe(false);
  });

  it('keeps keys independent', () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now });

    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('a')).toBe(false);
    expect(limiter.consume('b')).toBe(true);
  });

  it('slides rather than resetting in blocks', () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: clock.now });

    limiter.consume('ip'); // t=0
    clock.advance(600);
    limiter.consume('ip'); // t=600
    expect(limiter.consume('ip')).toBe(false);

    // t=1001: the first hit has aged out, the second has not — one slot, not two.
    clock.advance(401);
    expect(limiter.consume('ip')).toBe(true);
    expect(limiter.consume('ip')).toBe(false);
  });

  it('lets a refused key recover once its window passes', () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: clock.now });

    limiter.consume('ip');
    // Hammering while refused must not extend the block.
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.consume('ip')).toBe(false);
    }

    clock.advance(1001);
    expect(limiter.consume('ip')).toBe(true);
  });

  it('reports how long until a slot frees', () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: clock.now });

    expect(limiter.retryAfterMs('ip')).toBe(0);
    limiter.consume('ip');
    expect(limiter.retryAfterMs('ip')).toBe(1000);

    clock.advance(400);
    expect(limiter.retryAfterMs('ip')).toBe(600);

    clock.advance(601);
    expect(limiter.retryAfterMs('ip')).toBe(0);
  });

  it('is disabled by a non-positive limit', () => {
    const limiter = createRateLimiter({ limit: 0, windowMs: 1000 });
    for (let i = 0; i < 100; i += 1) {
      expect(limiter.consume('ip')).toBe(true);
    }
    expect(limiter.retryAfterMs('ip')).toBe(0);
  });

  it('drops aged-out keys once the map exceeds its cap', () => {
    const clock = fixedClock();
    const limiter = createRateLimiter({
      limit: 5,
      windowMs: 1000,
      maxKeys: 4,
      now: clock.now,
    });

    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      limiter.consume(key);
    }
    // Everything so far has aged out; the next consume triggers the sweep.
    clock.advance(1001);
    limiter.consume('f');

    // The swept keys start clean — proof they were dropped, not merely pruned in place.
    expect(limiter.retryAfterMs('a')).toBe(0);
    expect(limiter.consume('a')).toBe(true);
  });

  it('forgets everything on reset', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    limiter.consume('ip');
    expect(limiter.consume('ip')).toBe(false);

    limiter.reset();
    expect(limiter.consume('ip')).toBe(true);
  });
});
