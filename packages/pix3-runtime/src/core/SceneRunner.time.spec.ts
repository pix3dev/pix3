import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AudioService } from './AudioService';
import type { RuntimeRenderer } from './RuntimeRenderer';
import type { SceneGraph } from './SceneManager';
import type { SceneManager } from './SceneManager';
import type { InputService } from './InputService';
import type { SceneService } from './SceneService';
import { SceneRunner, type SceneRunnerFrameSample } from './SceneRunner';
import { AssetLoader } from './AssetLoader';
import { ResourceManager } from './ResourceManager';
import { Script } from './ScriptComponent';
import { Camera3D } from '../nodes/3D/Camera3D';
import {
  DEFAULT_FIXED_DELTA_SEC,
  MAX_TICKS_PER_FRAME,
  resolveRuntimeTimeConfig,
} from './runtime-time';

/**
 * Frame-driver contract (§5.1 of `.plans/agent-gameplay-testing.md`). Every row
 * of the invariant table in that section has a test here; the mode-switch /
 * loop-rearm cases are the ones that decide whether a speed-up looks like a
 * working game or a frozen one, so they are covered from both directions.
 */

function createRendererStub(): RuntimeRenderer {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 320, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: 160, configurable: true });
  return {
    beginStatsFrame: vi.fn(),
    domElement: canvas,
    render: vi.fn(),
    setAutoClear: vi.fn(),
    clear: vi.fn(),
    clearDepth: vi.fn(),
    getStatsSnapshot: vi.fn(() => ({
      calls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      geometries: 0,
      textures: 0,
    })),
  } as unknown as RuntimeRenderer;
}

/** Mixer stub that remembers the master volume, so mute/restore is observable. */
function createAudioStub(): AudioService & {
  setBusVolume: ReturnType<typeof vi.fn>;
  getBusVolume: ReturnType<typeof vi.fn>;
} {
  let masterVolume = 1;
  return {
    stopAll: vi.fn(),
    resetBuses: vi.fn(() => {
      masterVolume = 1;
    }),
    applySnapshot: vi.fn(),
    getActivePlaybackSnapshot: vi.fn(() => []),
    getBusVolume: vi.fn(() => masterVolume),
    setBusVolume: vi.fn((_bus: string, volume: number) => {
      masterVolume = volume;
    }),
  } as unknown as AudioService & {
    setBusVolume: ReturnType<typeof vi.fn>;
    getBusVolume: ReturnType<typeof vi.fn>;
  };
}

class DtRecordingScript extends Script {
  readonly received: number[] = [];

  constructor() {
    super('time-dt-script', 'TimeDtScript');
  }

  override onUpdate(dt: number): void {
    this.received.push(dt);
  }
}

interface RunnerInternals {
  activeCamera: Camera3D;
  runtimeGraph: SceneGraph;
  sceneService: SceneService;
  inputService: InputService;
  isRunning: boolean;
  isPaused: boolean;
  animationFrameId: number | null;
  fixedTimeAccumulator: number;
  frameNumber: number;
  tick: () => void;
  render: () => void;
  clock: { getDelta: () => number };
}

interface Harness {
  runner: SceneRunner;
  internals: RunnerInternals;
  script: DtRecordingScript;
  audio: ReturnType<typeof createAudioStub>;
  renderSpy: ReturnType<typeof vi.spyOn>;
  raf: ReturnType<typeof vi.spyOn>;
  caf: ReturnType<typeof vi.spyOn>;
  samples: SceneRunnerFrameSample[];
}

/**
 * A runner in the state the loop cares about: running, with one camera node
 * carrying a dt-recording script. `render` is stubbed out — the invariants are
 * about *how many* paints happen and when, not about pixels.
 */
function createHarness(): Harness {
  const audio = createAudioStub();
  const runner = new SceneRunner(
    {} as unknown as SceneManager,
    createRendererStub(),
    audio,
    new AssetLoader(new ResourceManager('/'), new AudioService())
  );
  const cameraNode = new Camera3D({
    id: 'time-camera',
    name: 'Camera',
    projection: 'perspective',
  });
  const script = new DtRecordingScript();
  cameraNode.addComponent(script);

  const internals = runner as unknown as RunnerInternals;
  cameraNode.scene = internals.sceneService;
  internals.activeCamera = cameraNode;
  internals.runtimeGraph = {
    version: '1.0.0',
    metadata: {},
    rootNodes: [cameraNode],
    nodeMap: new Map([[cameraNode.nodeId, cameraNode]]),
  };
  internals.isRunning = true;

  const renderSpy = vi.spyOn(internals, 'render').mockImplementation(() => {});
  vi.spyOn(internals.clock, 'getDelta').mockReturnValue(1 / 30);
  // `vi.spyOn` hands back an existing spy when one is already installed, so clear
  // the counters here rather than trusting a fresh mock per harness.
  const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(7);
  raf.mockClear();
  const caf = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  caf.mockClear();

  const samples: SceneRunnerFrameSample[] = [];
  runner.subscribeFrameStats(sample => samples.push(sample));

  return { runner, internals, script, audio, renderSpy, raf, caf, samples };
}

describe('runtime time config validation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fills defaults: realtime, 1/60 s, one tick per frame, paint every tick, audio muted off-realtime', () => {
    expect(resolveRuntimeTimeConfig({ mode: 'realtime' })).toEqual({
      mode: 'realtime',
      fixedDeltaSec: DEFAULT_FIXED_DELTA_SEC,
      ticksPerFrame: 1,
      renderEveryNTicks: 1,
      muteAudio: true,
    });
  });

  it('refuses a non-positive or non-finite fixedDeltaSec', () => {
    expect(() => resolveRuntimeTimeConfig({ mode: 'fixed', fixedDeltaSec: 0 })).toThrow(RangeError);
    expect(() => resolveRuntimeTimeConfig({ mode: 'fixed', fixedDeltaSec: -0.016 })).toThrow(
      RangeError
    );
    expect(() => resolveRuntimeTimeConfig({ mode: 'fixed', fixedDeltaSec: Number.NaN })).toThrow(
      RangeError
    );
  });

  it('refuses an unknown mode', () => {
    expect(() =>
      resolveRuntimeTimeConfig({ mode: 'turbo' } as unknown as { mode: 'fixed' })
    ).toThrow(TypeError);
  });

  it('clamps ticksPerFrame to 1..240 and rounds it', () => {
    expect(resolveRuntimeTimeConfig({ mode: 'fixed', ticksPerFrame: 0 }).ticksPerFrame).toBe(1);
    expect(resolveRuntimeTimeConfig({ mode: 'fixed', ticksPerFrame: -5 }).ticksPerFrame).toBe(1);
    expect(resolveRuntimeTimeConfig({ mode: 'fixed', ticksPerFrame: 1000 }).ticksPerFrame).toBe(
      MAX_TICKS_PER_FRAME
    );
    expect(resolveRuntimeTimeConfig({ mode: 'fixed', ticksPerFrame: 3.6 }).ticksPerFrame).toBe(4);
    expect(
      resolveRuntimeTimeConfig({ mode: 'fixed', ticksPerFrame: Number.POSITIVE_INFINITY })
        .ticksPerFrame
    ).toBe(1);
  });

  it('reads renderEveryNTicks < 1 as 1 and defaults it to one paint per fixed batch', () => {
    expect(
      resolveRuntimeTimeConfig({ mode: 'fixed', renderEveryNTicks: 0 }).renderEveryNTicks
    ).toBe(1);
    expect(
      resolveRuntimeTimeConfig({ mode: 'fixed', renderEveryNTicks: -3 }).renderEveryNTicks
    ).toBe(1);
    // Omitted in fixed mode ⇒ one paint per batch.
    expect(resolveRuntimeTimeConfig({ mode: 'fixed', ticksPerFrame: 8 }).renderEveryNTicks).toBe(8);
    // Omitted elsewhere ⇒ paint every tick.
    expect(resolveRuntimeTimeConfig({ mode: 'manual' }).renderEveryNTicks).toBe(1);
    // Explicit always wins.
    expect(
      resolveRuntimeTimeConfig({ mode: 'fixed', ticksPerFrame: 8, renderEveryNTicks: 2 })
        .renderEveryNTicks
    ).toBe(2);
  });

  it('a rejected config leaves the runner on the mode it already had', () => {
    const { runner } = createHarness();
    runner.setTimeMode({ mode: 'fixed', ticksPerFrame: 4 });

    expect(() => runner.setTimeMode({ mode: 'fixed', fixedDeltaSec: 0 })).toThrow(RangeError);

    expect(runner.getTimeMode()).toMatchObject({ mode: 'fixed', ticksPerFrame: 4 });
  });
});

describe('SceneRunner time modes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('realtime: one tick per animation frame, wall-clock dt, loop re-armed', () => {
    const { internals, script, renderSpy, raf, samples } = createHarness();

    internals.tick();
    internals.tick();

    expect(script.received).toEqual([1 / 30, 1 / 30]);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(samples).toHaveLength(2);
    expect(raf).toHaveBeenCalledTimes(2);
  });

  it('fixed: ticksPerFrame ticks of exactly fixedDeltaSec, a single paint per batch', () => {
    const { runner, internals, script, renderSpy, samples } = createHarness();
    runner.setTimeMode({ mode: 'fixed', fixedDeltaSec: 1 / 60, ticksPerFrame: 4 });

    internals.tick();

    expect(script.received).toEqual([1 / 60, 1 / 60, 1 / 60, 1 / 60]);
    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(samples).toHaveLength(4);
  });

  it('manual: nothing is scheduled and nothing ticks until stepFrames is called', () => {
    const { runner, internals, script, raf, samples } = createHarness();
    runner.setTimeMode({ mode: 'manual', fixedDeltaSec: 1 / 50 });
    raf.mockClear();

    // A stray animation frame (one already in flight when the mode switched)
    // must not sneak a tick past a manual runner.
    internals.tick();
    expect(script.received).toEqual([]);
    expect(raf).not.toHaveBeenCalled();

    const executed = runner.stepFrames(3);

    expect(executed).toBe(3);
    expect(script.received).toEqual([1 / 50, 1 / 50, 1 / 50]);
    expect(samples).toHaveLength(3);
    expect(raf).not.toHaveBeenCalled();
  });

  it('stepFrames defaults to a single tick and refuses outside manual mode', () => {
    const { runner, script } = createHarness();
    // Spy after the harness: constructing an AudioService / THREE.Clock warns too.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(runner.stepFrames(2)).toBe(0);
    expect(script.received).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'manual' time mode"));

    runner.setTimeMode({ mode: 'manual' });
    expect(runner.stepFrames()).toBe(1);
    expect(script.received).toHaveLength(1);
  });
});

describe('SceneRunner time mode invariants (§5.1 table)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Row 1 — "смена режима на ходу"
  it('applies a mid-run mode change from the next tick and resets the fixed-step accumulator', () => {
    const { runner, internals, script } = createHarness();

    internals.tick(); // realtime frame
    internals.fixedTimeAccumulator = 0.42;

    runner.setTimeMode({ mode: 'fixed', fixedDeltaSec: 0.02, ticksPerFrame: 2 });
    expect(internals.fixedTimeAccumulator).toBe(0);

    internals.tick(); // first frame under the new contract

    expect(script.received).toEqual([1 / 30, 0.02, 0.02]);
  });

  // Row 1 — the loop must follow the mode in both directions.
  it('cancels the loop when entering manual and re-arms it when leaving', () => {
    const { runner, internals, raf, caf } = createHarness();

    internals.tick();
    expect(internals.animationFrameId).toBe(7);

    runner.setTimeMode({ mode: 'manual' });
    expect(caf).toHaveBeenCalledWith(7);
    expect(internals.animationFrameId).toBeNull();

    raf.mockClear();
    runner.setTimeMode({ mode: 'fixed', ticksPerFrame: 2 });
    expect(raf).toHaveBeenCalledTimes(1);
    expect(internals.animationFrameId).toBe(7);

    // Re-arming is idempotent: a second switch must not stack a second frame.
    raf.mockClear();
    runner.setTimeMode({ mode: 'realtime' });
    expect(raf).not.toHaveBeenCalled();
  });

  it('never arms a frame while the runner is paused, and resuming a manual runner does not tick', () => {
    const { runner, internals, script, raf } = createHarness();
    runner.pause();
    raf.mockClear();

    runner.setTimeMode({ mode: 'fixed', ticksPerFrame: 2 });
    expect(raf).not.toHaveBeenCalled();
    expect(script.received).toEqual([]);

    runner.setTimeMode({ mode: 'manual' });
    runner.resume();
    expect(raf).not.toHaveBeenCalled();
    expect(script.received).toEqual([]);
    expect(internals.animationFrameId).toBeNull();
  });

  it('drains the wall clock when returning to realtime so the first frame is not a giant delta', () => {
    const { runner, internals } = createHarness();
    const getDelta = internals.clock.getDelta as unknown as ReturnType<typeof vi.fn>;

    runner.setTimeMode({ mode: 'manual' });
    runner.stepFrames(2);
    getDelta.mockClear();

    runner.setTimeMode({ mode: 'realtime' });
    expect(getDelta).toHaveBeenCalledTimes(1); // the discard

    // Already realtime — no further discarding, or every re-assert would eat a frame.
    getDelta.mockClear();
    runner.setTimeMode({ mode: 'realtime' });
    expect(getDelta).not.toHaveBeenCalled();
  });

  // Row 2 — "pause()/resume() ортогональны режиму"
  it('manual + pause: stepFrames is ignored and returns 0 until resume', () => {
    const { runner, script } = createHarness();
    runner.setTimeMode({ mode: 'manual' });

    runner.pause();
    expect(runner.stepFrames(5)).toBe(0);
    expect(script.received).toEqual([]);

    runner.resume();
    expect(runner.stepFrames(2)).toBe(2);
    expect(script.received).toHaveLength(2);
  });

  // Row 3 — "stepFrames во время активного тика"
  it('refuses a reentrant stepFrames from inside a tick, returning 0 with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runner, script } = createHarness();
    runner.setTimeMode({ mode: 'manual' });

    const nested: number[] = [];
    const unsubscribe = runner.subscribeFrameStats(() => {
      nested.push(runner.stepFrames(1));
    });

    expect(runner.stepFrames(1)).toBe(1);
    unsubscribe();

    expect(nested).toEqual([0]); // the inner call did nothing
    expect(script.received).toHaveLength(1); // and produced no extra tick
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reentrancy'));
  });

  // Row 4 — "исключение в runOneTick"
  it('aborts a manual batch on a throw and reports only the ticks that completed', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runner, internals, script } = createHarness();
    runner.setTimeMode({ mode: 'manual' });

    let paints = 0;
    (internals.render as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      paints += 1;
      if (paints === 3) throw new Error('render exploded');
    });

    expect(runner.stepFrames(5)).toBe(2);
    // The third tick ran its logic but never completed, and the batch stopped there.
    expect(script.received).toHaveLength(3);
    expect(error).toHaveBeenCalled();

    // The runner is not wedged: the next batch continues from where it stopped.
    expect(runner.stepFrames(1)).toBe(1);
  });

  it('keeps the existing updateGameLogicSafe boundary: a throwing script never breaks the batch', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runner, internals } = createHarness();
    runner.setTimeMode({ mode: 'manual' });

    class ThrowingScript extends Script {
      constructor() {
        super('throwing-script', 'ThrowingScript');
      }
      override onUpdate(): void {
        throw new Error('script exploded');
      }
    }
    internals.activeCamera.addComponent(new ThrowingScript());

    expect(runner.stepFrames(3)).toBe(3);
    expect(error).toHaveBeenCalled();
  });

  // Row 5 — "renderEveryNTicks и subscribeFrameStats"
  it('notifies frame listeners on every tick while painting once per renderEveryNTicks group', () => {
    const { runner, internals, renderSpy, samples } = createHarness();
    runner.setTimeMode({
      mode: 'fixed',
      fixedDeltaSec: 1 / 60,
      ticksPerFrame: 6,
      renderEveryNTicks: 3,
    });

    internals.tick();

    expect(samples).toHaveLength(6);
    expect(samples.map(sample => sample.frameNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(renderSpy).toHaveBeenCalledTimes(2);
    // A tick that skipped its paint reports renderMs 0 — nothing was submitted —
    // so totalFrameMs collapses to logicMs for it.
    expect(samples[0]?.renderMs).toBe(0);
    expect(samples[1]?.renderMs).toBe(0);
    expect(samples[0]?.totalFrameMs).toBe(samples[0]?.logicMs);
    // The reported dt is the driver's delta, not wall clock.
    expect(samples[3]?.dt).toBeCloseTo(1 / 60, 6);
  });

  // Row 6 — "renderOnce() в manual"
  it('renderOnce paints without advancing logic in manual mode', () => {
    const { runner, internals, script, renderSpy } = createHarness();
    runner.setTimeMode({ mode: 'manual' });
    runner.stepFrames(1);
    renderSpy.mockClear();

    expect(runner.renderOnce()).toBe(true);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(script.received).toHaveLength(1);
    expect(internals.frameNumber).toBe(1);
  });

  // Row 7 — "pending-ввод между тиками пачки"
  it('lands input queued before a batch on the first tick only', () => {
    const { runner, internals } = createHarness();
    runner.setTimeMode({ mode: 'fixed', ticksPerFrame: 3 });

    const input = internals.inputService as unknown as {
      pendingKeyEvents: { code: string }[];
      keyEvents: { code: string }[];
    };
    input.pendingKeyEvents.push({ code: 'ArrowLeft' });

    const perTick: number[] = [];
    const unsubscribe = runner.subscribeFrameStats(() => {
      perTick.push(input.keyEvents.length);
    });
    internals.tick();
    unsubscribe();

    expect(perTick).toEqual([1, 0, 0]);
  });
});

describe('SceneRunner time mode audio', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('silences the master bus outside realtime and restores the authored level on return', () => {
    const { runner, audio } = harness;
    audio.getBusVolume.mockReturnValue(0.4); // a game-authored master level

    runner.setTimeMode({ mode: 'fixed', ticksPerFrame: 8 });
    expect(audio.setBusVolume).toHaveBeenCalledWith('master', 0, expect.any(Number));

    audio.setBusVolume.mockClear();
    // manual is also non-realtime: no second write on the way through.
    runner.setTimeMode({ mode: 'manual' });
    expect(audio.setBusVolume).not.toHaveBeenCalled();

    runner.setTimeMode({ mode: 'realtime' });
    expect(audio.setBusVolume).toHaveBeenCalledWith('master', 0.4, expect.any(Number));
  });

  it('does not touch the mixer per tick, only on the state change', () => {
    const { runner, internals, audio } = harness;
    runner.setTimeMode({ mode: 'fixed', ticksPerFrame: 4 });
    audio.setBusVolume.mockClear();

    internals.tick();
    internals.tick();

    expect(audio.setBusVolume).not.toHaveBeenCalled();
  });

  it('leaves audio alone when muteAudio is false', () => {
    const { runner, audio } = harness;
    runner.setTimeMode({ mode: 'fixed', ticksPerFrame: 8, muteAudio: false });
    expect(audio.setBusVolume).not.toHaveBeenCalled();
  });

  it('restores the master bus on stop even when no scene graph was loaded', () => {
    const { runner, internals, audio } = harness;
    internals.runtimeGraph = null as unknown as SceneGraph;
    runner.setTimeMode({ mode: 'manual' });
    audio.setBusVolume.mockClear();

    runner.stop();

    expect(audio.setBusVolume).toHaveBeenCalledWith('master', 1, expect.any(Number));
  });
});
