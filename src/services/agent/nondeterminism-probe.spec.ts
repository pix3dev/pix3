import { describe, expect, it } from 'vitest';

import {
  installNondeterminismProbe,
  type ProbeTarget,
} from '@/services/agent/nondeterminism-probe';

/**
 * The probe is what makes a trace's replay honest, so these cases are about the
 * three claims it makes: it counts only what runs inside a tick, it subtracts
 * the engine's constant clock floor before blaming the game, and it always comes
 * back off — including when the run throws.
 */

function makeTarget(): ProbeTarget {
  return {
    Math: { random: () => 0.42 },
    Date: { now: () => 1_700_000_000_000 },
    performance: { now: () => 123.5 },
    setTimeout: () => 7,
  };
}

describe('NondeterminismProbe', () => {
  it('counts only calls made inside a tick window', () => {
    const target = makeTarget();
    const probe = installNondeterminismProbe(target);

    // Harness-side call: outside beginTick/endTick, must not be counted.
    target.Math.random();

    probe.beginTick();
    target.Math.random();
    target.Math.random();
    probe.endTick();

    // And another harness-side one after the tick.
    target.Math.random();

    probe.dispose();
    const report = probe.report();
    expect(report.calls['Math.random']).toBe(2);
    expect(report.attributed['Math.random']).toBe(2);
    expect(report.dirty).toBe(true);
  });

  it('passes values, arguments and `this` through unchanged', () => {
    const target = makeTarget();
    const calls: unknown[][] = [];
    target.setTimeout = (...args: unknown[]) => {
      calls.push(args);
      return 99;
    };
    const probe = installNondeterminismProbe(target);
    probe.beginTick();
    const handler = (): void => {};
    expect(target.Math.random()).toBe(0.42);
    expect(target.Date.now()).toBe(1_700_000_000_000);
    expect(target.performance?.now()).toBe(123.5);
    expect(target.setTimeout(handler, 5, 'a')).toBe(99);
    probe.endTick();
    probe.dispose();
    expect(calls).toEqual([[handler, 5, 'a']]);
  });

  it('subtracts the engine clock floor and attributes only the excess', () => {
    const target = makeTarget();
    const probe = installNondeterminismProbe(target);
    // Two ticks where only the "engine" reads the clock twice…
    for (let tick = 0; tick < 2; tick += 1) {
      probe.beginTick();
      target.performance?.now();
      target.performance?.now();
      probe.endTick();
    }
    // …and one where the "game" reads it a third time.
    probe.beginTick();
    target.performance?.now();
    target.performance?.now();
    target.performance?.now();
    probe.endTick();
    probe.dispose();

    const report = probe.report();
    expect(report.calls['performance.now']).toBe(7);
    expect(report.floorPerTick['performance.now']).toBe(2);
    expect(report.attributed['performance.now']).toBe(1);
    expect(report.dirty).toBe(true);
    expect(report.notes.join(' ')).toContain('engine itself');
  });

  it('does not flag a run where every clock read is the constant floor', () => {
    const target = makeTarget();
    const probe = installNondeterminismProbe(target);
    for (let tick = 0; tick < 3; tick += 1) {
      probe.beginTick();
      target.performance?.now();
      target.performance?.now();
      probe.endTick();
    }
    probe.dispose();
    const report = probe.report();
    // The documented false negative: a game reading the clock exactly as often
    // as the engine does every tick is indistinguishable from it. The report
    // says so rather than pretending it proved determinism.
    expect(report.attributed['performance.now']).toBeUndefined();
    expect(report.dirty).toBe(false);
    expect(report.notes.join(' ')).toContain('would NOT be flagged');
  });

  it('never blames the game for setTimeout the harness scheduled', () => {
    const target = makeTarget();
    const probe = installNondeterminismProbe(target);
    target.setTimeout(() => {}, 0);
    probe.dispose();
    expect(probe.report().dirty).toBe(false);
  });

  it('restores every original on dispose, and is idempotent', () => {
    const target = makeTarget();
    const before = {
      random: target.Math.random,
      now: target.Date.now,
      perf: target.performance?.now,
      timeout: target.setTimeout,
    };
    const probe = installNondeterminismProbe(target);
    expect(target.Math.random).not.toBe(before.random);

    probe.dispose();
    probe.dispose();

    expect(target.Math.random).toBe(before.random);
    expect(target.Date.now).toBe(before.now);
    expect(target.performance?.now).toBe(before.perf);
    expect(target.setTimeout).toBe(before.timeout);
  });

  it('is removed even when the code between arm and disarm throws', () => {
    const target = makeTarget();
    const original = target.Math.random;
    const probe = installNondeterminismProbe(target);
    expect(() => {
      try {
        probe.beginTick();
        throw new Error('the game exploded mid-tick');
      } finally {
        probe.dispose();
      }
    }).toThrow('the game exploded mid-tick');
    expect(target.Math.random).toBe(original);
    // A wrapper someone captured stays valid but inert: no counting, same value.
    expect(target.Math.random()).toBe(0.42);
  });

  it('leaves a foreign wrapper working and says the slot was taken', () => {
    const target = makeTarget();
    const original = target.Math.random;
    const probe = installNondeterminismProbe(target);
    const ours = target.Math.random;
    let outerCalls = 0;
    const foreign = (): number => {
      outerCalls += 1;
      return ours();
    };
    target.Math.random = foreign;

    probe.dispose();

    const report = probe.report();
    expect(report.notes.join(' ')).toContain('replaced by other code');
    // The slot goes back to the original — a counting shim must never outlive
    // the run — and the foreign wrapper, which captured ours by reference, still
    // works because a disposed wrapper is a pure passthrough.
    expect(target.Math.random).toBe(original);
    expect(foreign()).toBe(0.42);
    expect(outerCalls).toBe(1);
  });
});
