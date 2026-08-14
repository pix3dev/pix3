import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Json } from '@/core/agent-introspection';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import { NodeBase, type GameCommandLogEntry } from '@pix3/runtime';
import {
  GameTestService,
  LiveSignalWatcher,
  runGameTestLoop,
  validateSpec,
  type CommandJournalReading,
  type GameRunLoopDeps,
  type GameStateSample,
  type MonkeyExecution,
  type MonkeyWorld,
  type NormalizedRunSpec,
  type SignalWatcher,
  type TestableRunner,
} from './GameTestService';
import {
  MONKEY_EMPTY_NOTE,
  type MonkeyAction,
  type MonkeyInventory,
  type NormalizedMonkeySpec,
} from './game-monkey';
import { DEFAULT_CONTROL_HOLD_FRAMES } from './game-control';
import type { BotReport } from './game-bots';
import { RunProtocolRecorder, type RunProtocolStore } from './game-run-protocol';
import { CURRENT_EDITOR_VERSION } from '@/version';
import type { LiveControlEntry, LiveNodeSnapshot } from './GameInputService';
import {
  signalWatchKey,
  type GameAssertion,
  type SignalObservation,
  type SignalWatchSpec,
} from './game-assertions';

/**
 * The loop, against a fake runner. Modelled on `SceneRunner.time.spec.ts`: the
 * runner is reduced to the five members `runGameTestLoop` actually drives, so a
 * case here is about the loop's decisions (baseline, early exit, pause, time
 * restore) and never about a scene, a renderer, or DI.
 */

interface FakeRunner extends TestableRunner {
  readonly modeHistory: string[];
  frames: number;
  /** Called after every executed tick — where a test moves the game forward. */
  onTick?: (frame: number) => void;
}

function makeRunner(
  options: {
    startMode?: 'realtime' | 'fixed' | 'manual';
    startPaused?: boolean;
    running?: boolean;
    /** Frames after which stepFrames starts refusing (simulates a stopped runner). */
    stopAfter?: number;
  } = {}
): FakeRunner {
  let mode = options.startMode ?? 'realtime';
  let fixedDeltaSec = 1 / 60;
  let paused = options.startPaused ?? false;
  let running = options.running ?? true;
  const modeHistory: string[] = [];
  const runner: FakeRunner = {
    modeHistory,
    frames: 0,
    get paused() {
      return paused;
    },
    get running() {
      return running;
    },
    getTimeMode: () => ({
      mode,
      fixedDeltaSec,
      ticksPerFrame: 1,
      renderEveryNTicks: 1,
      muteAudio: true,
    }),
    setTimeMode: config => {
      mode = config.mode;
      fixedDeltaSec = config.fixedDeltaSec ?? fixedDeltaSec;
      modeHistory.push(config.mode);
    },
    stepFrames: (count = 1) => {
      if (mode !== 'manual' || paused || !running) return 0;
      let executed = 0;
      for (let i = 0; i < count; i += 1) {
        if (options.stopAfter !== undefined && runner.frames >= options.stopAfter) {
          running = false;
          break;
        }
        runner.frames += 1;
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

function makeDeps(
  runner: FakeRunner,
  over: Partial<GameRunLoopDeps> = {}
): GameRunLoopDeps & { wall: { ms: number } } {
  const wall = { ms: 0 };
  return {
    runner,
    sampleGameState: () => null,
    errorCount: () => 0,
    errorsSince: () => [],
    nodeExists: () => false,
    // Deterministic clock: 1ms per read, so a wall-budget test is not flaky.
    now: () => (wall.ms += 1),
    yieldToHost: () => Promise.resolve(),
    ...over,
    wall,
  };
}

function makeSpec(over: Partial<NormalizedRunSpec> = {}): NormalizedRunSpec {
  return {
    until: [{ kind: 'frames', n: 10 }],
    fail: [],
    watch: [],
    maxFrames: 100,
    fixedDeltaSec: 1 / 60,
    maxWallMs: 20_000,
    pauseOnOutcome: true,
    ...over,
  };
}

/**
 * A stand-in for `scene.commands` — specifically for its ring buffer, which is
 * what the loop's windowing has to survive. `read()` hands back the *live* array,
 * exactly as the registry's `log` getter does, so a test that dispatches past the
 * cap really does shift the array under the loop.
 */
function makeJournal(cap = 50): {
  read: () => CommandJournalReading;
  dispatch: (
    name: string,
    args?: Record<string, unknown>,
    over?: Partial<GameCommandLogEntry>
  ) => void;
  clear: () => void;
} {
  const entries: GameCommandLogEntry[] = [];
  let dropped = 0;
  let frame = 0;
  return {
    read: () => ({ entries, dropped }),
    dispatch: (name, args, over = {}) => {
      frame += 1;
      entries.push({ frame, name, status: 'ok', ...(args ? { args } : {}), ...over });
      while (entries.length > cap) {
        entries.shift();
        dropped += 1;
      }
    },
    clear: () => {
      entries.length = 0;
      dropped = 0;
    },
  };
}

/**
 * A signal watcher whose emissions the test controls, so a loop case can put an
 * emission on an exact frame. The real subscription is covered separately against
 * live nodes in `LiveSignalWatcher`.
 */
function makeSignalStub(): {
  factory: (specs: readonly SignalWatchSpec[]) => SignalWatcher;
  emit: () => void;
  state: { created: number; disposed: number; sweeps: number[] };
} {
  const state = { created: 0, disposed: 0, sweeps: [] as number[] };
  let key = '';
  let frame = 0;
  let disposed = false;
  const record = { count: 0, firstFrame: 0, lastFrame: 0 };
  return {
    state,
    factory: specs => {
      state.created += 1;
      key = signalWatchKey(specs[0]);
      return {
        sweep: at => {
          state.sweeps.push(at);
          frame = at;
        },
        observations: () => {
          const observation: SignalObservation = {
            ...record,
            emitters: [],
            attached: 1,
            everAttached: true,
          };
          return new Map([[key, observation]]);
        },
        dispose: () => {
          disposed = true;
          state.disposed += 1;
        },
      };
    },
    emit: () => {
      if (disposed) return;
      record.count += 1;
      if (record.count === 1) record.firstFrame = frame;
      record.lastFrame = frame;
    },
  };
}

/** A game-state source that reads from a mutable object each time it is sampled. */
function stateSource(state: Record<string, Json>): () => GameStateSample {
  return () => ({ provider: 'fake-game', snapshot: { ...state } });
}

describe('validateSpec', () => {
  it('refuses a spec with no `until` — nothing would ever end the run', () => {
    const result = validateSpec({ until: [] });
    expect('error' in result && result.error).toContain('at least one `until`');
  });

  it('clamps the frame budget and defaults the rest', () => {
    const result = validateSpec({ until: [{ kind: 'frames', n: 5 }], maxFrames: 99_999 });
    expect('spec' in result && result.spec.maxFrames).toBe(3600);
    expect('spec' in result && result.spec.pauseOnOutcome).toBe(true);
    expect('spec' in result && result.spec.fixedDeltaSec).toBeCloseTo(1 / 60);
  });

  it('rejects a non-positive tick length rather than freezing the run', () => {
    const result = validateSpec({ until: [{ kind: 'frames', n: 5 }], fixedDeltaSec: 0 });
    expect('error' in result).toBe(true);
  });

  it('folds the node names the assertions mention into `watch`', () => {
    const result = validateSpec({
      until: [{ kind: 'nodeGone', name: 'Player' }],
      watch: ['Spawner'],
    });
    expect('spec' in result && result.spec.watch.sort()).toEqual(['Player', 'Spawner']);
  });
});

describe('runGameTestLoop — the baseline rule', () => {
  it('does not start the run when an `until` already holds at frame 0', async () => {
    const runner = makeRunner();
    const state = { score: 7 };
    const deps = makeDeps(runner, { sampleGameState: stateSource(state) });
    const spec = makeSpec({
      until: [{ kind: 'gameState', path: 'score', op: 'gte', value: 5 }],
    });

    const result = await runGameTestLoop(deps, spec);

    expect(result.outcome?.kind).toBe('precondition-already-met');
    expect(result.outcome?.channel).toBe('until');
    expect(result.outcome?.index).toBe(0);
    expect(result.outcome?.frame).toBe(0);
    expect(result.outcome?.assertion).toBe('gameState score gte 5');
    expect(result.verdict).toContain('PRECONDITION ALREADY MET');
    // The decisive proof: not a single tick was executed.
    expect(runner.frames).toBe(0);
  });

  it('names which predicate was already true when several are given', async () => {
    const runner = makeRunner();
    const deps = makeDeps(runner, { sampleGameState: stateSource({ score: 0, wave: 3 }) });
    const spec = makeSpec({
      until: [
        { kind: 'gameStateChanged', path: 'score', by: 1 },
        { kind: 'gameState', path: 'wave', op: 'gte', value: 2 },
      ],
    });

    const result = await runGameTestLoop(deps, spec);

    expect(result.outcome?.index).toBe(1);
    expect(result.outcome?.assertion).toBe('gameState wave gte 2');
    expect(runner.frames).toBe(0);
  });

  it('applies the same rule to a `fail` that is true before the first tick', async () => {
    const runner = makeRunner();
    const deps = makeDeps(runner, { errorCount: () => 4 });
    const spec = makeSpec({ fail: [{ kind: 'newErrors' }] });

    // errorCount is constant, so `newErrorCount` (count − countAtStart) is 0 …
    expect((await runGameTestLoop(deps, spec)).outcome?.kind).toBe('until');

    // … whereas a `frames` fail is genuinely true at frame 0 only for n < 1, which
    // parsing rejects. The reachable case is nodeGone on a name that never existed.
    const goneSpec = makeSpec({ fail: [{ kind: 'nodeGone', name: 'Ghost' }], watch: ['Ghost'] });
    const goneRunner = makeRunner();
    const goneResult = await runGameTestLoop(makeDeps(goneRunner), goneSpec);
    expect(goneResult.outcome?.kind).toBe('precondition-already-met');
    expect(goneResult.outcome?.channel).toBe('fail');
    expect(goneRunner.frames).toBe(0);
  });

  it('measures a `gameStateChanged` delta against frame 0, not against the previous frame', async () => {
    const runner = makeRunner();
    const state = { score: 100 };
    const deps = makeDeps(runner, { sampleGameState: stateSource(state) });
    // The score creeps up by 1 every 5 frames; a frame-to-frame comparison would
    // never see +3, a baseline comparison sees it at frame 15.
    runner.onTick = frame => {
      if (frame % 5 === 0) state.score += 1;
    };
    const spec = makeSpec({
      until: [{ kind: 'gameStateChanged', path: 'score', by: 3 }],
      maxFrames: 60,
    });

    const result = await runGameTestLoop(deps, spec);

    expect(result.outcome?.kind).toBe('until');
    expect(result.outcome?.frame).toBe(15);
    expect(result.game?.changed).toEqual({ score: [100, 103] });
  });
});

describe('runGameTestLoop — outcomes', () => {
  it('stops on the frame the until predicate fires and reports it', async () => {
    const runner = makeRunner();
    const deps = makeDeps(runner);
    const spec = makeSpec({ until: [{ kind: 'frames', n: 12 }], maxFrames: 500 });

    const result = await runGameTestLoop(deps, spec);

    expect(result.ok).toBe(true);
    expect(result.outcome?.kind).toBe('until');
    expect(result.outcome?.frame).toBe(12);
    expect(result.metrics?.frames).toBe(12);
    expect(result.metrics?.gameTimeMs).toBeCloseTo(200, 0);
    expect(result.verdict).toMatch(/^PASS until\[0\] frames 12/);
    // Early exit: the budget was 500 frames and we stopped at 12.
    expect(runner.frames).toBe(12);
  });

  it('reports FAIL when a fail predicate fires first', async () => {
    const runner = makeRunner();
    let errors = 0;
    runner.onTick = frame => {
      if (frame === 4) errors = 1;
    };
    const deps = makeDeps(runner, {
      errorCount: () => errors,
      errorsSince: () => [{ source: 'script', message: 'boom' }],
    });
    const spec = makeSpec({ until: [{ kind: 'frames', n: 50 }], fail: [{ kind: 'newErrors' }] });

    const result = await runGameTestLoop(deps, spec);

    expect(result.outcome?.kind).toBe('fail');
    expect(result.outcome?.frame).toBe(4);
    expect(result.verdict).toMatch(/^FAIL fail\[0\] newErrors/);
    expect(result.timeline?.[0]).toMatchObject({ frame: 4, kind: 'error' });
  });

  it('prefers `fail` over `until` when both hold on the same frame', async () => {
    const runner = makeRunner();
    let errors = 0;
    runner.onTick = frame => {
      if (frame === 6) errors = 1;
    };
    const deps = makeDeps(runner, { errorCount: () => errors });
    const spec = makeSpec({ until: [{ kind: 'frames', n: 6 }], fail: [{ kind: 'newErrors' }] });

    const result = await runGameTestLoop(deps, spec);

    expect(result.outcome?.kind).toBe('fail');
    expect(result.outcome?.frame).toBe(6);
  });

  it('times out on the frame budget and reports why each until never fired', async () => {
    const runner = makeRunner();
    const deps = makeDeps(runner, { sampleGameState: stateSource({ score: 0 }) });
    const spec = makeSpec({
      until: [{ kind: 'gameStateChanged', path: 'score', by: 1 }],
      maxFrames: 25,
    });

    const result = await runGameTestLoop(deps, spec);

    expect(result.outcome?.kind).toBe('timeout');
    expect(result.outcome?.frame).toBe(25);
    expect(runner.frames).toBe(25);
    expect(result.verdict).toContain('TIMEOUT after 25 frames');
    expect(result.verdict).toContain('until[0] gameStateChanged score by +1');
  });

  it('ends with an `error` outcome when the runner stops advancing mid-run', async () => {
    const runner = makeRunner({ stopAfter: 7 });
    const deps = makeDeps(runner);
    const spec = makeSpec({ until: [{ kind: 'frames', n: 50 }] });

    const result = await runGameTestLoop(deps, spec);

    expect(result.outcome?.kind).toBe('error');
    expect(result.outcome?.frame).toBe(7);
    expect(result.verdict).toContain('ERROR');
  });

  it('gives up on the wall-clock budget rather than freezing the editor', async () => {
    const runner = makeRunner();
    const deps = makeDeps(runner, { now: () => performance.now() });
    const spec = makeSpec({
      until: [{ kind: 'frames', n: 100_000 }],
      maxFrames: 3600,
      maxWallMs: 100,
    });
    // Burn wall time inside the tick so the budget is reached before the frames are.
    runner.onTick = () => {
      const until = performance.now() + 2;
      while (performance.now() < until) {
        /* spin */
      }
    };

    const result = await runGameTestLoop(deps, spec);

    expect(result.outcome?.kind).toBe('timeout');
    expect(result.outcome?.detail).toContain('wall-clock budget');
    expect(runner.frames).toBeLessThan(3600);
  });
});

describe('runGameTestLoop — time-mode discipline', () => {
  it('runs in manual and restores the previous mode', async () => {
    const runner = makeRunner({ startMode: 'realtime' });
    const result = await runGameTestLoop(makeDeps(runner), makeSpec());

    expect(runner.modeHistory).toEqual(['manual', 'realtime']);
    expect(runner.getTimeMode().mode).toBe('realtime');
    expect(result.time).toMatchObject({ ranIn: 'manual', restoredMode: 'realtime' });
  });

  it('restores the previous mode even when a precondition aborts the run', async () => {
    const runner = makeRunner({ startMode: 'fixed' });
    const deps = makeDeps(runner, { sampleGameState: stateSource({ score: 9 }) });
    const spec = makeSpec({ until: [{ kind: 'gameState', path: 'score', op: 'gte', value: 1 }] });

    await runGameTestLoop(deps, spec);

    expect(runner.getTimeMode().mode).toBe('fixed');
  });

  it('leaves the game paused on the outcome frame by default', async () => {
    const runner = makeRunner();
    const result = await runGameTestLoop(makeDeps(runner), makeSpec());

    expect(runner.paused).toBe(true);
    expect(result.time?.leftPaused).toBe(true);
  });

  it('asks the HOST to hold the pause rather than pausing the runner behind its back', async () => {
    const runner = makeRunner();
    const setHostPaused = vi.fn();
    await runGameTestLoop(makeDeps(runner, { setHostPaused }), makeSpec());

    expect(setHostPaused).toHaveBeenLastCalledWith(true);
  });

  it('releases a host-held pause before stepping, so the run is not stepped into a frozen game', async () => {
    const runner = makeRunner({ startPaused: true });
    const calls: boolean[] = [];
    const result = await runGameTestLoop(
      makeDeps(runner, {
        setHostPaused: paused => {
          calls.push(paused);
          if (!paused) runner.resume();
        },
      }),
      makeSpec({ until: [{ kind: 'frames', n: 3 }] })
    );

    expect(calls).toEqual([false, true]);
    expect(result.outcome?.kind).toBe('until');
    expect(runner.frames).toBe(3);
  });

  it('reports leftPaused as a FACT: a game that did not stay paused is not reported as paused', async () => {
    const runner = makeRunner();
    // A host/runner that will not hold the pause — which is what the editor's
    // focus rule used to be. The report must side with the game, not with
    // `pauseOnOutcome`.
    runner.pause = () => {};
    const result = await runGameTestLoop(makeDeps(runner), makeSpec());

    expect(runner.paused).toBe(false);
    expect(result.time?.leftPaused).toBe(false);
    expect(result.notes?.join(' ')).toContain('LATER state');
  });

  it('leaves an already-running game running when pauseOnOutcome is false', async () => {
    const runner = makeRunner();
    const result = await runGameTestLoop(makeDeps(runner), makeSpec({ pauseOnOutcome: false }));

    expect(runner.paused).toBe(false);
    expect(result.time?.leftPaused).toBe(false);
  });

  it('resumes a paused game to be able to step it, and re-pauses it afterwards', async () => {
    const runner = makeRunner({ startPaused: true });
    const result = await runGameTestLoop(
      makeDeps(runner),
      makeSpec({ pauseOnOutcome: false, until: [{ kind: 'frames', n: 3 }] })
    );

    expect(result.outcome?.kind).toBe('until');
    expect(runner.frames).toBe(3);
    // It was paused before the run, so it is paused after it.
    expect(runner.paused).toBe(true);
  });
});

describe('runGameTestLoop — reporting', () => {
  it('caps and dedups the timeline', async () => {
    const runner = makeRunner();
    const state: Record<string, Json> = { score: 0 };
    const deps = makeDeps(runner, { sampleGameState: stateSource(state) });
    runner.onTick = () => {
      state.score = (state.score as number) + 1;
    };
    const spec = makeSpec({
      until: [{ kind: 'gameState', path: 'score', op: 'gte', value: 40 }],
      maxFrames: 60,
    });

    const result = await runGameTestLoop(deps, spec);

    expect(result.outcome?.kind).toBe('until');
    // One path changing every frame folds into a single counted row.
    expect(result.timeline).toHaveLength(1);
    expect(result.timeline?.[0]).toMatchObject({ kind: 'state', count: 40 });
    expect(result.timeline?.[0].note).toContain('score');
  });

  it('records node presence transitions and the baseline→outcome game diff', async () => {
    const runner = makeRunner();
    const state: Record<string, Json> = { lives: 3 };
    let playerAlive = true;
    runner.onTick = frame => {
      if (frame === 9) {
        playerAlive = false;
        state.lives = 2;
      }
    };
    const deps = makeDeps(runner, {
      sampleGameState: stateSource(state),
      nodeExists: query => query === 'Player' && playerAlive,
    });
    const spec = makeSpec({ until: [{ kind: 'nodeGone', name: 'Player' }], watch: ['Player'] });

    const result = await runGameTestLoop(deps, spec);

    expect(result.outcome?.kind).toBe('until');
    expect(result.outcome?.frame).toBe(9);
    expect(result.timeline).toContainEqual({ frame: 9, kind: 'gone', note: 'Player' });
    expect(result.game?.changed).toEqual({ lives: [3, 2] });
  });

  it('notes a missing GameDebugProvider instead of leaving the state silently null', async () => {
    const runner = makeRunner();
    const result = await runGameTestLoop(makeDeps(runner), makeSpec());

    expect(result.notes?.join(' ')).toContain('registerGameDebug');
    expect(result.game).toBeUndefined();
  });

  it('echoes the assertions as the harness understood them', async () => {
    const runner = makeRunner();
    const spec = makeSpec({
      until: [{ kind: 'frames', n: 5 }],
      fail: [{ kind: 'newErrors', min: 2 }],
    });
    const result = await runGameTestLoop(makeDeps(runner), spec);

    expect(result.assertions).toEqual({ until: ['frames 5'], fail: ['newErrors >= 2'] });
  });
});

describe('GameTestService.parseSpec', () => {
  it('parses a full payload', () => {
    const parsed = GameTestService.parseSpec({
      until: [{ kind: 'gameStateChanged', path: 'score', by: 1 }],
      fail: [{ kind: 'newErrors' }],
      watch: ['Player', ''],
      maxFrames: 300,
      pauseOnOutcome: false,
    });
    expect('spec' in parsed).toBe(true);
    if (!('spec' in parsed)) return;
    expect(parsed.spec.until).toHaveLength(1);
    expect(parsed.spec.watch).toEqual(['Player']);
    expect(parsed.spec.maxFrames).toBe(300);
    expect(parsed.spec.pauseOnOutcome).toBe(false);
  });

  it('surfaces the offending channel and index', () => {
    const parsed = GameTestService.parseSpec({ until: [{ kind: 'frames', n: -1 }] });
    expect('error' in parsed && parsed.error).toContain('until[0]');
  });

  it('rejects a non-object payload', () => {
    expect('error' in GameTestService.parseSpec([])).toBe(true);
  });
});

/**
 * The seam unit tests kept missing: `game_run` against the REAL editor pause
 * rule. The loop's own pause was correct in isolation and still did not survive
 * the call, because `GamePlaySessionService` re-derives the runner's pause state
 * on every focus event and on every suppression toggle — and `run()` drops its
 * suppression in its `finally`, milliseconds after pausing. The report said
 * `leftPaused: true` while the game was already running on.
 */
describe('GameTestService.run — the pause survives the focus rule', () => {
  const buildWiredService = (runner: FakeRunner) => {
    const session = new GamePlaySessionService();
    const host = {
      kind: 'tab' as const,
      mount: {} as HTMLElement,
      windowRef: {
        document: { visibilityState: 'visible', hasFocus: () => true } as unknown as Document,
      } as unknown as Window,
    };
    const internals = session as unknown as Record<string, unknown>;
    internals.runner = runner;
    internals.tabHost = host;
    internals.activeHostKind = 'tab';

    const runtime = {
      runner: Object.assign(runner, {
        getLiveNodeById: () => null,
        findLiveNodeByName: () => null,
        getLiveRootNodes: () => [],
      }),
    };
    Object.defineProperty(session, 'getActiveRuntime', {
      value: () => runtime,
      configurable: true,
    });

    const service = new GameTestService();
    Object.defineProperty(service, 'playSession', { value: session, configurable: true });
    return { service, session };
  };

  it('leaves the game paused after the call returns, and says so truthfully', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    appState.ui.pauseRenderingOnUnfocus = true;
    try {
      const runner = makeRunner();
      const { service, session } = buildWiredService(runner);

      const result = await service.run({ until: [{ kind: 'frames', n: 5 }] });

      expect(result.ok).toBe(true);
      // The state the caller will actually inspect — after the focus-pause
      // suppression was dropped, which is where the pause used to be lost.
      expect(runner.paused).toBe(true);
      expect(session.pauseRequested).toBe(true);
      expect(result.time?.leftPaused).toBe(true);
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('hands a game back running when pauseOnOutcome is off', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const runner = makeRunner();
      const { service, session } = buildWiredService(runner);

      const result = await service.run({
        until: [{ kind: 'frames', n: 5 }],
        pauseOnOutcome: false,
      });

      expect(runner.paused).toBe(false);
      expect(session.pauseRequested).toBe(false);
      expect(result.time?.leftPaused).toBe(false);
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('steps a game that a previous run left paused instead of reporting it dead', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const runner = makeRunner();
      const { service, session } = buildWiredService(runner);
      session.setPauseRequested(true);
      expect(runner.paused).toBe(true);

      const result = await service.run({ until: [{ kind: 'frames', n: 5 }] });

      expect(result.outcome?.kind).toBe('until');
      expect(result.metrics?.frames).toBe(5);
      expect(runner.paused).toBe(true);
      expect(result.time?.leftPaused).toBe(true);
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('corrects the report when something resumes the game as the run hands control back', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const runner = makeRunner();
      const { service, session } = buildWiredService(runner);
      // Re-introduce the old bug from the host's side: whatever the run asks
      // for, dropping the suppression resumes the game.
      Object.defineProperty(session, 'setFocusPauseSuppressed', {
        value: (suppressed: boolean) => {
          if (!suppressed) runner.resume();
        },
        configurable: true,
      });

      const result = await service.run({ until: [{ kind: 'frames', n: 5 }] });

      expect(runner.paused).toBe(false);
      expect(result.time?.leftPaused).toBe(false);
      expect(result.notes?.join(' ')).toContain('LATER state');
    } finally {
      appState.ui.isPlaying = false;
    }
  });
});

describe('GameTestService.run — guards', () => {
  const buildService = (runtime: unknown) => {
    const service = new GameTestService();
    Object.defineProperty(service, 'playSession', {
      value: {
        getActiveRuntime: () => runtime,
        setFocusPauseSuppressed: vi.fn(),
        setPauseRequested: vi.fn(),
      },
      configurable: true,
    });
    return service;
  };

  it('refuses when the game is not playing', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = false;
    const result = await buildService(null).run({ until: [{ kind: 'frames', n: 5 }] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('play_start');
  });

  it('rejects input steps with the reason, rather than running them into a false negative', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const service = buildService({ runner: makeRunner() });
      const result = await service.run({
        until: [{ kind: 'frames', n: 5 }],
        input: [{ type: 'key', code: 'KeyA' }],
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('game_input');
      expect(result.error).toContain('manual');
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('refuses a spec with no until', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const service = buildService({ runner: makeRunner() });
      const result = await service.run({ until: [] as GameAssertion[] });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('at least one `until`');
    } finally {
      appState.ui.isPlaying = false;
    }
  });
});

/**
 * The command window (§5.2, §5.8.4). The journal is a ring buffer shared with the
 * whole scene, so these cases are about *which* entries belong to this run — the
 * one thing a naive `log.filter(byName)` gets wrong.
 */
describe('runGameTestLoop — command journal window', () => {
  it('ignores dispatches that happened before the run and says where they went', async () => {
    const runner = makeRunner();
    const journal = makeJournal();
    // A tap sent with game_input before game_run: the binding is fine, but the
    // dispatch is outside this run's window and must not pass it.
    journal.dispatch('open-menu');

    const result = await runGameTestLoop(
      makeDeps(runner, { readCommandJournal: journal.read }),
      makeSpec({ until: [{ kind: 'command', name: 'open-menu' }], maxFrames: 5 })
    );

    expect(result.outcome?.kind).toBe('timeout');
    expect(result.verdict).toContain('before the run started');
  });

  it('is met by a dispatch made during the run, on the frame it happened', async () => {
    const runner = makeRunner();
    const journal = makeJournal();
    runner.onTick = frame => {
      if (frame === 3) journal.dispatch('open-menu');
    };

    const result = await runGameTestLoop(
      makeDeps(runner, { readCommandJournal: journal.read }),
      makeSpec({ until: [{ kind: 'command', name: 'open-menu' }], maxFrames: 20 })
    );

    expect(result.outcome?.kind).toBe('until');
    expect(result.outcome?.frame).toBe(3);
  });

  it('matches args partially, so "bought slot 2" does not need the whole payload', async () => {
    const runner = makeRunner();
    const journal = makeJournal();
    runner.onTick = frame => {
      if (frame === 2) journal.dispatch('buy-item', { slot: 2, price: 30, currency: 'gold' });
    };

    const result = await runGameTestLoop(
      makeDeps(runner, { readCommandJournal: journal.read }),
      makeSpec({
        until: [{ kind: 'command', name: 'buy-item', args: { slot: 2 } }],
        maxFrames: 20,
      })
    );

    expect(result.outcome?.kind).toBe('until');
    expect(result.outcome?.frame).toBe(2);
  });

  it('counts the entries the ring dropped inside the window and reports them', async () => {
    const runner = makeRunner();
    // A cap of 4 with one dispatch per frame: by frame 10 the ring has thrown
    // away six in-window lines, and the verdict has to admit it rather than
    // report a clean "never dispatched".
    const journal = makeJournal(4);
    runner.onTick = () => journal.dispatch('noise');

    const result = await runGameTestLoop(
      makeDeps(runner, { readCommandJournal: journal.read }),
      makeSpec({ until: [{ kind: 'command', name: 'open-menu' }], maxFrames: 10 })
    );

    expect(result.outcome?.kind).toBe('timeout');
    expect(result.verdict).toContain('dropped 6 entries');
  });

  it('does not count pre-window entries that are still in the ring', async () => {
    const runner = makeRunner();
    const journal = makeJournal(10);
    journal.dispatch('open-menu');
    runner.onTick = () => journal.dispatch('noise');

    const result = await runGameTestLoop(
      makeDeps(runner, { readCommandJournal: journal.read }),
      makeSpec({ until: [{ kind: 'command', name: 'open-menu' }], maxFrames: 5 })
    );

    // The entry is still physically in the log — position, not presence, is what
    // decides membership of the window.
    expect(journal.read().entries.some(entry => entry.name === 'open-menu')).toBe(true);
    expect(result.outcome?.kind).toBe('timeout');
  });

  it('flags a journal cleared mid-run instead of silently rebasing', async () => {
    const runner = makeRunner();
    const journal = makeJournal();
    journal.dispatch('open-menu');
    runner.onTick = frame => {
      // A scene stop/change clears the registry, resetting both counters.
      if (frame === 2) journal.clear();
      if (frame === 3) journal.dispatch('start-game');
    };

    const result = await runGameTestLoop(
      makeDeps(runner, { readCommandJournal: journal.read }),
      makeSpec({ until: [{ kind: 'command', name: 'open-menu' }], maxFrames: 6 })
    );

    expect(result.outcome?.kind).toBe('timeout');
    expect(result.verdict).toContain('cleared mid-run');
  });

  it('says the scene has no registry rather than failing for an unstated reason', async () => {
    const result = await runGameTestLoop(
      makeDeps(makeRunner(), { readCommandJournal: () => null }),
      makeSpec({ until: [{ kind: 'command', name: 'open-menu' }], maxFrames: 3 })
    );

    expect(result.outcome?.kind).toBe('timeout');
    expect(result.notes?.join(' ')).toContain('no command registry');
  });
});

/** The signal side of the binding proof (§5.8.4) as the loop drives it. */
describe('runGameTestLoop — signal subscription', () => {
  it('subscribes for the run, stamps the emitting frame, and disposes afterwards', async () => {
    const runner = makeRunner();
    const signals = makeSignalStub();
    runner.onTick = frame => {
      if (frame === 4) signals.emit();
    };

    const result = await runGameTestLoop(
      makeDeps(runner, { watchSignals: signals.factory }),
      makeSpec({
        until: [{ kind: 'signal', name: 'toggled', node: 'MusicCheckbox' }],
        maxFrames: 20,
      })
    );

    expect(result.outcome?.kind).toBe('until');
    expect(result.outcome?.frame).toBe(4);
    expect(result.outcome?.detail).toContain('frame 4');
    // Swept before each step, so a node that spawns on frame N is heard on N.
    expect(signals.state.sweeps.slice(0, 3)).toEqual([1, 2, 3]);
    expect(signals.state.disposed).toBe(1);
  });

  it('opens no subscription when nothing asks for one', async () => {
    const signals = makeSignalStub();
    await runGameTestLoop(
      makeDeps(makeRunner(), { watchSignals: signals.factory }),
      makeSpec({ until: [{ kind: 'frames', n: 3 }] })
    );
    expect(signals.state.created).toBe(0);
  });

  it('disposes the subscription on the error path too', async () => {
    // The runner dies mid-run: the listener still has to come off, or it keeps
    // recording into a finished run.
    const runner = makeRunner({ stopAfter: 2 });
    const signals = makeSignalStub();

    const result = await runGameTestLoop(
      makeDeps(runner, { watchSignals: signals.factory }),
      makeSpec({ until: [{ kind: 'signal', name: 'toggled' }], maxFrames: 20 })
    );

    expect(result.outcome?.kind).toBe('error');
    expect(signals.state.disposed).toBe(1);
  });

  it('reports the missing capability instead of a bare negative', async () => {
    const result = await runGameTestLoop(
      makeDeps(makeRunner()),
      makeSpec({ until: [{ kind: 'signal', name: 'toggled' }], maxFrames: 3 })
    );
    expect(result.outcome?.kind).toBe('timeout');
    expect(result.notes?.join(' ')).toContain('cannot subscribe to signals');
  });
});

/**
 * The four predicates that need the loop to COLLECT something per frame, driven
 * end to end rather than as pure functions.
 *
 * Each one is answered from a map on the frame record, so a predicate whose
 * collection the loop never turned on reports "harness bug" — a sentence that is
 * true, useless, and was the actual behaviour of `nodeProperty` / `nodeMoved` /
 * `axis` / by-type `nodeAppeared` while the loop collected none of them. Hence the
 * last case in this block: the run that asks for none must still collect none, or
 * the fix has been paid for by every other run.
 */
describe('runGameTestLoop — per-predicate collection', () => {
  const snapshotAt = (x: number, over: Partial<LiveNodeSnapshot> = {}): LiveNodeSnapshot => ({
    nodeId: 'n1',
    name: 'Player',
    type: 'Sprite2D',
    visible: true,
    position: { x, y: 0, z: 0 },
    worldPosition: { x, y: 0, z: 0 },
    rotationZ: 0,
    scale: { x: 1, y: 1, z: 1 },
    childCount: 0,
    visibleChildCount: 0,
    ...over,
  });

  it('reads a nodeProperty every frame and ends on the frame it satisfies the comparison', async () => {
    const runner = makeRunner();
    const label = { text: 'Score: 0' };
    runner.onTick = frame => {
      if (frame === 5) label.text = 'Score: 10';
    };
    const readNodeProperty = vi.fn((query: string, path: string) =>
      query === 'ScoreLabel' && path === 'text' ? label.text : undefined
    );

    const result = await runGameTestLoop(
      makeDeps(runner, { readNodeProperty, nodeExists: () => true }),
      makeSpec({
        until: [
          { kind: 'nodeProperty', name: 'ScoreLabel', path: 'text', op: 'contains', value: '10' },
        ],
        maxFrames: 20,
      })
    );

    expect(result.outcome?.kind).toBe('until');
    expect(result.outcome?.frame).toBe(5);
    expect(result.outcome?.detail).toContain('Score: 10');
    // Frame 0 (the baseline) plus the five stepped frames — a per-frame reading.
    expect(readNodeProperty).toHaveBeenCalledTimes(6);
  });

  it('distinguishes "no such property" from "no such node" instead of blaming the harness', async () => {
    const missingNode = await runGameTestLoop(
      makeDeps(makeRunner(), { readNodeProperty: () => undefined, nodeExists: () => false }),
      makeSpec({
        until: [{ kind: 'nodeProperty', name: 'Ghost', path: 'text', op: 'eq', value: 'x' }],
        maxFrames: 2,
      })
    );
    expect(missingNode.verdict).toContain('no live node answers "Ghost"');
    expect(missingNode.verdict).not.toContain('harness');

    // `watch` carries the names the predicate is judged on (validateSpec folds them in
    // for the real tool), and that is what makes the node's PRESENCE known here —
    // which is the difference between the two sentences.
    const missingProperty = await runGameTestLoop(
      makeDeps(makeRunner(), { readNodeProperty: () => undefined, nodeExists: () => true }),
      makeSpec({
        until: [{ kind: 'nodeProperty', name: 'Player', path: 'hp', op: 'eq', value: 1 }],
        watch: ['Player'],
        maxFrames: 2,
      })
    );
    expect(missingProperty.verdict).toContain('has no property "hp"');
    expect(missingProperty.verdict).not.toContain('harness');
  });

  it('measures nodeMoved against the frame-0 snapshot, on the axis the spec asked for', async () => {
    const runner = makeRunner();
    let x = 100;
    runner.onTick = () => {
      x -= 3;
    };

    const result = await runGameTestLoop(
      makeDeps(runner, { snapshotNode: () => snapshotAt(x), nodeExists: () => true }),
      makeSpec({
        until: [{ kind: 'nodeMoved', name: 'Player', axis: 'x', max: -6 }],
        maxFrames: 20,
      })
    );

    expect(result.outcome?.kind).toBe('until');
    expect(result.outcome?.frame).toBe(2);
    expect(result.outcome?.detail).toContain('Δx -6');
  });

  it('says a nodeMoved name is not in the scene rather than claiming nothing was captured', async () => {
    // The distinction the loop pays for by attaching an EMPTY map when a snapshot was
    // asked for: an unresolvable name is a typo in the test, not a harness fault.
    const result = await runGameTestLoop(
      makeDeps(makeRunner(), { snapshotNode: () => null }),
      makeSpec({ until: [{ kind: 'nodeMoved', name: 'Playr' }], maxFrames: 3 })
    );
    expect(result.outcome?.kind).toBe('timeout');
    expect(result.verdict).toContain('was not in the scene at frame 0');
    expect(result.verdict).not.toContain('harness');
  });

  it('counts live nodes by type, so a POOLED spawn satisfies nodeAppeared', async () => {
    const runner = makeRunner();
    let enemies = 2;
    runner.onTick = frame => {
      if (frame === 3) enemies = 4;
    };
    const countNodesOfType = vi.fn(() => enemies);

    const result = await runGameTestLoop(
      // `nodeExists` stays false throughout: the by-NAME reading can never fire, so a
      // pass here is the type reading and nothing else.
      makeDeps(runner, { countNodesOfType, nodeExists: () => false }),
      makeSpec({ until: [{ kind: 'nodeAppeared', query: 'Enemy2D' }], maxFrames: 20 })
    );

    expect(result.outcome?.kind).toBe('until');
    expect(result.outcome?.frame).toBe(3);
    expect(result.outcome?.detail).toContain('up from 2');
    expect(countNodesOfType).toHaveBeenCalledWith('Enemy2D');
  });

  it('samples an input axis every frame and judges the value, not the game', async () => {
    const runner = makeRunner();
    let horizontal = 0;
    runner.onTick = frame => {
      if (frame === 2) horizontal = -0.8;
    };
    const readAxis = vi.fn((name: string) => (name === 'Horizontal' ? horizontal : undefined));

    const result = await runGameTestLoop(
      makeDeps(runner, { readAxis }),
      makeSpec({
        until: [{ kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 }],
        maxFrames: 20,
      })
    );

    expect(result.outcome?.kind).toBe('until');
    expect(result.outcome?.frame).toBe(2);
    expect(result.outcome?.detail).toContain('axis Horizontal = -0.8');
  });

  it('names the missing capability when the host cannot take a reading', async () => {
    const result = await runGameTestLoop(
      makeDeps(makeRunner()),
      makeSpec({
        until: [
          { kind: 'nodeProperty', name: 'Player', path: 'hp', op: 'gt', value: 0 },
          { kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 },
          { kind: 'nodeMoved', name: 'Player' },
        ],
        maxFrames: 2,
      })
    );

    const notes = result.notes?.join(' ') ?? '';
    expect(notes).toContain('cannot read live node properties');
    expect(notes).toContain('cannot sample input axes');
    expect(notes).toContain('cannot capture node transforms');
  });

  it('collects nothing a run did not ask for', async () => {
    const readers = {
      snapshotNode: vi.fn(() => null),
      readNodeProperty: vi.fn(() => undefined),
      countNodesOfType: vi.fn(() => 0),
      readAxis: vi.fn(() => 0),
    };

    const result = await runGameTestLoop(
      makeDeps(makeRunner(), readers),
      // The cheapest possible run: a budget, and nothing that reads the scene.
      makeSpec({ until: [{ kind: 'frames', n: 8 }], maxFrames: 20 })
    );

    expect(result.outcome?.frame).toBe(8);
    expect(readers.snapshotNode).not.toHaveBeenCalled();
    expect(readers.readNodeProperty).not.toHaveBeenCalled();
    expect(readers.countNodesOfType).not.toHaveBeenCalled();
    expect(readers.readAxis).not.toHaveBeenCalled();
    // And it says nothing about capabilities it never needed.
    expect(result.notes?.join(' ') ?? '').not.toContain('cannot');
  });

  it('pays only for the reading its own predicates name', async () => {
    // A `nodeMoved` run must not start counting types or sampling axes as well: the
    // per-frame cost of the four is wildly different and a loop that collects all of
    // them is a loop nobody can afford to run for 600 frames.
    const readers = {
      snapshotNode: vi.fn(() => snapshotAt(0)),
      readNodeProperty: vi.fn(() => undefined),
      countNodesOfType: vi.fn(() => 0),
      readAxis: vi.fn(() => 0),
    };

    await runGameTestLoop(
      makeDeps(makeRunner(), readers),
      makeSpec({ until: [{ kind: 'nodeMoved', name: 'Player', min: 500 }], maxFrames: 4 })
    );

    expect(readers.snapshotNode).toHaveBeenCalled();
    expect(readers.readNodeProperty).not.toHaveBeenCalled();
    expect(readers.countNodesOfType).not.toHaveBeenCalled();
    expect(readers.readAxis).not.toHaveBeenCalled();
  });
});

/**
 * The real watcher, against real nodes. The stub above proves the loop's use of
 * the contract; this proves the contract — that the listener is actually attached
 * to a live node, hears a node that spawns mid-run, does not double-count across
 * sweeps, and is genuinely removed on dispose.
 */
describe('LiveSignalWatcher', () => {
  const node = (name: string): NodeBase => new NodeBase({ id: name, type: 'Node', name });
  /**
   * Reaches into `NodeBase`'s private connection map on purpose: "the listener is
   * gone" must be proven by the absence of the connection, not by the watcher's
   * own `disposed` guard, which would hide a leak.
   */
  const connections = (target: NodeBase, signal: string): number =>
    (target as unknown as { _signals: Map<string, Set<unknown>> })._signals.get(signal)?.size ?? 0;
  const count = (watcher: LiveSignalWatcher, spec: SignalWatchSpec): number =>
    watcher.observations().get(signalWatchKey(spec))?.count ?? 0;

  it('records a scoped node emission with the swept frame', () => {
    const checkbox = node('MusicCheckbox');
    const spec: SignalWatchSpec = { name: 'toggled', node: 'MusicCheckbox' };
    const watcher = new LiveSignalWatcher(() => [checkbox], [spec]);

    watcher.sweep(7);
    checkbox.emit('toggled', true);

    const observation = watcher.observations().get(signalWatchKey(spec));
    expect(observation?.count).toBe(1);
    expect(observation?.firstFrame).toBe(7);
    expect(observation?.emitters).toEqual(['MusicCheckbox']);
    watcher.dispose();
  });

  it('removes every listener on dispose, so emissions outside the run are never seen', () => {
    const checkbox = node('MusicCheckbox');
    const spec: SignalWatchSpec = { name: 'toggled', node: 'MusicCheckbox' };
    const watcher = new LiveSignalWatcher(() => [checkbox], [spec]);
    watcher.sweep(1);
    checkbox.emit('toggled');
    expect(connections(checkbox, 'toggled')).toBe(1);

    watcher.dispose();

    expect(connections(checkbox, 'toggled')).toBe(0);
    checkbox.emit('toggled');
    expect(count(watcher, spec)).toBe(1);
  });

  it('hears a node that spawned mid-run, from the sweep that finds it', () => {
    const root = node('Root');
    const spec: SignalWatchSpec = { name: 'died' };
    const watcher = new LiveSignalWatcher(() => [root], [spec]);
    watcher.sweep(1);

    const enemy = node('Enemy');
    root.add(enemy);
    enemy.emit('died'); // not attached yet
    expect(count(watcher, spec)).toBe(0);

    watcher.sweep(2);
    enemy.emit('died');

    expect(count(watcher, spec)).toBe(1);
    expect(watcher.observations().get(signalWatchKey(spec))?.lastFrame).toBe(2);
    watcher.dispose();
  });

  it('does not double-count when a sweep revisits a node it already holds', () => {
    const checkbox = node('MusicCheckbox');
    const spec: SignalWatchSpec = { name: 'toggled' };
    const watcher = new LiveSignalWatcher(() => [checkbox], [spec]);
    watcher.sweep(1);
    watcher.sweep(2);
    watcher.sweep(3);

    checkbox.emit('toggled');

    expect(connections(checkbox, 'toggled')).toBe(1);
    expect(count(watcher, spec)).toBe(1);
    watcher.dispose();
  });

  it('records that a scope never resolved, so a typo is distinguishable from silence', () => {
    const spec: SignalWatchSpec = { name: 'toggled', node: 'Typo' };
    const watcher = new LiveSignalWatcher(() => [node('MusicCheckbox')], [spec]);
    watcher.sweep(1);

    const observation = watcher.observations().get(signalWatchKey(spec));
    expect(observation?.everAttached).toBe(false);
    expect(observation?.attached).toBe(0);
    watcher.dispose();
  });

  it('stops walking the scene once every scoped watch has found its node', () => {
    const checkbox = node('MusicCheckbox');
    const roots = vi.fn(() => [checkbox]);
    const watcher = new LiveSignalWatcher(roots, [{ name: 'toggled', node: 'MusicCheckbox' }]);
    const afterAttach = roots.mock.calls.length;

    watcher.sweep(2);
    watcher.sweep(3);

    expect(roots.mock.calls.length).toBe(afterAttach);
    watcher.dispose();
  });
});

/**
 * Monkey mode and the negative control, at the seam where the loop meets them.
 * The modules' own logic (the decision stream, the invariants, the three-valued
 * judgement) is proven against plain records; what these cases are about is the
 * wiring — that the loop supplies a real inventory, executes what was decided,
 * feeds the monitor, and lets neither an empty inventory nor a missing control pass
 * for a clean result.
 */
describe('runGameTestLoop — monkey mode', () => {
  const control = (name: string, interactions: string[] = ['click']): LiveControlEntry => ({
    nodeId: `${name}-id`,
    name,
    type: 'Button2D',
    visible: true,
    reach: 'reachable',
    interactions: interactions.map(interaction => ({ name: interaction })),
  });

  interface FakeWorld extends MonkeyWorld {
    readonly performed: MonkeyAction[];
    readonly releases: number[];
    releasedAll: number;
  }

  const makeWorld = (
    inventory: MonkeyInventory,
    execution: (action: MonkeyAction) => MonkeyExecution = () => ({ status: 'sent' })
  ): FakeWorld => {
    const performed: MonkeyAction[] = [];
    const releases: number[] = [];
    return {
      performed,
      releases,
      releasedAll: 0,
      inventory: () => Promise.resolve(inventory),
      execute: action => {
        performed.push(action);
        return execution(action);
      },
      releaseDue: frame => {
        releases.push(frame);
      },
      releaseAll() {
        this.releasedAll += 1;
      },
    };
  };

  const monkeySpec = (over: Partial<NormalizedMonkeySpec> = {}): NormalizedMonkeySpec => ({
    seed: 42,
    actions: [],
    everyFrames: 4,
    holdFrames: 2,
    maxActions: 200,
    invariants: {},
    ...over,
  });

  it('presses what the scene offers, on the decision cadence, and reports the seed with the log', async () => {
    const runner = makeRunner();
    const world = makeWorld({
      controls: [control('PlayButton'), control('MuteButton')],
      commands: ['game.start'],
      actions: [],
    });
    const result = await runGameTestLoop(
      makeDeps(runner, { monkey: world }),
      makeSpec({ until: [{ kind: 'frames', n: 12 }], monkey: monkeySpec() })
    );

    // Decisions land on frames 4, 8 and 12 — each in the gap before that frame.
    expect(world.performed).toHaveLength(3);
    expect(result.monkey?.seed).toBe(42);
    expect(result.monkey?.actions).toBe(3);
    expect(result.monkey?.log).toHaveLength(3);
    expect(result.monkey?.log[0]).toMatch(/^f4 /);
    expect(result.monkey?.lastActions.length).toBeGreaterThan(0);
    expect(result.outcome?.kind).toBe('until');
  });

  it('replays the same presses for the same seed, and different ones for another seed', async () => {
    const inventory: MonkeyInventory = {
      controls: [control('PlayButton'), control('MuteButton'), control('Volume', ['setValue'])],
      commands: ['game.start', 'game.pause'],
      actions: ['Key_Space'],
    };
    const runOnce = async (seed: number): Promise<string[]> => {
      const world = makeWorld(inventory);
      const result = await runGameTestLoop(
        makeDeps(makeRunner(), { monkey: world }),
        makeSpec({ until: [{ kind: 'frames', n: 40 }], monkey: monkeySpec({ seed }) })
      );
      return result.monkey?.log ?? [];
    };

    const first = await runOnce(7);
    const again = await runOnce(7);
    const other = await runOnce(8);

    expect(first.length).toBeGreaterThan(3);
    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
  });

  it('reports NOTHING TESTED when the scene offered nothing, even though `until` fired', async () => {
    const world = makeWorld({ controls: [], commands: [], actions: [] });
    const result = await runGameTestLoop(
      makeDeps(makeRunner(), { monkey: world }),
      makeSpec({ until: [{ kind: 'frames', n: 8 }], monkey: monkeySpec() })
    );

    expect(world.performed).toHaveLength(0);
    expect(result.outcome?.kind).toBe('monkey-empty');
    expect(result.verdict).toContain('NOTHING TESTED');
    expect(result.monkey?.note).toBe(MONKEY_EMPTY_NOTE);
    // The predicate that did fire is still stated — the run is not a mystery.
    expect(result.outcome?.detail).toContain('nothing the monkey did caused it');
  });

  it('skips a control whose reach or state says a finger could not use it', async () => {
    const offScreen: LiveControlEntry = { ...control('OffScreen'), reach: 'off-screen' };
    const disabled: LiveControlEntry = { ...control('Disabled'), enabled: false };
    const world = makeWorld({ controls: [offScreen, disabled], commands: [], actions: [] });

    const result = await runGameTestLoop(
      makeDeps(makeRunner(), { monkey: world }),
      makeSpec({ until: [{ kind: 'frames', n: 8 }], monkey: monkeySpec() })
    );

    expect(world.performed).toHaveLength(0);
    expect(result.outcome?.kind).toBe('monkey-empty');
  });

  it('ends the run on an invariant violation, naming it, ahead of an `until` on the same frame', async () => {
    const runner = makeRunner();
    let errors = 0;
    runner.onTick = frame => {
      if (frame === 6) errors = 1;
    };
    const world = makeWorld({ controls: [control('PlayButton')], commands: [], actions: [] });

    const result = await runGameTestLoop(
      makeDeps(runner, {
        monkey: world,
        errorCount: () => errors,
        errorsSince: () => (errors ? [{ source: 'script', message: 'boom' }] : []),
      }),
      // `frames: 6` would otherwise pass on the very frame the error appears.
      makeSpec({ until: [{ kind: 'frames', n: 6 }], monkey: monkeySpec() })
    );

    expect(result.outcome?.kind).toBe('fail');
    expect(result.outcome?.assertion).toBe('monkey invariant: new-errors');
    expect(result.verdict).toContain('FAIL');
    expect(result.monkey?.actions).toBeGreaterThan(0);
  });

  it('logs a refused press as refused instead of counting it as an action', async () => {
    const world = makeWorld(
      { controls: [control('DeadButton')], commands: [], actions: [] },
      () => ({ status: 'refused', note: 'the control itself refused it' })
    );

    const result = await runGameTestLoop(
      makeDeps(makeRunner(), { monkey: world }),
      makeSpec({ until: [{ kind: 'frames', n: 8 }], monkey: monkeySpec() })
    );

    expect(result.monkey?.actions).toBe(0);
    expect(result.monkey?.refused).toBe(2);
    expect(result.monkey?.log[0]).toContain('[refused: the control itself refused it]');
    // Refused presses are still presses attempted: the run is not "empty".
    expect(result.outcome?.kind).toBe('until');
  });

  it('asks the world to end holds every frame and to let go of everything at the end', async () => {
    const world = makeWorld({ controls: [], commands: [], actions: ['Key_Space'] });

    await runGameTestLoop(
      makeDeps(makeRunner(), { monkey: world }),
      makeSpec({ until: [{ kind: 'frames', n: 5 }], monkey: monkeySpec() })
    );

    expect(world.releases).toEqual([1, 2, 3, 4, 5]);
    expect(world.releasedAll).toBe(1);
  });

  it('says nothing was pressed when the runtime cannot supply a monkey world', async () => {
    const result = await runGameTestLoop(
      makeDeps(makeRunner()),
      makeSpec({ until: [{ kind: 'frames', n: 5 }], monkey: monkeySpec() })
    );

    expect(result.monkey).toBeUndefined();
    expect(result.notes?.join(' ')).toContain('NOTHING was pressed');
  });
});

describe('GameTestService.parseSpec — monkey and control blocks', () => {
  it('refuses a monkey run without a seed, and says why the seed is the point', () => {
    const parsed = GameTestService.parseSpec({ until: [{ kind: 'frames', n: 5 }], monkey: {} });
    expect('error' in parsed && parsed.error).toContain('monkey.seed');
    expect('error' in parsed && parsed.error).toContain('cannot be reproduced');
  });

  it('accepts a monkey block and fills in the cadence defaults', () => {
    const parsed = GameTestService.parseSpec({
      until: [{ kind: 'frames', n: 5 }],
      monkey: { seed: 3, actions: ['Key_ArrowLeft'] },
    });
    expect('spec' in parsed && parsed.spec.monkey).toMatchObject({
      seed: 3,
      actions: ['Key_ArrowLeft'],
      everyFrames: 12,
      holdFrames: 8,
    });
  });

  it('refuses a control block with no gesture, or one aimed in the wrong units', () => {
    const noTap = GameTestService.parseSpec({ until: [{ kind: 'frames', n: 5 }], control: {} });
    expect('error' in noTap && noTap.error).toContain('control.tap');

    const pixels = GameTestService.parseSpec({
      until: [{ kind: 'frames', n: 5 }],
      control: { tap: { nx: 960, ny: 540 } },
    });
    expect('error' in pixels && pixels.error).toContain('FRACTION of the canvas box');
  });

  it('accepts a control gesture and defaults the hold to a real press', () => {
    const parsed = GameTestService.parseSpec({
      until: [{ kind: 'frames', n: 5 }],
      control: { tap: { nx: 0.05, ny: 0.05 } },
    });
    expect('spec' in parsed && parsed.spec.control).toEqual({
      tap: { nx: 0.05, ny: 0.05 },
      holdFrames: DEFAULT_CONTROL_HOLD_FRAMES,
    });
  });
});

/**
 * The negative control, end to end through the service — the half the pure
 * judgement cannot cover: that isolation is awaited before the control gesture
 * runs, that the control run gets the main run's budget, and that each of the three
 * verdicts reaches the line a reader actually reads.
 */
describe('GameTestService.run — the negative control', () => {
  interface Harness {
    service: GameTestService;
    runner: FakeRunner;
    /** How many times the game was put back to the start. */
    resets: number;
    restarts: number;
  }

  const buildHarness = (options: {
    /** Score as a function of the frame, per run index (0 = main run). */
    score: (frame: number, run: number) => number;
    reset?: boolean;
    restart?: () => Promise<void>;
    controls?: LiveControlEntry[];
    /** Node names the live scene answers to, so a `nodeGone` predicate has something to lose. */
    liveNodes?: string[];
  }): Harness => {
    const runner = makeRunner();
    const harness: Harness = {
      service: new GameTestService(),
      runner,
      resets: 0,
      restarts: 0,
    };
    let run = 0;
    let score = 0;
    runner.onTick = frame => {
      score = options.score(frame, run);
    };

    const provider: Record<string, unknown> = {
      name: 'spec-game',
      snapshot: () => ({ score }),
    };
    if (options.reset) {
      provider.reset = async () => {
        // Async on purpose: the loop must not start the control gesture until this
        // has settled, which is what makes the isolation real.
        await Promise.resolve();
        harness.resets += 1;
        run += 1;
        score = 0;
        runner.frames = 0;
      };
    }
    (globalThis as Record<string, unknown>).__PIX3_GAME_DEBUG__ = provider;

    const runtime = {
      runner: Object.assign(runner, {
        getLiveNodeById: () => null,
        findLiveNodeByName: (name: string) =>
          (options.liveNodes ?? []).includes(name) ? ({ name } as unknown as NodeBase) : null,
        getLiveRootNodes: () => [],
      }),
      canvas: document.createElement('canvas'),
      windowRef: globalThis.window as Window,
    };
    Object.defineProperty(harness.service, 'playSession', {
      value: {
        getActiveRuntime: () => runtime,
        setFocusPauseSuppressed: vi.fn(),
        setPauseRequested: vi.fn(),
        restart: async () => {
          harness.restarts += 1;
          if (options.restart) await options.restart();
          run += 1;
          score = 0;
          runner.frames = 0;
        },
      },
      configurable: true,
    });
    Object.defineProperty(harness.service, 'gameInput', {
      value: {
        listControls: () => Promise.resolve({ ok: true, controls: options.controls ?? [] }),
      },
      configurable: true,
    });
    return harness;
  };

  const spec = (over: Record<string, unknown> = {}) => ({
    until: [{ kind: 'gameStateChanged', path: 'score', by: 1 } as GameAssertion],
    maxFrames: 20,
    ...over,
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__PIX3_GAME_DEBUG__;
  });

  it('passes when the same gesture away from the control produces nothing, and names the isolation', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const harness = buildHarness({
        // The effect only ever happens in the main run.
        score: (frame, run) => (run === 0 && frame >= 3 ? 1 : 0),
        reset: true,
      });

      const result = await harness.service.run(spec({ control: { tap: { nx: 0.02, ny: 0.02 } } }));

      expect(result.outcome?.kind).toBe('until');
      expect(harness.resets).toBe(1);
      expect(result.control?.verdict).toBe('passed');
      expect(result.control?.isolation.method).toBe('reset');
      expect(result.control?.frames).toEqual({ main: 3, control: 20 });
      expect(result.verdict).toContain('NEGATIVE CONTROL PASSED');
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('fails the control when the effect happens without it, and marks the verdict', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const harness = buildHarness({
        // Any tap anywhere raises the score — the Action_Primary trap of §5.4.4.
        score: frame => (frame >= 3 ? 1 : 0),
        reset: true,
      });

      const result = await harness.service.run(spec({ control: { tap: { nx: 0.02, ny: 0.02 } } }));

      expect(result.outcome?.kind).toBe('until');
      expect(result.control?.verdict).toBe('failed');
      expect(result.control?.outcome?.kind).toBe('until');
      expect(result.verdict).toContain('CONTROL FAILED');
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('is inconclusive — never "passed" — when the state could not be restored', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const harness = buildHarness({
        score: (frame, run) => (run === 0 && frame >= 3 ? 1 : 0),
        // No reset() on the provider, and the scene restart itself fails.
        restart: () => Promise.reject(new Error('no project open')),
      });

      const result = await harness.service.run(spec({ control: { tap: { nx: 0.02, ny: 0.02 } } }));

      expect(harness.restarts).toBe(1);
      expect(result.control?.verdict).toBe('inconclusive');
      expect(result.control?.reason).toBe('no-isolation');
      expect(result.control?.isolation.ok).toBe(false);
      expect(result.verdict).toContain('CONTROL INCONCLUSIVE');
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('does not run the control at all when the main run proved nothing to control', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const harness = buildHarness({ score: () => 0, reset: true });

      const result = await harness.service.run(spec({ control: { tap: { nx: 0.02, ny: 0.02 } } }));

      expect(result.outcome?.kind).toBe('timeout');
      expect(harness.resets).toBe(0);
      expect(result.control).toBeUndefined();
      expect(result.notes?.join(' ')).toContain('negative control was not run');
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('marks a passing claim about an on-screen control WEAK when no control gesture was given', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const harness = buildHarness({
        score: (frame, run) => (run === 0 && frame >= 3 ? 1 : 0),
        liveNodes: ['FireButton'],
        controls: [
          {
            nodeId: 'fire-id',
            name: 'FireButton',
            type: 'Button2D',
            visible: true,
            reach: 'reachable',
            interactions: [{ name: 'click' }],
          },
        ],
      });

      const result = await harness.service.run(
        spec({
          until: [
            { kind: 'gameStateChanged', path: 'score', by: 1 } as GameAssertion,
            { kind: 'nodeGone', name: 'FireButton' } as GameAssertion,
          ],
        })
      );

      expect(result.outcome?.kind).toBe('until');
      expect(result.control).toBeUndefined();
      expect(result.verdict).toContain('WEAK');
      expect(result.verdict).toContain('Action_Primary');
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('leaves a run that names no on-screen control unmarked', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const harness = buildHarness({ score: (frame, run) => (run === 0 && frame >= 3 ? 1 : 0) });

      const result = await harness.service.run(spec());

      expect(result.verdict).toContain('PASS');
      expect(result.verdict).not.toContain('WEAK');
    } finally {
      appState.ui.isPlaying = false;
    }
  });
});

/**
 * §6 rule 3: the reply is a summary and the FILE is the run.
 *
 * Every case here defends one thing the reply's caps destroy — and each is written
 * as a *comparison*, because "the artifact has 200 timeline entries" only means
 * something next to "the reply has 20 and says so".
 */
describe('runGameTestLoop — the full protocol artifact', () => {
  /**
   * A snapshot that keeps the timeline busy in two different ways: `score` ticks on
   * every one of the first 30 frames (which the reply folds into ONE entry with a
   * `count`), and from frame 31 a different `pN` moves each frame (which it cannot
   * fold, so those fill the 20-entry cap and truncate it).
   */
  const stateAt = (frame: number): Json => {
    const snapshot: Record<string, Json> = { score: Math.min(frame, 30) };
    for (let index = 0; index < 10; index += 1) {
      snapshot[`p${index}`] = frame > 30 + index ? Math.floor((frame - 31 - index) / 10) + 1 : 0;
    }
    return snapshot;
  };

  it('keeps the timeline events the reply deduped and dropped', async () => {
    const runner = makeRunner();
    const protocol = new RunProtocolRecorder('main');
    const result = await runGameTestLoop(
      makeDeps(runner, {
        protocol,
        sampleGameState: () => ({ provider: 'demo', snapshot: stateAt(runner.frames) }),
      }),
      makeSpec({
        until: [{ kind: 'frames', n: 200 }],
        // A state-reading predicate that can never hold: what it is here for is the
        // side effect that a `gameState` predicate forces the loop to sample EVERY
        // frame instead of every tenth (STATE_SAMPLE_EVERY_FRAMES).
        fail: [{ kind: 'gameState', path: 'score', op: 'gt', value: 9_000 }],
        maxFrames: 200,
      })
    );

    // The reply: capped, deduped, and honest about both.
    expect(result.timeline).toHaveLength(20);
    expect(result.timelineTruncated).toBe(true);
    expect(result.timeline?.[0]).toMatchObject({ kind: 'state', count: 30 });

    // The file: every event, on its own frame, including the 30 the reply folded.
    const section = protocol.section();
    expect(section.timeline).toHaveLength(200);
    const scoreEntries = section.timeline.filter(entry => entry.note.startsWith('score '));
    expect(scoreEntries).toHaveLength(30);
    expect(scoreEntries[0]).toEqual({ frame: 1, kind: 'state', note: 'score 0→1' });
    expect(scoreEntries[29].frame).toBe(30);
    // And the events after the reply's cap bit, which the reply has nothing of.
    expect(section.timeline.some(entry => entry.frame > 60)).toBe(true);
  });

  it('records node, property and axis deltas — the channel the reply has none of', async () => {
    const runner = makeRunner();
    const protocol = new RunProtocolRecorder('main');
    const snapshotAt = (frame: number): LiveNodeSnapshot => ({
      nodeId: 'player',
      name: 'Player',
      type: 'Sprite2D',
      visible: true,
      position: { x: frame, y: 0, z: 0 },
      worldPosition: { x: frame, y: 0, z: 0 },
      rotationZ: 0,
      scale: { x: 1, y: 1, z: 1 },
      childCount: 0,
      visibleChildCount: 0,
    });
    const result = await runGameTestLoop(
      makeDeps(runner, {
        protocol,
        snapshotNode: () => snapshotAt(runner.frames),
        readNodeProperty: () => `Score: ${runner.frames}`,
        readAxis: () => runner.frames / 100,
        countNodesOfType: () => 0,
      }),
      makeSpec({
        until: [{ kind: 'frames', n: 6 }],
        // In `fail` with thresholds nothing can reach: the point is to make the loop
        // COLLECT the three readings, not to end the run on one of them.
        fail: [
          { kind: 'nodeMoved', name: 'Player', axis: 'x', min: 9_000 },
          { kind: 'nodeProperty', name: 'ScoreLabel', path: 'text', op: 'eq', value: 'never' },
          { kind: 'axis', name: 'Horizontal', op: 'gt', value: 9_000 },
        ],
      })
    );

    expect(result.outcome?.kind).toBe('until');
    const observed = protocol.section().observed;
    expect(observed.filter(delta => delta.key === 'Player.worldPosition.x')).toHaveLength(6);
    expect(observed.find(delta => delta.channel === 'transform')).toMatchObject({
      frame: 1,
      key: 'Player.position.x',
      from: 0,
      to: 1,
    });
    expect(observed.find(delta => delta.channel === 'property')).toMatchObject({
      channel: 'property',
      // `nodePropertyKey` joins the two with a NUL byte, which is the right Map key
      // and an unquotable one in a file — the artifact writes it dotted.
      key: 'ScoreLabel.text',
      from: 'Score: 0',
      to: 'Score: 1',
    });
    expect(observed.find(delta => delta.channel === 'axis')).toMatchObject({
      key: 'Horizontal',
      from: 0,
      to: 0.01,
    });

    // None of it is in the reply, in any shape: the reply has no delta channel at all,
    // and its timeline only ever carries game-state paths, presence and errors.
    expect(result).not.toHaveProperty('observed');
    expect(result.timeline?.some(entry => entry.note.includes('worldPosition'))).toBeFalsy();
  });

  it('keeps the monkey presses the report drops out of the middle of its log', async () => {
    const runner = makeRunner();
    const protocol = new RunProtocolRecorder('main', 42);
    const performed: MonkeyAction[] = [];
    const world: MonkeyWorld = {
      inventory: () =>
        Promise.resolve({
          controls: [
            {
              nodeId: 'play-id',
              name: 'PlayButton',
              type: 'Button2D',
              visible: true,
              reach: 'reachable',
              interactions: [{ name: 'click' }],
            },
          ],
          commands: [],
          actions: [],
        }),
      execute: action => {
        performed.push(action);
        return { status: 'sent' };
      },
      releaseDue: () => {},
      releaseAll: () => {},
    };
    const result = await runGameTestLoop(
      makeDeps(runner, { protocol, monkey: world }),
      makeSpec({
        until: [{ kind: 'frames', n: 70 }],
        maxFrames: 70,
        // One decision per frame, so the run outgrows the log's 20-head/40-tail window.
        monkey: {
          seed: 42,
          actions: [],
          everyFrames: 1,
          holdFrames: 2,
          maxActions: 200,
          invariants: {},
        },
      })
    );

    expect(performed).toHaveLength(70);
    // The reply admits the middle is gone; the marker is all a reader gets of it.
    expect(result.monkey?.logTruncated).toBe(true);
    expect(result.monkey?.log.join('\n')).toMatch(/… 10 action\(s\) not shown …/);
    expect(result.monkey?.log.length).toBeLessThan(70);

    const monkey = protocol.section().monkey;
    expect(monkey?.seed).toBe(42);
    expect(monkey?.actions).toHaveLength(70);
    expect(monkey?.actions[0]).toMatchObject({ frame: 1, status: 'sent' });
    // Data, not the driver's formatted line — that formatter is private to game-monkey.
    expect(monkey?.actions[0].action).toMatchObject({ kind: 'interaction', node: 'PlayButton' });
  });

  it('carries both snapshots and a diff wider than the reply’s 20-path cap', async () => {
    const runner = makeRunner();
    const protocol = new RunProtocolRecorder('main');
    // 30 scalars, all of which move: two more than the reply can carry, so the reply's
    // own diff is provably a sample and the artifact's is the whole thing.
    const wideState = (frame: number): Json =>
      Object.fromEntries(
        Array.from({ length: 30 }, (_unused, index) => [`v${index}`, frame * (index + 1)])
      );
    await runGameTestLoop(
      makeDeps(runner, {
        protocol,
        sampleGameState: () => ({ provider: 'demo', snapshot: wideState(runner.frames) }),
      }),
      makeSpec({ until: [{ kind: 'frames', n: 4 }] })
    );

    const outcomeState = protocol.section().outcomeState;
    expect(outcomeState?.frame).toBe(4);
    expect(outcomeState?.provider).toBe('demo');
    expect(outcomeState?.baseline).toEqual(wideState(0));
    expect(outcomeState?.snapshot).toEqual(wideState(4));
    // MAX_GAME_DIFF_PATHS in the reply is 20; the artifact has no such cap.
    expect(Object.keys(outcomeState?.changed ?? {})).toHaveLength(30);
    expect(outcomeState?.changed.v29).toEqual([0, 120]);
  });
});

/**
 * The service half: a run points at its protocol, and the reply it returns stays
 * small enough to be worth reading.
 */
describe('GameTestService.run — the artifact pointer', () => {
  const buildService = (store: RunProtocolStore | null) => {
    const runner = makeRunner();
    let score = 0;
    runner.onTick = frame => {
      score = frame;
    };
    (globalThis as Record<string, unknown>).__PIX3_GAME_DEBUG__ = {
      name: 'spec-game',
      snapshot: () => ({ score, frame: runner.frames }),
    };
    const service = new GameTestService();
    Object.defineProperty(service, 'playSession', {
      value: {
        getActiveRuntime: () => ({
          runner: Object.assign(runner, {
            getLiveNodeById: () => null,
            findLiveNodeByName: () => null,
            getLiveRootNodes: () => [],
          }),
          canvas: document.createElement('canvas'),
          windowRef: globalThis.window as Window,
        }),
        setFocusPauseSuppressed: vi.fn(),
        setPauseRequested: vi.fn(),
      },
      configurable: true,
    });
    service.setProtocolStore(store);
    return { service, runner };
  };

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__PIX3_GAME_DEBUG__;
  });

  it('writes the protocol and hands back a pointer, while the reply stays compact', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    const files = new Map<string, string>();
    const store: RunProtocolStore = {
      list: async () => [...files.keys()].sort(),
      save: async (name, text) => void files.set(name, text),
      delete: async name => void files.delete(name),
    };
    try {
      const { service } = buildService(store);

      const result = await service.run({ until: [{ kind: 'frames', n: 300 }], maxFrames: 300 });

      expect(result.ok).toBe(true);
      expect(result.artifact?.written).toBe(true);
      if (!result.artifact?.written) return;
      expect(result.artifact.path).toBe('design/tests/reports/0001-run-pass-f300.json');
      expect(result.artifact.contains).toMatch(/timeline event\(s\)/);

      const text = files.get('0001-run-pass-f300.json')!;
      // The whole point of the split: the reply is cheap to read and the file is not.
      expect(JSON.stringify(result).length).toBeLessThan(20_000);
      expect(text.length).toBeGreaterThan(JSON.stringify(result).length * 2);
      // Self-contained, and without the pointer that rotation would make stale.
      const doc = JSON.parse(text) as Record<string, unknown> & { reply: Record<string, unknown> };
      expect(doc.reply.verdict).toBe(result.verdict);
      expect(doc.reply.artifact).toBeUndefined();
      expect(doc.kind).toBe('game_run');
      expect(doc.editorVersion).toBe(CURRENT_EDITOR_VERSION.version);
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('says the protocol was lost when no project is open, instead of pointing at nothing', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = true;
    try {
      const { service } = buildService(null);

      const result = await service.run({ until: [{ kind: 'frames', n: 5 }] });

      expect(result.artifact?.written).toBe(false);
      expect(result.artifact && !result.artifact.written && result.artifact.reason).toMatch(
        /No project is open/
      );
      // The run itself is untouched — a missing artifact is never a failed run.
      expect(result.outcome?.kind).toBe('until');
      expect(result.verdict).toContain('PASS');
    } finally {
      appState.ui.isPlaying = false;
    }
  });

  it('attaches no artifact at all to a call that never ran', async () => {
    const { appState } = await import('@/state');
    appState.ui.isPlaying = false;
    const { service } = buildService(null);

    const result = await service.run({ until: [{ kind: 'frames', n: 5 }] });

    // Nothing ran, so there is no protocol to have lost: a `written: false` note here
    // would claim evidence was destroyed when none was ever collected.
    expect(result.ok).toBe(false);
    expect(result.artifact).toBeUndefined();
  });
});

/**
 * The loop's half of a bot run (§5.3, phase 8).
 *
 * The policy itself is spec'd in `game-bots.spec.ts` against a fake world; what is
 * checked here is the *loop's* four responsibilities towards it: whose verdict wins on
 * a frame where several could, that a crashed policy is never reported as a failed
 * game, that a policy which drove nothing cannot produce a pass, and that the session
 * is torn down before the game is handed back.
 */
describe('runGameTestLoop — bot runs', () => {
  interface FakeBot {
    finished: boolean;
    outcome: { pass: boolean; reason: string; frame: number } | null;
    crash: { message: string; stack?: string; frame: number } | null;
    report(): BotReport;
    dispose(): void;
    disposed: number;
  }

  function makeBot(
    over: {
      sent?: number;
      refused?: number;
      channel?: 'physical-input' | 'direct-action';
    } = {}
  ): FakeBot {
    const state: FakeBot = {
      finished: false,
      outcome: null,
      crash: null,
      disposed: 0,
      report: () => ({
        name: 'dodge',
        channel: over.channel ?? 'physical-input',
        frames: 10,
        sent: over.sent ?? 5,
        refused: over.refused ?? 0,
        ...(state.outcome ? { done: state.outcome } : {}),
        ...(state.crash ? { error: state.crash } : {}),
        log: [],
        notes: [],
      }),
      dispose: () => {
        state.disposed += 1;
      },
    };
    return state;
  }

  it('ends the run on the policy own pass, and the verdict is the policy sentence', async () => {
    const runner = makeRunner({ startMode: 'manual' });
    const bot = makeBot();
    runner.onTick = frame => {
      if (frame === 3) {
        bot.finished = true;
        bot.outcome = { pass: true, reason: 'reached the exit', frame: 3 };
      }
    };

    const result = await runGameTestLoop(
      makeDeps(runner, { bot }),
      makeSpec({ until: [{ kind: 'frames', n: 500 }], maxFrames: 500 })
    );

    expect(result.outcome?.kind).toBe('bot-pass');
    expect(result.outcome?.frame).toBe(3);
    expect(result.verdict).toContain('BOT PASS dodge [physical-input]');
    expect(result.verdict).toContain('reached the exit');
    expect(result.bot?.done?.reason).toBe('reached the exit');
  });

  it('reports a policy crash as bot-error, never as a game failure', async () => {
    const runner = makeRunner({ startMode: 'manual' });
    const bot = makeBot();
    runner.onTick = frame => {
      if (frame === 2) {
        bot.finished = true;
        bot.crash = { message: 'TypeError: hero is undefined', frame: 2 };
      }
    };

    const result = await runGameTestLoop(makeDeps(runner, { bot }), makeSpec());

    expect(result.outcome?.kind).toBe('bot-error');
    expect(result.verdict).toContain('BOT ERROR');
    expect(result.verdict).toContain('NOT in the game');
  });

  it('prefers a crash over a verdict the same policy also reached', async () => {
    const runner = makeRunner({ startMode: 'manual' });
    const bot = makeBot();
    runner.onTick = () => {
      bot.finished = true;
      bot.outcome = { pass: true, reason: 'claimed a win', frame: 1 };
      bot.crash = { message: 'Error: threw while deciding', frame: 1 };
    };

    const result = await runGameTestLoop(makeDeps(runner, { bot }), makeSpec());

    expect(result.outcome?.kind).toBe('bot-error');
  });

  it('lets a fail predicate win over the policy on the same frame', async () => {
    const runner = makeRunner({ startMode: 'manual' });
    const bot = makeBot();
    let errors = 0;
    runner.onTick = frame => {
      if (frame === 2) {
        errors = 1;
        bot.finished = true;
        bot.outcome = { pass: true, reason: 'claimed a win', frame: 2 };
      }
    };

    const result = await runGameTestLoop(
      makeDeps(runner, { bot, errorCount: () => errors }),
      makeSpec({ fail: [{ kind: 'newErrors' }] })
    );

    // An explicit predicate the caller wrote for THIS run outranks a stored policy's
    // opinion — a PASS that coincided with a crash is the false green to prevent.
    expect(result.outcome?.kind).toBe('fail');
    // The policy is still reported, as context rather than as the headline.
    expect(result.bot?.name).toBe('dodge');
  });

  it('refuses to call a run a pass when the policy drove nothing', async () => {
    const runner = makeRunner({ startMode: 'manual' });
    const bot = makeBot({ sent: 0, refused: 4 });
    runner.onTick = frame => {
      if (frame === 2) {
        bot.finished = true;
        bot.outcome = { pass: true, reason: 'looked fine to me', frame: 2 };
      }
    };

    const result = await runGameTestLoop(makeDeps(runner, { bot }), makeSpec());

    expect(result.outcome?.kind).toBe('bot-idle');
    expect(result.verdict).toContain('BOT NOTHING DRIVEN');
    expect(result.outcome?.detail).toContain('did not play');
  });

  it('rewrites a plain until-PASS of an idle policy too', async () => {
    const runner = makeRunner({ startMode: 'manual' });
    const bot = makeBot({ sent: 0 });

    const result = await runGameTestLoop(
      makeDeps(runner, { bot }),
      makeSpec({ until: [{ kind: 'frames', n: 3 }] })
    );

    expect(result.outcome?.kind).toBe('bot-idle');
    expect(result.outcome?.detail).toContain('nothing the policy did caused it');
  });

  it('leaves a bot-driven FAIL alone even when the policy drove nothing', async () => {
    const runner = makeRunner({ startMode: 'manual' });
    const bot = makeBot({ sent: 0 });
    runner.onTick = frame => {
      if (frame === 2) {
        bot.finished = true;
        bot.outcome = { pass: false, reason: 'nothing on screen was reachable', frame: 2 };
      }
    };

    const result = await runGameTestLoop(makeDeps(runner, { bot }), makeSpec());

    // A policy reporting that it could not play IS a finding, so the finding channel is
    // left exactly as it is — the same rule the monkey's `monkey-empty` follows.
    expect(result.outcome?.kind).toBe('bot-fail');
  });

  it('disposes the session before the game is handed back, exactly once', async () => {
    const runner = makeRunner({ startMode: 'manual' });
    const bot = makeBot();

    await runGameTestLoop(
      makeDeps(runner, { bot }),
      makeSpec({ until: [{ kind: 'frames', n: 2 }] })
    );

    expect(bot.disposed).toBe(1);
  });

  it('disposes the session even when the run ends on an error path', async () => {
    const runner = makeRunner({ startMode: 'manual', stopAfter: 1 });
    const bot = makeBot();

    const result = await runGameTestLoop(
      makeDeps(runner, { bot }),
      makeSpec({ until: [{ kind: 'frames', n: 50 }] })
    );

    expect(result.outcome?.kind).toBe('error');
    expect(bot.disposed).toBe(1);
  });

  it('names the direct-action caveat on a run the policy did not decide', async () => {
    const runner = makeRunner({ startMode: 'manual' });
    const bot = makeBot({ channel: 'direct-action' });

    const result = await runGameTestLoop(
      makeDeps(runner, { bot }),
      makeSpec({ until: [{ kind: 'frames', n: 2 }] })
    );

    expect(result.outcome?.kind).toBe('until');
    expect(result.verdict).toContain('no input binding is proven');
  });
});

describe('validateSpec — bot runs', () => {
  it('fills `until` with the frame budget so it is never written twice', () => {
    const validated = validateSpec({
      until: [],
      bot: { name: 'dodge', channel: 'physical-input' },
      maxFrames: 900,
    });
    expect('spec' in validated).toBe(true);
    if ('spec' in validated) {
      expect(validated.spec.until).toEqual([{ kind: 'frames', n: 900 }]);
      expect(validated.spec.maxFrames).toBe(900);
    }
  });

  it('keeps an explicit `until` as the caller wrote it', () => {
    const validated = validateSpec({
      until: [{ kind: 'gameStateChanged', path: 'score', by: 1 }],
      bot: { name: 'dodge', channel: 'physical-input' },
    });
    expect('spec' in validated && validated.spec.until).toHaveLength(1);
    expect('spec' in validated && validated.spec.until[0].kind).toBe('gameStateChanged');
  });

  it('refuses a run driven by both a policy and a monkey', () => {
    const validated = validateSpec({
      until: [{ kind: 'frames', n: 10 }],
      bot: { name: 'dodge', channel: 'physical-input' },
      monkey: { seed: 1 } as NormalizedMonkeySpec,
    });
    expect('error' in validated && validated.error).toContain('cannot combine `bot` with `monkey`');
  });
});
