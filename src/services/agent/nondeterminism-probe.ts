/**
 * Honesty mechanism for recorded input traces (§5.2 of
 * `.plans/done/agent-gameplay-testing.md`).
 *
 * A trace replay is **diagnostic, not deterministic**: the game is free to call
 * `Math.random`, read the wall clock, or schedule its own timers, and a fixed
 * time step removes none of that. So the harness measures the thing instead of
 * assuming it — it wraps the four entry points while a run is recording and, if
 * the game used them, marks the trace `nondeterministic: {source: count}`. A
 * clean trace is then compared strictly; a marked one only within thresholds.
 * The point is that the *report* stops promising what the trace cannot deliver.
 *
 * ## What is counted, precisely
 *
 * Counting is **armed only inside a tick** — the recorder calls
 * {@link NondeterminismProbe.beginTick} immediately before `stepFrames(1)` and
 * {@link NondeterminismProbe.endTick} immediately after. Because the loop is
 * synchronous and JavaScript is single-threaded, nothing of the harness or the
 * editor can run between those two calls: their own timers, rAF callbacks and
 * event handlers are queued and only fire once the tick has returned. That
 * separation is structural, not heuristic — harness calls are never counted.
 *
 * What the window **cannot** separate is the engine from the game: both run
 * inside the tick. `SceneRunner.runFrameBody` reads `performance.now()` two to
 * four times per tick unconditionally (logic and render timing), so a raw count
 * would flag every trace ever recorded and the clean/dirty distinction would be
 * worthless. For the two clock sources the probe therefore subtracts a measured
 * **floor**: the minimum number of calls seen in any single tick of the run,
 * times the number of ticks. Only the excess is attributed to the game.
 *
 * The accepted consequence, stated in the report rather than hidden: a game that
 * reads the clock *exactly the same number of times on every single tick* folds
 * into the floor and is not flagged. It is a false negative in the direction of
 * "we did not prove nondeterminism", and it is the price of the clean/dirty
 * distinction being usable at all. `Math.random` and `setTimeout` have no floor
 * subtracted — the engine's tick path calls neither, and a single call to either
 * is a real divergence source.
 *
 * ## Removal is guaranteed, and a leak is inert
 *
 * {@link NondeterminismProbe.dispose} restores every original and is called from
 * the recorder's `finally`, so a throw mid-run cannot leave the wrappers behind.
 * Two further safeties: `dispose` is idempotent, and a disposed probe's wrapper
 * is a **pure passthrough** — it still delegates to the original with the same
 * `this`, arguments and return value, so even a wrapper someone else captured
 * (by wrapping ours) keeps working after the run. The wrappers add a counter
 * increment and nothing else; a game that leans on these functions heavily
 * behaves identically, just as it does under any devtools shim.
 */

export type NondeterminismSource = 'Math.random' | 'Date.now' | 'performance.now' | 'setTimeout';

export const NONDETERMINISM_SOURCES: readonly NondeterminismSource[] = [
  'Math.random',
  'Date.now',
  'performance.now',
  'setTimeout',
];

/**
 * Sources the engine itself reads a constant number of times per tick, so a raw
 * count says nothing. See the module docs for why the floor is subtracted.
 */
const FLOOR_SUBTRACTED: ReadonlySet<NondeterminismSource> = new Set([
  'performance.now',
  'Date.now',
]);

type TimeoutFn = (handler: unknown, timeout?: unknown, ...args: unknown[]) => unknown;

/**
 * The surface the probe patches. Structural on purpose: a spec hands in a plain
 * object with four functions instead of monkey-patching the test runner's own
 * globals, which would make one failing case poison every later test in the file.
 */
export interface ProbeTarget {
  Math: { random(): number };
  Date: { now(): number };
  performance?: { now(): number };
  setTimeout: TimeoutFn;
}

export interface NondeterminismReport {
  /** Ticks the probe was armed for. */
  ticks: number;
  /** Raw calls counted inside tick windows, per source. */
  calls: Partial<Record<NondeterminismSource, number>>;
  /** Per-tick minimum treated as the engine's own floor (clock sources only). */
  floorPerTick: Partial<Record<NondeterminismSource, number>>;
  /** Calls attributed to the game — the numbers that mark a trace. */
  attributed: Partial<Record<NondeterminismSource, number>>;
  /** True when anything was attributed, i.e. the trace cannot be compared strictly. */
  dirty: boolean;
  /** One line each for the caveats above, so the report never implies more than it measured. */
  notes: string[];
}

export class NondeterminismProbe {
  private readonly restores: Array<() => void> = [];
  private readonly totals = new Map<NondeterminismSource, number>();
  private readonly currentTick = new Map<NondeterminismSource, number>();
  private readonly floors = new Map<NondeterminismSource, number>();
  private readonly installNotes: string[] = [];
  private armed = false;
  private disposed = false;
  private ticks = 0;

  constructor(private readonly target: ProbeTarget) {
    this.install();
  }

  /** Arm counting for the tick that is about to run. */
  beginTick(): void {
    if (this.disposed) return;
    this.currentTick.clear();
    this.armed = true;
  }

  /** Disarm and fold this tick's counts into the per-source floor. */
  endTick(): void {
    if (this.disposed) return;
    this.armed = false;
    this.ticks += 1;
    for (const source of NONDETERMINISM_SOURCES) {
      const seen = this.currentTick.get(source) ?? 0;
      const floor = this.floors.get(source);
      this.floors.set(source, floor === undefined ? seen : Math.min(floor, seen));
    }
  }

  /**
   * The measurement. Safe to call after {@link dispose} — and that is the
   * intended order, because dispose is what learns whether the slots were still
   * ours to restore.
   */
  report(): NondeterminismReport {
    const calls: Partial<Record<NondeterminismSource, number>> = {};
    const floorPerTick: Partial<Record<NondeterminismSource, number>> = {};
    const attributed: Partial<Record<NondeterminismSource, number>> = {};
    const notes = [...this.installNotes];

    for (const source of NONDETERMINISM_SOURCES) {
      const total = this.totals.get(source) ?? 0;
      if (total > 0) calls[source] = total;
      const floor = FLOOR_SUBTRACTED.has(source) ? (this.floors.get(source) ?? 0) : 0;
      if (floor > 0) floorPerTick[source] = floor;
      const excess = Math.max(0, total - floor * this.ticks);
      if (excess > 0) attributed[source] = excess;
      if (floor > 0) {
        notes.push(
          `${source} is called ${floor}× on every tick by the engine itself, so only the excess (${excess} of ${total}) is attributed to the game. A game that calls it exactly ${floor}× per tick too would be indistinguishable from that floor and would NOT be flagged.`
        );
      }
    }

    const dirty = Object.keys(attributed).length > 0;
    return { ticks: this.ticks, calls, floorPerTick, attributed, dirty, notes };
  }

  /** Restore every original. Idempotent; the wrappers stay valid but inert. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.armed = false;
    for (const restore of this.restores) restore();
    this.restores.length = 0;
  }

  private count(source: NondeterminismSource): void {
    if (!this.armed || this.disposed) return;
    this.totals.set(source, (this.totals.get(source) ?? 0) + 1);
    this.currentTick.set(source, (this.currentTick.get(source) ?? 0) + 1);
  }

  private install(): void {
    const target = this.target;

    const mathHost = target.Math;
    const originalRandom = mathHost.random;
    const randomWrapper = (): number => {
      this.count('Math.random');
      return originalRandom.call(mathHost);
    };
    mathHost.random = randomWrapper;
    this.pushRestore(
      'Math.random',
      () => mathHost.random === randomWrapper,
      () => {
        mathHost.random = originalRandom;
      }
    );

    const dateHost = target.Date;
    const originalDateNow = dateHost.now;
    const dateNowWrapper = (): number => {
      this.count('Date.now');
      return originalDateNow.call(dateHost);
    };
    dateHost.now = dateNowWrapper;
    this.pushRestore(
      'Date.now',
      () => dateHost.now === dateNowWrapper,
      () => {
        dateHost.now = originalDateNow;
      }
    );

    const perfHost = target.performance;
    if (perfHost && typeof perfHost.now === 'function') {
      const originalPerfNow = perfHost.now;
      const perfNowWrapper = (): number => {
        this.count('performance.now');
        // Bound to the host: an unbound `performance.now` throws "Illegal
        // invocation" in Chromium.
        return originalPerfNow.call(perfHost);
      };
      perfHost.now = perfNowWrapper;
      this.pushRestore(
        'performance.now',
        () => perfHost.now === perfNowWrapper,
        () => {
          perfHost.now = originalPerfNow;
        }
      );
    }

    const originalTimeout = target.setTimeout;
    const timeoutWrapper: TimeoutFn = (handler, timeout, ...args) => {
      this.count('setTimeout');
      return originalTimeout.call(target, handler, timeout, ...args);
    };
    target.setTimeout = timeoutWrapper;
    this.pushRestore(
      'setTimeout',
      () => target.setTimeout === timeoutWrapper,
      () => {
        target.setTimeout = originalTimeout;
      }
    );
  }

  /**
   * Restoring is unconditional even when the slot no longer holds our wrapper:
   * leaving a counting shim installed past the run is the worse failure, and
   * whoever wrapped ours captured it by reference, so their wrapper keeps
   * delegating through a now-inert passthrough. The fact is noted, not silent.
   */
  private pushRestore(
    source: NondeterminismSource,
    stillOurs: () => boolean,
    restore: () => void
  ): void {
    this.restores.push(() => {
      if (!stillOurs()) {
        this.installNotes.push(
          `${source} was replaced by other code during the run; the original was restored anyway and the probe's wrapper is now a pure passthrough. Counts for this source may be incomplete.`
        );
      }
      restore();
    });
  }
}

/**
 * Install the probe on `globalThis` (or on an injected target in specs). The
 * caller MUST dispose it in a `finally`.
 */
export function installNondeterminismProbe(
  target: ProbeTarget = globalThis as unknown as ProbeTarget
): NondeterminismProbe {
  return new NondeterminismProbe(target);
}
