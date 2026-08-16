// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  assertProductionConfig,
  checkProductionConfig,
  ConfigPreflightError,
  DEFAULT_JWT_SECRET,
  MIN_SECRET_BYTES,
} from './config-preflight.js';

/**
 * The production secret gate.
 *
 * The cases that matter are the ones an operator actually produces: a `.env` that was never filled
 * in, one copied from the README, one with a short hand-typed value, and a correct one. Development
 * is asserted separately because the fallback there is deliberate — a check that failed locally
 * would just get worked around.
 */

const STRONG = 'a'.repeat(MIN_SECRET_BYTES);

describe('checkProductionConfig', () => {
  it('passes anything outside production, including the default secret', () => {
    expect(checkProductionConfig({ NODE_ENV: 'development' })).toEqual([]);
    expect(
      checkProductionConfig({ NODE_ENV: 'development', JWT_SECRET: DEFAULT_JWT_SECRET })
    ).toEqual([]);
    expect(checkProductionConfig({ NODE_ENV: 'test', JWT_SECRET: 'short' })).toEqual([]);
    expect(checkProductionConfig({})).toEqual([]);
  });

  it('rejects a missing or blank JWT_SECRET in production', () => {
    expect(checkProductionConfig({ NODE_ENV: 'production' })).toEqual(['JWT_SECRET is not set.']);
    expect(checkProductionConfig({ NODE_ENV: 'production', JWT_SECRET: '   ' })).toEqual([
      'JWT_SECRET is not set.',
    ]);
  });

  it('rejects the published development default in production', () => {
    expect(
      checkProductionConfig({ NODE_ENV: 'production', JWT_SECRET: DEFAULT_JWT_SECRET })
    ).toEqual([`JWT_SECRET is still the development default ("${DEFAULT_JWT_SECRET}").`]);
  });

  it('rejects a secret under the byte floor and reports its actual size', () => {
    const short = 'x'.repeat(MIN_SECRET_BYTES - 1);
    expect(checkProductionConfig({ NODE_ENV: 'production', JWT_SECRET: short })).toEqual([
      `JWT_SECRET is ${MIN_SECRET_BYTES - 1} bytes; at least ${MIN_SECRET_BYTES} are required.`,
    ]);
  });

  it('measures bytes, not characters — multi-byte secrets are not over-credited', () => {
    // 20 code points, 60 UTF-8 bytes: long enough. 10 code points, 30 bytes: not.
    expect(checkProductionConfig({ NODE_ENV: 'production', JWT_SECRET: 'ф'.repeat(20) })).toEqual(
      []
    );
    expect(checkProductionConfig({ NODE_ENV: 'production', JWT_SECRET: 'ф'.repeat(10) })).toEqual([
      `JWT_SECRET is 20 bytes; at least ${MIN_SECRET_BYTES} are required.`,
    ]);
  });

  it('accepts a strong secret', () => {
    expect(checkProductionConfig({ NODE_ENV: 'production', JWT_SECRET: STRONG })).toEqual([]);
  });

  it('ignores ROOMS_JWT_SECRET when it is not overridden', () => {
    // Unset, it resolves to JWT_SECRET, which was already ruled on.
    expect(checkProductionConfig({ NODE_ENV: 'production', JWT_SECRET: STRONG })).toEqual([]);
  });

  it('checks ROOMS_JWT_SECRET separately once it is set', () => {
    expect(
      checkProductionConfig({
        NODE_ENV: 'production',
        JWT_SECRET: STRONG,
        ROOMS_JWT_SECRET: 'too-short',
      })
    ).toEqual([`ROOMS_JWT_SECRET is 9 bytes; at least ${MIN_SECRET_BYTES} are required.`]);

    expect(
      checkProductionConfig({
        NODE_ENV: 'production',
        JWT_SECRET: STRONG,
        ROOMS_JWT_SECRET: '',
      })
    ).toEqual(['ROOMS_JWT_SECRET is not set.']);
  });

  it('reports every problem at once, so one restart surfaces the whole fix', () => {
    expect(
      checkProductionConfig({
        NODE_ENV: 'production',
        JWT_SECRET: DEFAULT_JWT_SECRET,
        ROOMS_JWT_SECRET: 'nope',
      })
    ).toHaveLength(2);
  });
});

describe('assertProductionConfig', () => {
  it('throws with every problem attached', () => {
    let caught: unknown;
    try {
      assertProductionConfig({ NODE_ENV: 'production', JWT_SECRET: DEFAULT_JWT_SECRET });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigPreflightError);
    expect((caught as ConfigPreflightError).problems).toHaveLength(1);
    expect((caught as Error).message).toContain('Refusing to start');
    // The message must name the variable — it is the whole remediation.
    expect((caught as Error).message).toContain('JWT_SECRET');
  });

  it('returns quietly when the environment is safe', () => {
    expect(() =>
      assertProductionConfig({ NODE_ENV: 'production', JWT_SECRET: STRONG })
    ).not.toThrow();
    expect(() => assertProductionConfig({ NODE_ENV: 'development' })).not.toThrow();
  });
});
