import { describe, expect, it } from 'vitest';

import type { Json } from '@/core/agent-introspection';
import {
  recordTraceRun,
  replayTraceRun,
  type GameRunLoopDeps,
  type GameRunResult,
  type NormalizedRunSpec,
  type TestableRunner,
} from '@/services/agent/GameTestService';
import {
  buildTraceFromRun,
  compareTraceToRun,
  InMemoryTraceStore,
  makeTraceFeeder,
  parseTrace,
  serializeTrace,
  TraceRecorder,
  traceFilePath,
  type GameInputTrace,
  type TraceEnvelope,
  type TraceEvent,
  type TraceEventSource,
  type TraceInputSink,
  type UnstampedTraceEvent,
} from '@/services/agent/game-traces';
import type { ProbeTarget } from '@/services/agent/nondeterminism-probe';

/**
 * Traces, against a fake runner. The cases that matter are the ones the plan
 * calls out: the envelope is written, the probe catches `Math.random` and comes
 * off even on a throw, a marked trace is compared by thresholds while a clean
 * one is compared strictly, and — the whole point of the feature — a replayed
 * event lands **between** two ticks rather than being paced by a wall clock.
 */

interface FakeRunner extends TestableRunner {
  frames: number;
  onTick?: (frame: number) => void;
  /** Throw out of `stepFrames` on this frame (to test cleanup paths). */
  throwOnFrame?: number;
}

function makeRunner(): FakeRunner {
  let mode: 'realtime' | 'fixed' | 'manual' = 'realtime';
  let paused = false;
  const runner: FakeRunner = {
    frames: 0,
    get paused() {
      return paused;
    },
    get running() {
      return true;
    },
    getTimeMode: () => ({
      mode,
      fixedDeltaSec: 1 / 60,
      ticksPerFrame: 1,
      renderEveryNTicks: 1,
      muteAudio: true,
    }),
    setTimeMode: config => {
      mode = config.mode;
    },
    stepFrames: (count = 1) => {
      if (mode !== 'manual' || paused) return 0;
      let executed = 0;
      for (let i = 0; i < count; i += 1) {
        runner.frames += 1;
        if (runner.throwOnFrame === runner.frames) throw new Error('tick exploded');
        executed += 1;
        runner.onTick?.(runner.frames);
      }
      return executed;
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
  };
  return runner;
}

function makeDeps(runner: FakeRunner, over: Partial<GameRunLoopDeps> = {}): GameRunLoopDeps {
  let wall = 0;
  return {
    runner,
    sampleGameState: () => null,
    errorCount: () => 0,
    errorsSince: () => [],
    nodeExists: () => false,
    now: () => (wall += 1),
    yieldToHost: () => Promise.resolve(),
    ...over,
  };
}

function makeSpec(over: Partial<NormalizedRunSpec> = {}): NormalizedRunSpec {
  return {
    until: [{ kind: 'frames', n: 5 }],
    fail: [],
    watch: [],
    maxFrames: 50,
    fixedDeltaSec: 1 / 60,
    maxWallMs: 20_000,
    pauseOnOutcome: false,
    ...over,
  };
}

/** A source a spec drives by hand — no DOM, no canvas box, no listeners. */
class FakeSource implements TraceEventSource {
  emit: ((event: UnstampedTraceEvent) => void) | null = null;
  stopped = false;

  start(emit: (event: UnstampedTraceEvent) => void): void {
    this.emit = emit;
  }

  stop(): void {
    this.stopped = true;
    this.emit = null;
  }
}

function makeEnvelope(over: Partial<TraceEnvelope> = {}): TraceEnvelope {
  return {
    seed: 42,
    fixedDeltaSec: 1 / 60,
    ticksPerFrame: 1,
    runtimeVersion: '1.3.0',
    viewport: { width: 800, height: 600 },
    sceneId: 'scenes/main.pix3scene',
    ...over,
  };
}

function makeResult(over: Partial<GameRunResult> = {}): GameRunResult {
  return {
    ok: true,
    outcome: {
      kind: 'until',
      channel: 'until',
      index: 0,
      frame: 100,
      gameTimeMs: 1666.667,
      assertion: 'gameStateChanged score',
      detail: 'score 0 → 1',
    },
    metrics: { frames: 100, gameTimeMs: 1666.667, wallMs: 200, newErrors: 0, framesPerSecond: 500 },
    game: { provider: 'snake', snapshot: { score: 4, lives: 3, phase: 'play' } as Json },
    ...over,
  };
}

function makeTrace(over: Partial<GameInputTrace> = {}): GameInputTrace {
  return {
    ...buildTraceFromRun({
      name: 'snake-eats',
      env: makeEnvelope(),
      events: [],
      result: makeResult(),
      now: () => new Date('2026-08-14T00:00:00.000Z'),
    }),
    ...over,
  };
}

function makeProbeTarget(): ProbeTarget {
  return {
    Math: { random: () => 0.5 },
    Date: { now: () => 1_700_000_000_000 },
    performance: { now: () => 1 },
    setTimeout: () => 0,
  };
}

describe('trace format and storage', () => {
  it('normalises a name to design/tests/<name>.trace.json', () => {
    expect(traceFilePath('snake eats')).toBe('design/tests/snake-eats.trace.json');
    expect(traceFilePath('design/tests/snake.trace.json')).toBe('design/tests/snake.trace.json');
    expect(traceFilePath('snake.trace.json')).toBe('design/tests/snake.trace.json');
  });

  it('round-trips through JSON and rejects a future format', () => {
    const trace = makeTrace({ events: [{ frame: 3, kind: 'key', phase: 'down', code: 'KeyA' }] });
    const parsed = parseTrace(serializeTrace(trace));
    expect('trace' in parsed && parsed.trace.events[0]).toEqual({
      frame: 3,
      kind: 'key',
      phase: 'down',
      code: 'KeyA',
    });

    const future = parseTrace(JSON.stringify({ ...trace, formatVersion: 99 }));
    expect('error' in future && future.error).toContain('format v99');
  });

  it('refuses a trace whose events are not frame-stamped', () => {
    const broken = parseTrace(
      JSON.stringify({ ...makeTrace(), events: [{ kind: 'key', phase: 'down', code: 'KeyA' }] })
    );
    expect('error' in broken && broken.error).toContain('`frame` must be a number');
  });

  it('stores and loads by path, and reports an unknown path as null', async () => {
    const store = new InMemoryTraceStore();
    await store.save('design/tests/a.trace.json', makeTrace());
    expect((await store.load('design/tests/a.trace.json'))?.name).toBe('snake-eats');
    expect(await store.load('design/tests/missing.trace.json')).toBeNull();
    expect(await store.list()).toEqual(['design/tests/a.trace.json']);
  });
});

describe('TraceRecorder', () => {
  it('stamps events with the frame that was about to run', () => {
    const source = new FakeSource();
    const recorder = new TraceRecorder(source);
    recorder.start();

    recorder.markFrame(1);
    source.emit?.({ kind: 'key', phase: 'down', code: 'ArrowLeft' });
    recorder.markFrame(4);
    source.emit?.({ kind: 'key', phase: 'up', code: 'ArrowLeft' });

    const { events } = recorder.stop();
    expect(events).toEqual([
      { frame: 1, kind: 'key', phase: 'down', code: 'ArrowLeft' },
      { frame: 4, kind: 'key', phase: 'up', code: 'ArrowLeft' },
    ]);
    expect(source.stopped).toBe(true);
  });

  it('collapses pointer moves to the last one per frame and caps the rest', () => {
    const source = new FakeSource();
    const recorder = new TraceRecorder(source, 3);
    recorder.start();
    recorder.markFrame(2);
    source.emit?.({ kind: 'pointer', phase: 'move', nx: 0.1, ny: 0.1, pointerId: 1 });
    source.emit?.({ kind: 'pointer', phase: 'move', nx: 0.2, ny: 0.2, pointerId: 1 });
    source.emit?.({ kind: 'pointer', phase: 'move', nx: 0.3, ny: 0.3, pointerId: 1 });
    recorder.markFrame(3);
    source.emit?.({ kind: 'pointer', phase: 'down', nx: 0.5, ny: 0.5, pointerId: 1 });
    source.emit?.({ kind: 'key', phase: 'down', code: 'Space' });
    source.emit?.({ kind: 'key', phase: 'up', code: 'Space' });

    const { events, dropped } = recorder.stop();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      frame: 2,
      kind: 'pointer',
      phase: 'move',
      nx: 0.3,
      ny: 0.3,
      pointerId: 1,
    });
    expect(dropped).toBe(1);
  });
});

describe('frame-denominated replay', () => {
  it('delivers an event BETWEEN the two ticks it is stamped between', async () => {
    const runner = makeRunner();
    const log: string[] = [];
    runner.onTick = frame => log.push(`tick:${frame}`);
    const sink: TraceInputSink = {
      key: (phase, code) => log.push(`key:${phase}:${code}`),
      pointer: (phase, nx, ny) => log.push(`pointer:${phase}:${nx},${ny}`),
    };
    const trace = makeTrace({
      events: [
        { frame: 3, kind: 'key', phase: 'down', code: 'ArrowLeft' },
        { frame: 5, kind: 'key', phase: 'up', code: 'ArrowLeft' },
      ],
      metrics: { frames: 6, gameTimeMs: 100, newErrors: 0 },
      outcome: { kind: 'until', channel: 'until', index: 0, frame: 6, gameTimeMs: 100 },
    });

    const { result } = await replayTraceRun(
      makeDeps(runner),
      trace,
      makeSpec({ until: [{ kind: 'frames', n: 6 }] }),
      { sink }
    );

    expect(result.outcome?.frame).toBe(6);
    // The whole feature in one assertion: keydown sits after tick 2 and before
    // tick 3, so the game polls it on frame 3. A wall-clock pacer in `'manual'`
    // mode would have put both key events between the same pair of ticks.
    expect(log).toEqual([
      'tick:1',
      'tick:2',
      'key:down:ArrowLeft',
      'tick:3',
      'tick:4',
      'key:up:ArrowLeft',
      'tick:5',
      'tick:6',
    ]);
  });

  it('reports trace events the run ended too early to deliver', async () => {
    const runner = makeRunner();
    const sink: TraceInputSink = { key: () => {}, pointer: () => {} };
    const trace = makeTrace({
      events: [
        { frame: 2, kind: 'key', phase: 'down', code: 'KeyA' },
        { frame: 40, kind: 'key', phase: 'up', code: 'KeyA' },
      ],
    });
    const { comparison } = await replayTraceRun(
      makeDeps(runner),
      trace,
      makeSpec({ until: [{ kind: 'frames', n: 3 }] }),
      { sink, noAssertions: true }
    );
    expect(comparison.notes.join(' ')).toContain('1 trace event(s) still unplayed');
    expect(comparison.notes.join(' ')).toContain('No `until`/`fail` predicates were supplied');
  });

  it('feeds the same events while recording, so the trace holds what was driven', async () => {
    const runner = makeRunner();
    const log: string[] = [];
    runner.onTick = frame => log.push(`tick:${frame}`);
    const source = new FakeSource();
    const feed: TraceEvent[] = [{ frame: 2, kind: 'key', phase: 'down', code: 'KeyD' }];
    const sink: TraceInputSink = {
      // The live sink dispatches into the DOM and the live source hears it back;
      // here the fake closes that loop by hand.
      key: (phase, code) => {
        log.push(`key:${phase}:${code}`);
        source.emit?.({ kind: 'key', phase, code });
      },
      pointer: () => {},
    };

    const { trace } = await recordTraceRun(makeDeps(runner), makeSpec(), {
      name: 'drive-right',
      env: { seed: null, runtimeVersion: '1.3.0', viewport: { width: 4, height: 2 }, sceneId: 's' },
      source,
      sink,
      feed,
      probeTarget: makeProbeTarget(),
    });

    expect(log.slice(0, 3)).toEqual(['tick:1', 'key:down:KeyD', 'tick:2']);
    expect(trace.events).toEqual([{ frame: 2, kind: 'key', phase: 'down', code: 'KeyD' }]);
  });
});

describe('recording a trace', () => {
  it('writes the environment envelope', async () => {
    const runner = makeRunner();
    const { trace } = await recordTraceRun(
      makeDeps(runner, {
        sampleGameState: () => ({ provider: 'snake', snapshot: { score: 2, seed: 7 } as Json }),
      }),
      makeSpec({ fixedDeltaSec: 1 / 30 }),
      {
        name: 'snake-eats',
        env: {
          seed: null,
          runtimeVersion: '1.3.0',
          viewport: { width: 1280, height: 720 },
          sceneId: 'scenes/main.pix3scene',
        },
        source: new FakeSource(),
        probeTarget: makeProbeTarget(),
        now: () => new Date('2026-08-14T10:00:00.000Z'),
      }
    );

    expect(trace.formatVersion).toBe(1);
    expect(trace.recordedAt).toBe('2026-08-14T10:00:00.000Z');
    expect(trace.env).toEqual({
      // The game exposed a seed in its snapshot, so the envelope carries it even
      // though the caller passed none.
      seed: 7,
      fixedDeltaSec: 1 / 30,
      ticksPerFrame: 1,
      runtimeVersion: '1.3.0',
      viewport: { width: 1280, height: 720 },
      sceneId: 'scenes/main.pix3scene',
      gameProvider: 'snake',
    });
    expect(trace.outcome.kind).toBe('until');
    expect(trace.gameState).toMatchObject({ score: 2 });
  });

  it('notes a game that exposes no seed at all', async () => {
    const { trace } = await recordTraceRun(makeDeps(makeRunner()), makeSpec(), {
      name: 'seedless',
      env: {
        seed: null,
        runtimeVersion: '1.3.0',
        viewport: { width: 1, height: 1 },
        sceneId: null,
      },
      source: new FakeSource(),
      probeTarget: makeProbeTarget(),
    });
    expect(trace.env.seed).toBeNull();
    expect(trace.notes?.join(' ')).toContain('exposes no seed');
  });

  it('marks the trace when the game called Math.random during a tick', async () => {
    const runner = makeRunner();
    const target = makeProbeTarget();
    // "Game" code: runs inside the tick, so the probe is armed for it.
    runner.onTick = () => {
      target.Math.random();
    };
    const { trace } = await recordTraceRun(
      makeDeps(runner, {
        // "Harness" code: the loop samples state BETWEEN ticks, so this call
        // must not be counted against the game.
        sampleGameState: () => {
          target.Math.random();
          return null;
        },
      }),
      makeSpec({ until: [{ kind: 'frames', n: 4 }] }),
      {
        name: 'random-game',
        env: {
          seed: null,
          runtimeVersion: '1.3.0',
          viewport: { width: 1, height: 1 },
          sceneId: null,
        },
        source: new FakeSource(),
        probeTarget: target,
      }
    );

    expect(trace.nondeterministic).toEqual({ 'Math.random': 4 });
    expect(trace.determinism?.dirty).toBe(true);
    expect(trace.notes?.join(' ')).toContain('thresholds only');
  });

  it('leaves a clean trace unmarked', async () => {
    const { trace } = await recordTraceRun(makeDeps(makeRunner()), makeSpec(), {
      name: 'pure-game',
      env: { seed: 1, runtimeVersion: '1.3.0', viewport: { width: 1, height: 1 }, sceneId: null },
      source: new FakeSource(),
      probeTarget: makeProbeTarget(),
    });
    expect(trace.nondeterministic).toBeUndefined();
    expect(trace.determinism?.dirty).toBe(false);
  });

  it('uninstalls the probe and the recorder even when a tick throws', async () => {
    const runner = makeRunner();
    runner.throwOnFrame = 2;
    const target = makeProbeTarget();
    const original = target.Math.random;
    const source = new FakeSource();

    await expect(
      recordTraceRun(makeDeps(runner), makeSpec(), {
        name: 'exploding',
        env: {
          seed: null,
          runtimeVersion: '1.3.0',
          viewport: { width: 1, height: 1 },
          sceneId: null,
        },
        source,
        probeTarget: target,
      })
    ).rejects.toThrow('tick exploded');

    expect(target.Math.random).toBe(original);
    expect(source.stopped).toBe(true);
  });
});

describe('comparing a replay against its trace', () => {
  const replayOf = (over: Partial<GameRunResult> = {}): GameRunResult => makeResult(over);

  it('compares a clean trace strictly', () => {
    const trace = makeTrace();
    const exact = compareTraceToRun(trace, replayOf());
    expect(exact.strict).toBe(true);
    expect(exact.matched).toBe(true);
    expect(exact.verdict).toContain('REPLAY MATCH (strict)');

    const oneFrameLate = compareTraceToRun(
      trace,
      replayOf({
        outcome: { ...makeResult().outcome!, frame: 101 },
      })
    );
    expect(oneFrameLate.strict).toBe(true);
    expect(oneFrameLate.matched).toBe(false);
    expect(oneFrameLate.verdict).toContain('REPLAY DIVERGED (strict)');
    expect(oneFrameLate.diffs.find(diff => diff.metric === 'frame')?.delta).toBe(1);
  });

  it('compares a marked trace by thresholds only, and says so', () => {
    const trace = makeTrace({ nondeterministic: { 'Math.random': 12 } });
    const wobbled = compareTraceToRun(
      trace,
      replayOf({
        outcome: { ...makeResult().outcome!, frame: 104 },
        game: { provider: 'snake', snapshot: { score: 5, lives: 3, phase: 'play' } as Json },
      })
    );
    expect(wobbled.strict).toBe(false);
    expect(wobbled.matched).toBe(true);
    expect(wobbled.verdict).toContain('not proof of an identical run');
    expect(wobbled.nondeterministic).toEqual({ 'Math.random': 12 });

    const wayOff = compareTraceToRun(
      trace,
      replayOf({ outcome: { ...makeResult().outcome!, frame: 400 } })
    );
    expect(wayOff.matched).toBe(false);
    expect(wayOff.diffs.find(diff => diff.metric === 'frame')?.within).toBe(false);
  });

  it('fails on a different outcome kind however loose the tolerance', () => {
    const trace = makeTrace({ nondeterministic: { 'Math.random': 1 } });
    const timedOut = compareTraceToRun(trace, {
      ok: true,
      outcome: { kind: 'timeout', frame: 100, gameTimeMs: 1666.667, detail: 'nothing fired' },
      metrics: { frames: 100, gameTimeMs: 1666.667, wallMs: 1, newErrors: 0, framesPerSecond: 1 },
    });
    expect(timedOut.outcomeMatched).toBe(false);
    expect(timedOut.matched).toBe(false);
  });

  it('never tolerates a new runtime error', () => {
    const trace = makeTrace({ nondeterministic: { 'Math.random': 1 } });
    const crashed = compareTraceToRun(
      trace,
      replayOf({
        metrics: {
          frames: 100,
          gameTimeMs: 1666.667,
          wallMs: 1,
          newErrors: 2,
          framesPerSecond: 1,
        },
      })
    );
    expect(crashed.matched).toBe(false);
    expect(crashed.diffs.find(diff => diff.metric === 'newErrors')?.within).toBe(false);
  });

  it('drops out of strict mode when the environment drifted', () => {
    const trace = makeTrace();
    const drifted = compareTraceToRun(trace, replayOf(), {
      env: { fixedDeltaSec: 1 / 30, sceneId: 'scenes/other.pix3scene' },
    });
    expect(drifted.strict).toBe(false);
    expect(drifted.notes.join(' ')).toContain('not comparable strictly');
    expect(drifted.notes.join(' ')).toContain('scenes/other.pix3scene');
  });

  it('reports a snapshot path the game no longer exposes', () => {
    const trace = makeTrace();
    const reshaped = compareTraceToRun(
      trace,
      replayOf({ game: { provider: 'snake', snapshot: { score: 4, phase: 'play' } as Json } })
    );
    expect(reshaped.matched).toBe(false);
    expect(reshaped.notes.join(' ')).toContain('no `lives`');
  });

  it('reports a non-numeric drift in a marked trace without failing on it', () => {
    const trace = makeTrace({ nondeterministic: { 'Math.random': 3 } });
    const different = compareTraceToRun(
      trace,
      replayOf({
        game: { provider: 'snake', snapshot: { score: 4, lives: 3, phase: 'gameover' } as Json },
      })
    );
    const diff = different.diffs.find(entry => entry.metric === 'state.phase');
    expect(diff?.within).toBe(false);
    expect(diff?.soft).toBe(true);
    expect(different.matched).toBe(true);
  });
});

describe('makeTraceFeeder', () => {
  it('dispatches nothing for a frame with no events and counts what it sent', () => {
    const sent: string[] = [];
    const feeder = makeTraceFeeder(
      [
        { frame: 2, kind: 'key', phase: 'down', code: 'KeyA' },
        { frame: 2, kind: 'pointer', phase: 'down', nx: 0.5, ny: 0.5 },
      ],
      {
        key: (phase, code) => sent.push(`${phase}:${code}`),
        pointer: (phase, nx, ny) => sent.push(`${phase}:${nx},${ny}`),
      }
    );
    feeder.before(1);
    expect(sent).toEqual([]);
    feeder.before(2);
    expect(sent).toEqual(['down:KeyA', 'down:0.5,0.5']);
    expect(feeder.dispatched).toBe(2);
    expect(feeder.pending(1)).toBe(2);
    expect(feeder.pending(2)).toBe(0);
  });
});
