import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mesh } from 'three';

import { SceneService, type SceneServiceDelegate } from './SceneService';
import { GameTime } from './GameTime';
import { InputService } from './InputService';
import { NodeBase } from '../nodes/NodeBase';
import { Group2D } from '../nodes/2D/Group2D';
import { ColorRect2D } from '../nodes/2D/ColorRect2D';
import { Sprite2D } from '../nodes/2D/Sprite2D';
import type { AudioService } from './AudioService';
import type { AssetLoader } from './AssetLoader';
import type { ResourceManager } from './ResourceManager';

// A failing assertion skips the `mockRestore()` at the end of its test, and
// vitest hands the NEXT `spyOn` the same still-installed mock — so one real
// failure cascades into bogus call-count failures downstream. Restore centrally.
afterEach(() => {
  vi.restoreAllMocks();
});

interface Harness {
  service: SceneService;
  root: Group2D;
  sprite: Sprite2D;
  rect: ColorRect2D;
  gameTime: GameTime;
  /** Advance the tween clock the way SceneRunner does — scaled seconds. */
  advance(seconds: number, step?: number): void;
}

function makeHarness(): Harness {
  const gameTime = new GameTime();
  const root = new Group2D({ id: 'world', name: 'World' });
  const sprite = new Sprite2D({ id: 'ball', name: 'ball' });
  const rect = new ColorRect2D({ id: 'panel', name: 'panel', width: 100, height: 40 });
  root.adoptChild(sprite);
  root.adoptChild(rect);
  const roots: NodeBase[] = [root];

  const service = new SceneService();
  const delegate: SceneServiceDelegate = {
    getActiveCameraNode: () => null,
    getActiveCamera2DNode: () => null,
    getInputService: () => new InputService(),
    getUICamera: () => null,
    getLogicalCameraSize: () => ({ width: 1080, height: 1920 }),
    setActiveCameraNode: () => undefined,
    findNodeById: id => roots.map(node => node.findById(id)).find(Boolean) ?? null,
    getRootNodes: () => roots,
    getAudioService: () => null as unknown as AudioService,
    getAssetLoader: () => null as unknown as AssetLoader,
    getResourceManager: () => null as unknown as ResourceManager,
    getECSService: () => null,
    getGameTime: () => gameTime,
    raycastViewport: () => null,
    reportFrameProfilerActivities: () => undefined,
    loadAndStartScene: () => Promise.resolve(),
  };
  service.setDelegate(delegate);

  const advance = (seconds: number, step = 1 / 60): void => {
    // `> 1e-9` rather than `> 0`: float accumulation otherwise leaves a sliver of a
    // frame behind and the last tick of a tween never runs.
    for (let left = seconds; left > 1e-9; left -= step) {
      service.updateTweens(Math.min(step, left));
    }
  };

  return { service, root, sprite, rect, gameTime, advance };
}

describe('scene.tween.to / plain objects', () => {
  it('reaches the end value exactly at the duration', async () => {
    const { service, advance } = makeHarness();
    const state = { score: 0 };

    const handle = service.tween.to(state, { score: 100 }, { durationSec: 0.5, ease: 'linear' });
    expect(handle.isRunning).toBe(true);

    advance(0.25);
    expect(state.score).toBeCloseTo(50, 1);
    expect(handle.isRunning).toBe(true);

    advance(0.25);
    expect(state.score).toBe(100);
    expect(handle.isRunning).toBe(false);
    await expect(handle.finished).resolves.toBe('completed');
  });

  it('applies the easing curve — linear and cubicOut differ at the midpoint', () => {
    const { service, advance } = makeHarness();
    const linear = { v: 0 };
    const eased = { v: 0 };

    service.tween.to(linear, { v: 100 }, { durationSec: 0.4, ease: 'linear' });
    service.tween.to(eased, { v: 100 }, { durationSec: 0.4, ease: 'cubicOut' });

    advance(0.2);
    expect(linear.v).toBeCloseTo(50, 1);
    // cubicOut front-loads the motion: 1 - (1 - 0.5)^3 = 0.875.
    expect(eased.v).toBeCloseTo(87.5, 1);
  });

  it('walks a dotted property path', () => {
    const { service, advance } = makeHarness();
    const state = { camera: { shake: { amount: 0 } } };

    service.tween.to(state, { 'camera.shake.amount': 10 }, { durationSec: 0.2, ease: 'linear' });
    advance(0.2);

    expect(state.camera.shake.amount).toBeCloseTo(10, 6);
  });

  it('waits out the delay and captures the start value only when it begins', () => {
    const { service, advance } = makeHarness();
    const state = { v: 0 };

    service.tween.to(state, { v: 10 }, { durationSec: 0.2, delaySec: 0.2, ease: 'linear' });
    advance(0.2);
    expect(state.v).toBe(0);

    // Moved while the tween was still waiting: the tween must start from HERE.
    state.v = 100;
    advance(0.1);
    expect(state.v).toBeCloseTo(55, 0);
  });

  it('skips a property that is not a number on the target, and warns once', () => {
    const { service, advance } = makeHarness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const state = { label: 'x', v: 0 };

    service.tween.to(state, { label: 5, v: 1 }, { durationSec: 0.1, ease: 'linear' });
    advance(0.1);

    expect(state.label).toBe('x');
    expect(state.v).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('scene.tween / repeat, yoyo, cancel, killAll', () => {
  it('repeats the requested number of extra iterations', () => {
    const { service, advance } = makeHarness();
    const state = { v: 0 };
    const handle = service.tween.to(
      state,
      { v: 10 },
      { durationSec: 0.1, ease: 'linear', repeat: 2 }
    );

    advance(0.1);
    expect(handle.isRunning).toBe(true);
    advance(0.1);
    expect(handle.isRunning).toBe(true);
    advance(0.1);
    expect(handle.isRunning).toBe(false);
    expect(state.v).toBe(10);
  });

  it('yoyo reverses every other iteration, so the pair ends where it started', () => {
    const { service, advance } = makeHarness();
    const state = { v: 0 };
    const handle = service.tween.to(
      state,
      { v: 10 },
      { durationSec: 0.1, ease: 'linear', yoyo: true, repeat: 1 }
    );

    advance(0.1);
    // Second iteration runs backwards.
    advance(0.05);
    expect(state.v).toBeGreaterThan(0);
    expect(state.v).toBeLessThan(10);

    advance(0.05);
    expect(handle.isRunning).toBe(false);
    expect(state.v).toBe(0);
  });

  it('repeat: -1 never finishes on its own', () => {
    const { service, advance } = makeHarness();
    const state = { v: 0 };
    const handle = service.tween.to(
      state,
      { v: 10 },
      { durationSec: 0.05, ease: 'linear', repeat: -1 }
    );

    advance(2);
    expect(handle.isRunning).toBe(true);
    handle.cancel();
    expect(handle.isRunning).toBe(false);
  });

  it('cancel() freezes the target where it is and resolves as cancelled', async () => {
    const { service, advance } = makeHarness();
    const onComplete = vi.fn();
    const state = { v: 0 };
    const handle = service.tween.to(
      state,
      { v: 100 },
      { durationSec: 0.4, ease: 'linear', onComplete }
    );

    advance(0.2);
    const frozen = state.v;
    handle.cancel();
    advance(0.4);

    expect(state.v).toBe(frozen);
    expect(onComplete).not.toHaveBeenCalled();
    await expect(handle.finished).resolves.toBe('cancelled');
  });

  it('killAll(target) only kills that target, killAll() kills everything', () => {
    const { service, advance } = makeHarness();
    const a = { v: 0 };
    const b = { v: 0 };
    const handleA = service.tween.to(a, { v: 10 }, { durationSec: 1, ease: 'linear' });
    const handleB = service.tween.to(b, { v: 10 }, { durationSec: 1, ease: 'linear' });

    // A tween's channels are captured on its first tick; kill before any tick to
    // prove the kill path does not depend on that.
    service.tween.killAll(a);
    expect(handleA.isRunning).toBe(false);
    expect(handleB.isRunning).toBe(true);

    advance(0.2);
    expect(a.v).toBe(0);
    expect(b.v).toBeGreaterThan(0);

    service.tween.killAll();
    expect(handleB.isRunning).toBe(false);
    expect(service.tween.activeCount).toBe(0);
  });

  it('clearTweens() drops everything when the scene stops', () => {
    const { service } = makeHarness();
    const handle = service.tween.to({ v: 0 }, { v: 1 }, { durationSec: 1 });

    service.clearTweens();

    expect(handle.isRunning).toBe(false);
    expect(service.tween.activeCount).toBe(0);
  });
});

describe('scene.tween / node targets', () => {
  it('writes x, opacity and uniform scale through the public node properties', () => {
    const { service, sprite, advance } = makeHarness();
    sprite.position.set(0, 0, 0);
    sprite.opacity = 1;

    service.tween.to(
      sprite,
      { x: 200, y: -50, opacity: 0.25, scale: 2, rotation: Math.PI / 2 },
      { durationSec: 0.2, ease: 'linear' }
    );
    advance(0.2);

    expect(sprite.position.x).toBeCloseTo(200, 6);
    expect(sprite.position.y).toBeCloseTo(-50, 6);
    // The `opacity` ACCESSOR ran (not a raw field write), so the computed opacity follows.
    expect(sprite.opacity).toBeCloseTo(0.25, 6);
    expect(sprite.computedOpacity).toBeCloseTo(0.25, 6);
    expect(sprite.scale.x).toBeCloseTo(2, 6);
    expect(sprite.scale.y).toBeCloseTo(2, 6);
    expect(sprite.rotation.z).toBeCloseTo(Math.PI / 2, 6);
  });

  it('a width tween goes through the reactive setter, so the node actually redraws', () => {
    const { service, rect, advance } = makeHarness();
    // `children` is typed NodeBase[] but also holds the plain Object3D visuals.
    const mesh = rect.children.find(child => !(child instanceof NodeBase)) as unknown as Mesh;

    service.tween.to(rect, { width: 300, height: 120 }, { durationSec: 0.2, ease: 'linear' });
    advance(0.2);

    expect(rect.width).toBeCloseTo(300, 6);
    // The proof the setter ran: ColorRect2D sizes itself through mesh.scale.
    expect(mesh.scale.x).toBeCloseTo(300, 6);
    expect(mesh.scale.y).toBeCloseTo(120, 6);
  });

  it('accepts a node query and expands a {x,y} position value', () => {
    const { service, sprite, advance } = makeHarness();

    service.tween.to('ball', { position: { x: 30, y: 40 } }, { durationSec: 0.1, ease: 'linear' });
    advance(0.1);

    expect(sprite.position.x).toBeCloseTo(30, 6);
    expect(sprite.position.y).toBeCloseTo(40, 6);
  });

  it('warns once and returns an inert handle for a node query that misses', async () => {
    const { service } = makeHarness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const handle = service.tween.to('does-not-exist', { x: 10 });
    service.tween.to('does-not-exist', { x: 20 });

    expect(handle.isRunning).toBe(false);
    await expect(handle.finished).resolves.toBe('cancelled');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('ends a tween whose node was freed instead of writing into a corpse', () => {
    const { service, sprite, advance } = makeHarness();
    const handle = service.tween.to(sprite, { x: 500 }, { durationSec: 1, ease: 'linear' });

    advance(1 / 60);
    sprite.dispose();
    advance(1 / 60);

    expect(handle.isRunning).toBe(false);
    expect(service.tween.activeCount).toBe(0);
  });
});

describe('scene.tween / fade helpers', () => {
  it('fadeIn shows the node and ramps opacity 0 → 1', () => {
    const { service, rect, advance } = makeHarness();
    rect.visible = false;
    rect.opacity = 1;

    const handle = service.tween.fadeIn(rect, 0.2);
    expect(rect.visible).toBe(true);
    expect(rect.opacity).toBe(0);

    advance(0.2);
    expect(rect.opacity).toBeCloseTo(1, 6);
    expect(handle.isRunning).toBe(false);
  });

  it('fadeOut hides the node at the end, unless asked not to', () => {
    const { service, rect, sprite, advance } = makeHarness();

    service.tween.fadeOut(rect, 0.1);
    service.tween.fadeOut(sprite, 0.1, { hide: false });
    advance(0.1);

    expect(rect.opacity).toBe(0);
    expect(rect.visible).toBe(false);
    expect(sprite.opacity).toBe(0);
    expect(sprite.visible).toBe(true);
  });

  it('crossFade swaps visibility and ends when BOTH halves do', async () => {
    const { service, rect, sprite, advance } = makeHarness();
    rect.visible = true;
    rect.opacity = 1;
    sprite.visible = false;
    sprite.opacity = 1;

    const handle = service.tween.crossFade(rect, sprite, 0.2);
    // The incoming node is visible from frame zero (at zero opacity), the outgoing
    // one stays visible until its fade lands.
    expect(sprite.visible).toBe(true);
    expect(sprite.opacity).toBe(0);
    expect(rect.visible).toBe(true);

    advance(0.1);
    expect(handle.isRunning).toBe(true);

    advance(0.1);
    expect(rect.opacity).toBe(0);
    expect(rect.visible).toBe(false);
    expect(sprite.opacity).toBeCloseTo(1, 6);
    expect(sprite.visible).toBe(true);
    await expect(handle.finished).resolves.toBe('completed');
  });
});
