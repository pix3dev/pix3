// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/**
 * The equal-cost failure path.
 *
 * `comparePasswordAgainstDummy` exists so that "no such user" costs what "wrong password" costs —
 * without it, response time tells an attacker which emails have accounts. This is asserted here,
 * against the bcrypt calls directly, rather than over HTTP: at the low salt-round a test suite can
 * afford, request overhead swamps the difference and an HTTP-level timing assertion passes whether
 * the fix is present or not.
 *
 * Ten rounds — the production default — so the numbers being compared are the real ones.
 */

vi.mock('../../config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { config: { ...actual.config, PASSWORD_SALT_ROUNDS: 10 } };
});

const { comparePassword, comparePasswordAgainstDummy, hashPassword } = await import(
  './password.js'
);

/** Median of several runs: a single sample on a loaded CI box is noise. */
async function medianMs(run: () => Promise<unknown>, samples = 5): Promise<number> {
  const timings: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    await run();
    timings.push(performance.now() - start);
  }
  return timings.sort((a, b) => a - b)[Math.floor(samples / 2)]!;
}

describe('comparePasswordAgainstDummy', () => {
  it('always reports false', async () => {
    await expect(comparePasswordAgainstDummy('anything')).resolves.toBe(false);
    await expect(comparePasswordAgainstDummy('')).resolves.toBe(false);
  });

  it('costs what a real mismatched comparison costs', async () => {
    const hash = await hashPassword('correct horse battery staple');

    // Warm-up: the dummy hash is built lazily on first use, and that one call includes a `hash`.
    await comparePasswordAgainstDummy('warm');

    const real = await medianMs(() => comparePassword('wrong', hash));
    const dummy = await medianMs(() => comparePasswordAgainstDummy('wrong'));

    // Same salt rounds, so the two should be within a small factor. A returning-early
    // implementation lands near zero and fails this by orders of magnitude.
    expect(dummy).toBeGreaterThan(real * 0.5);
    expect(dummy).toBeLessThan(real * 2);
  });
});

describe('hashPassword / comparePassword', () => {
  it('round-trips and rejects a wrong password', async () => {
    const hash = await hashPassword('hunter2');

    await expect(comparePassword('hunter2', hash)).resolves.toBe(true);
    await expect(comparePassword('hunter3', hash)).resolves.toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    expect(await hashPassword('hunter2')).not.toBe(await hashPassword('hunter2'));
  });
});
