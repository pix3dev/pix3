import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneService, type SceneServiceDelegate } from './SceneService';
import { InputService } from './InputService';
import { GameTime } from './GameTime';
import { Node2D } from '../nodes/Node2D';
import { Camera3D } from '../nodes/3D/Camera3D';
import { CameraBrainBehavior } from '../behaviors/CameraBrainBehavior';
import { AnimationPlayerBehavior } from '../animation/AnimationPlayerBehavior';
import type { AudioService } from './AudioService';
import type { AssetLoader } from './AssetLoader';
import type { ResourceManager } from './ResourceManager';

const CUTSCENE_CLIP = {
  clips: [
    {
      name: 'Intro',
      duration: 1,
      loop: false,
      tracks: [
        {
          kind: 'property',
          targetPath: '',
          property: 'position',
          valueType: 'vector2',
          keys: [
            { time: 0, value: [0, 0], easing: 'linear' },
            { time: 1, value: [100, 0], easing: 'linear' },
          ],
        },
        {
          // A state-changing beat near the end — must survive a skip (D8).
          kind: 'event',
          name: 'Events',
          targetPath: '',
          keys: [{ time: 0.9, signal: 'cutscene_beat', args: '' }],
        },
      ],
    },
  ],
};

// ── Deterministic clock + rAF harness ────────────────────────────────────────
let now = 0;
let rafCallbacks = new Map<number, FrameRequestCallback>();
let nextRafId = 1;

function flushRaf(): void {
  let guard = 0;
  while (rafCallbacks.size > 0 && guard++ < 10000) {
    const entries = [...rafCallbacks.values()];
    rafCallbacks = new Map();
    for (const cb of entries) {
      cb(now);
    }
  }
}

const cleanups: Array<() => void> = [];

interface HarnessOptions {
  animations?: unknown;
  autoplay?: string;
  withPlayer?: boolean;
  camera?: Camera3D | null;
}

function makeHarness(opts: HarnessOptions = {}) {
  const input = new InputService();
  const host = new Node2D({ id: 'host', name: 'Host' });
  const player = new AnimationPlayerBehavior('player-1', 'core:AnimationPlayer');
  const service = new SceneService();
  player.config = {
    ...player.config,
    autoplay: opts.autoplay ?? '',
    animations: opts.animations ?? CUTSCENE_CLIP,
  };
  player.scene = service;
  if (opts.withPlayer !== false) {
    host.addComponent(player);
  }
  const camera = opts.camera ?? null;

  const delegate: SceneServiceDelegate = {
    getActiveCameraNode: () => camera,
    getActiveCamera2DNode: () => null,
    getInputService: () => input,
    getUICamera: () => null,
    getLogicalCameraSize: () => ({ width: 1920, height: 1080 }),
    setActiveCameraNode: () => undefined,
    findNodeById: id => (id === 'host' ? host : null),
    getRootNodes: () => [host],
    getAudioService: () => null as unknown as AudioService,
    getAssetLoader: () => null as unknown as AssetLoader,
    getResourceManager: () => null as unknown as ResourceManager,
    getECSService: () => null,
    getGameTime: () => new GameTime(),
    raycastViewport: () => null,
    reportFrameProfilerActivities: () => undefined,
  };
  service.setDelegate(delegate);

  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  document.body.appendChild(parent);
  service.attachCanvas(canvas);
  input.attach(canvas);

  cleanups.push(() => {
    input.detach();
    parent.remove();
  });

  return { service, input, host, player, parent, canvas };
}

function barCount(parent: HTMLElement): number {
  return parent.querySelectorAll('div').length;
}

beforeEach(() => {
  now = 0;
  rafCallbacks = new Map();
  nextRafId = 1;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    const id = nextRafId++;
    rafCallbacks.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    rafCallbacks.delete(id);
  });
});

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CutsceneApi.playCinematic', () => {
  it('mounts two letterbox bars and locks input', () => {
    const { service, input, parent } = makeHarness();

    service.cutscene.playCinematic('host', { skippableAfter: 0 });

    expect(barCount(parent)).toBe(2);
    expect(input.isLocked).toBe(true);

    // Locked: a keydown does not register.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a' }));
    expect(input.getButton('Key_KeyA')).toBe(false);
  });

  it('gates the skip gesture until skippableAfter, then resolves "skipped" and fires the end beat once', async () => {
    const { service, input, host, canvas } = makeHarness();
    const beat = vi.fn();
    host.connect('cutscene_beat', host, beat);

    const handle = service.cutscene.playCinematic('host', { skippableAfter: 2, letterbox: false });

    // Before the threshold (1s < 2s): the tap does not skip.
    now = 1000;
    canvas.dispatchEvent(new Event('pointerdown'));
    expect(handle.isActive).toBe(true);

    // After the threshold: the tap skips.
    now = 2500;
    canvas.dispatchEvent(new Event('pointerdown'));

    await expect(handle.done).resolves.toBe('skipped');
    expect(input.isLocked).toBe(false);
    expect(beat).toHaveBeenCalledTimes(1);
  });

  it('resolves "finished" when the clip reaches its end, unlocks, and retracts the bars', async () => {
    const { service, input, player, parent } = makeHarness();

    const handle = service.cutscene.playCinematic('host', {});
    expect(barCount(parent)).toBe(2);

    // Drive the clip past its 1s duration.
    player.onUpdate(0.5);
    player.onUpdate(0.6);

    await expect(handle.done).resolves.toBe('finished');
    expect(input.isLocked).toBe(false);

    // The bars retract over real time, then remove themselves.
    now += 1000;
    flushRaf();
    expect(barCount(parent)).toBe(0);
  });

  it('warns for a looping clip, never auto-resolves, but a programmatic skip() still ends it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const looping = { clips: [{ ...CUTSCENE_CLIP.clips[0], loop: true }] };
    const { service, player } = makeHarness({ animations: looping });

    const handle = service.cutscene.playCinematic('host', { letterbox: false });

    for (let i = 0; i < 50; i += 1) {
      player.onUpdate(0.1);
    }
    let resolved = false;
    void handle.done.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(handle.isActive).toBe(true);

    handle.skip();
    await expect(handle.done).resolves.toBe('skipped');
    expect(warn).toHaveBeenCalled();
  });

  it('stopAll (SceneRunner.stop path) resolves "stopped", removes bars synchronously, unlocks', async () => {
    const { service, input, parent } = makeHarness();

    const handle = service.cutscene.playCinematic('host', {});
    expect(barCount(parent)).toBe(2);

    service.cancelActiveCutscene(); // → CutsceneApi.stopAll('stopped')

    await expect(handle.done).resolves.toBe('stopped');
    expect(input.isLocked).toBe(false);
    expect(barCount(parent)).toBe(0); // no retract animation on a hard stop
  });

  it('hard-stops the current cutscene when a new one starts (D10)', async () => {
    const { service } = makeHarness();

    const first = service.cutscene.playCinematic('host', { letterbox: false });
    const second = service.cutscene.playCinematic('host', { letterbox: false });

    await expect(first.done).resolves.toBe('stopped');
    expect(second.isActive).toBe(true);
  });

  it('returns an inert "stopped" handle without side effects for an unknown id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, input, parent } = makeHarness();

    const handle = service.cutscene.playCinematic('does-not-exist', {});

    await expect(handle.done).resolves.toBe('stopped');
    expect(input.isLocked).toBe(false);
    expect(barCount(parent)).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('returns an inert handle when the node has no AnimationPlayer', async () => {
    const { service, input, parent } = makeHarness({ withPlayer: false });

    const handle = service.cutscene.playCinematic('host', {});

    await expect(handle.done).resolves.toBe('stopped');
    expect(input.isLocked).toBe(false);
    expect(barCount(parent)).toBe(0);
  });

  it('returns an inert handle when the requested clip does not exist', async () => {
    const { service, input, parent } = makeHarness();

    const handle = service.cutscene.playCinematic('host', { clip: 'NoSuchClip' });

    await expect(handle.done).resolves.toBe('stopped');
    expect(input.isLocked).toBe(false);
    expect(barCount(parent)).toBe(0);
  });

  it('fireSkippedEvents:false suppresses the remaining event keys on skip', async () => {
    const { service, host } = makeHarness();
    const beat = vi.fn();
    host.connect('cutscene_beat', host, beat);

    const handle = service.cutscene.playCinematic('host', {
      skippableAfter: 0,
      letterbox: false,
      fireSkippedEvents: false,
    });

    handle.skip();

    await expect(handle.done).resolves.toBe('skipped');
    expect(beat).not.toHaveBeenCalled();
  });

  it('skips on a skip-key keydown after the threshold, and ignores non-skip keys', async () => {
    const { service } = makeHarness();
    const handle = service.cutscene.playCinematic('host', {
      skippableAfter: 1,
      letterbox: false,
      skipKeys: ['Escape', 'Space'],
    });

    now = 2000;
    // A non-skip key does nothing.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q' }));
    expect(handle.isActive).toBe(true);

    // A configured skip key ends it.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
    await expect(handle.done).resolves.toBe('skipped');
  });

  it('arms the CameraBrain blend override on entry AND again on natural finish (D7 exit blend)', async () => {
    const camera = new Camera3D({ id: 'cam', name: 'Render', projection: 'perspective' });
    const brain = new CameraBrainBehavior('core:CameraBrain', 'core:CameraBrain');
    camera.addComponent(brain);
    const override = vi.spyOn(brain, 'overrideNextBlend');

    const { service, player } = makeHarness({ camera });
    const handle = service.cutscene.playCinematic('host', { blendDuration: 0.8, letterbox: false });

    // Entry arm.
    expect(override).toHaveBeenCalledTimes(1);
    expect(override).toHaveBeenLastCalledWith(0.8, undefined);

    // Play the clip to its end — the exit blend must be armed again.
    player.onUpdate(0.5);
    player.onUpdate(0.6);
    await expect(handle.done).resolves.toBe('finished');

    expect(override).toHaveBeenCalledTimes(2);
  });

  it('removes the letterbox bars immediately on a hard stop even mid-retract (D9)', async () => {
    const { service, parent, player } = makeHarness();
    const handle = service.cutscene.playCinematic('host', {}); // letterbox on
    expect(barCount(parent)).toBe(2);

    // Finish naturally: settleSoft schedules an async bar retract; bars still mounted.
    player.onUpdate(0.5);
    player.onUpdate(0.6);
    await expect(handle.done).resolves.toBe('finished');
    expect(barCount(parent)).toBe(2); // retract not yet flushed

    // A scene stop lands during the retract window — bars must be ripped down now,
    // not left dangling on the rAF closure (would stick in a hidden/throttled tab).
    service.cancelActiveCutscene();
    expect(barCount(parent)).toBe(0);
  });
});
