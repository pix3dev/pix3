import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vector2 } from 'three';
import { AssetLoader } from './AssetLoader';
import { AudioService } from './AudioService';
import { ECSService } from './ECSService';
import { ResourceManager } from './ResourceManager';
import { GameTime } from './GameTime';
import { InputService } from './InputService';
import { SceneService, type FrameProfilerActivity } from './SceneService';
import { NetworkService } from '../net/NetworkService';

describe('SceneService viewport API', () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;
  const originalDevicePixelRatio = window.devicePixelRatio;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      writable: true,
      value: originalDevicePixelRatio,
    });
  });

  it('returns fallback viewport info before runner size injection', () => {
    const service = new SceneService();

    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 400 });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 800,
    });
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      writable: true,
      value: 2,
    });

    const info = service.getViewportInfo();

    expect(info.width).toBe(800);
    expect(info.height).toBe(1600);
    expect(info.orientation).toBe('portrait');
    expect(info.aspect).toBe(0.5);
  });

  it('setViewportSize updates viewport info and orientation', () => {
    const service = new SceneService();

    service.setViewportSize(1000, 1000);
    const equalInfo = service.getViewportInfo();
    expect(equalInfo.orientation).toBe('landscape');
    expect(equalInfo.aspect).toBe(1);

    service.setViewportSize(900, 1000);
    const portraitInfo = service.getViewportInfo();
    expect(portraitInfo.width).toBe(900);
    expect(portraitInfo.height).toBe(1000);
    expect(portraitInfo.orientation).toBe('portrait');
    expect(portraitInfo.aspect).toBe(0.9);
  });

  it('onViewportChanged emits immediately, on size changes, and stops after unsubscribe', () => {
    const service = new SceneService();
    const listener = vi.fn();

    const unsubscribe = service.onViewportChanged(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    service.setViewportSize(100, 200);
    expect(listener).toHaveBeenCalledTimes(2);

    service.setViewportSize(100, 200);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    service.setViewportSize(200, 100);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('returns resource manager from the active delegate', () => {
    const service = new SceneService();
    const resources = new ResourceManager('/');
    const assetLoader = new AssetLoader(resources, new AudioService());

    service.setDelegate({
      getActiveCameraNode: () => null,
      getActiveCamera2DNode: () => null,
      getInputService: () => new InputService(),
      getUICamera: () => null,
      getLogicalCameraSize: () => ({ width: 0, height: 0 }),
      setActiveCameraNode: () => undefined,
      findNodeById: () => null,
      getRootNodes: () => [],
      getAudioService: () => new AudioService(),
      getAssetLoader: () => assetLoader,
      getResourceManager: () => resources,
      getECSService: () => null,
      getGameTime: () => new GameTime(),
      raycastViewport: () => null,
      reportFrameProfilerActivities: () => undefined,
      loadAndStartScene: () => Promise.resolve(),
    });

    expect(service.getResourceManager()).toBe(resources);
    expect(service.getAssetLoader()).toBe(assetLoader);
  });

  it('forwards ECS and raycast APIs to the active delegate', () => {
    const service = new SceneService();
    const ecsService = new ECSService();
    const hit = {
      node: null,
      distance: 1,
      point: { x: 0, y: 0, z: 0 },
      object: null,
      instanceId: 3,
    };

    service.setDelegate({
      getActiveCameraNode: () => null,
      getActiveCamera2DNode: () => null,
      getInputService: () => new InputService(),
      getUICamera: () => null,
      getLogicalCameraSize: () => ({ width: 0, height: 0 }),
      setActiveCameraNode: () => undefined,
      findNodeById: () => null,
      getRootNodes: () => [],
      getAudioService: () => new AudioService(),
      getAssetLoader: () => new AssetLoader(new ResourceManager('/'), new AudioService()),
      getResourceManager: () => new ResourceManager('/'),
      getECSService: () => ecsService,
      getGameTime: () => new GameTime(),
      raycastViewport: () => hit as never,
      reportFrameProfilerActivities: () => undefined,
      loadAndStartScene: () => Promise.resolve(),
    });

    expect(service.getECSService()).toBe(ecsService);
    expect(service.raycastViewport(0, 0)).toBe(hit);
  });

  it('forwards frame profiler activities to the active delegate', () => {
    const service = new SceneService();
    const reportFrameProfilerActivities = vi.fn();
    const activities: readonly FrameProfilerActivity[] = [
      { label: 'Physics', selfTimeMs: 1.5, totalTimeMs: 2.25 },
    ];

    service.setDelegate({
      getActiveCameraNode: () => null,
      getActiveCamera2DNode: () => null,
      getInputService: () => new InputService(),
      getUICamera: () => null,
      getLogicalCameraSize: () => ({ width: 0, height: 0 }),
      setActiveCameraNode: () => undefined,
      findNodeById: () => null,
      getRootNodes: () => [],
      getAudioService: () => new AudioService(),
      getAssetLoader: () => new AssetLoader(new ResourceManager('/'), new AudioService()),
      getResourceManager: () => new ResourceManager('/'),
      getECSService: () => null,
      getGameTime: () => new GameTime(),
      raycastViewport: () => null,
      reportFrameProfilerActivities,
      loadAndStartScene: () => Promise.resolve(),
    });

    service.reportFrameProfilerActivities(activities);

    expect(reportFrameProfilerActivities).toHaveBeenCalledWith(activities);
  });
});

describe('SceneService.changeScene', () => {
  const makeDelegate = (
    overrides: Partial<Parameters<SceneService['setDelegate']>[0] & object> = {}
  ): Parameters<SceneService['setDelegate']>[0] => ({
    getActiveCameraNode: () => null,
    getActiveCamera2DNode: () => null,
    getInputService: () => new InputService(),
    getUICamera: () => null,
    getLogicalCameraSize: () => ({ width: 0, height: 0 }),
    setActiveCameraNode: () => undefined,
    findNodeById: () => null,
    getRootNodes: () => [],
    getAudioService: () => new AudioService(),
    getAssetLoader: () => new AssetLoader(new ResourceManager('/'), new AudioService()),
    getResourceManager: () => new ResourceManager('/'),
    getECSService: () => null,
    getGameTime: () => new GameTime(),
    raycastViewport: () => null,
    reportFrameProfilerActivities: () => undefined,
    loadAndStartScene: () => Promise.resolve(),
    ...overrides,
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects when no scene is running (no delegate)', async () => {
    const service = new SceneService();
    await expect(service.changeScene('res://x.pix3scene')).rejects.toThrow(/no scene is running/);
  });

  it("transition 'none' swaps via the delegate, fires onLoaded, and never fades", async () => {
    const service = new SceneService();
    const loadAndStartScene = vi.fn(async () => undefined);
    const onLoaded = vi.fn();
    service.setDelegate(makeDelegate({ loadAndStartScene }));
    const fadeToBlack = vi.spyOn(service, 'fadeToBlack');
    const fadeFromBlack = vi.spyOn(service, 'fadeFromBlack');

    await service.changeScene('res://level.pix3scene', { transition: 'none', onLoaded });

    expect(loadAndStartScene).toHaveBeenCalledWith('res://level.pix3scene');
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(fadeToBlack).not.toHaveBeenCalled();
    expect(fadeFromBlack).not.toHaveBeenCalled();
  });

  it('fades out, swaps at black, fires onLoaded, then fades in — in that order', async () => {
    const service = new SceneService();
    const order: string[] = [];
    vi.spyOn(service, 'fadeToBlack').mockImplementation((_d, cb) => {
      order.push('fadeOut');
      cb?.();
    });
    vi.spyOn(service, 'fadeFromBlack').mockImplementation((_d, cb) => {
      order.push('fadeIn');
      cb?.();
    });
    const loadAndStartScene = vi.fn(async () => {
      order.push('load');
    });
    service.setDelegate(makeDelegate({ loadAndStartScene }));

    await service.changeScene('res://level.pix3scene', {
      transition: 'fade',
      durationSec: 0.1,
      onLoaded: () => order.push('onLoaded'),
    });

    expect(order).toEqual(['fadeOut', 'load', 'onLoaded', 'fadeIn']);
  });

  it('ignores a concurrent call and returns the in-flight transition', async () => {
    const service = new SceneService();
    let resolveLoad!: () => void;
    const pending = new Promise<void>(resolve => {
      resolveLoad = resolve;
    });
    const loadAndStartScene = vi.fn(() => pending);
    service.setDelegate(makeDelegate({ loadAndStartScene }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const first = service.changeScene('res://a.pix3scene', { transition: 'none' });
    const second = service.changeScene('res://b.pix3scene', { transition: 'none' });

    // The guard drops the second call: only the first target is ever loaded.
    expect(loadAndStartScene).toHaveBeenCalledTimes(1);
    expect(loadAndStartScene).toHaveBeenCalledWith('res://a.pix3scene');
    expect(warn).toHaveBeenCalled();

    resolveLoad();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('fades back in and rejects when the load fails', async () => {
    const service = new SceneService();
    const fadeFromBlack = vi.spyOn(service, 'fadeFromBlack').mockImplementation((_d, cb) => cb?.());
    vi.spyOn(service, 'fadeToBlack').mockImplementation((_d, cb) => cb?.());
    const onLoaded = vi.fn();
    service.setDelegate(
      makeDelegate({ loadAndStartScene: () => Promise.reject(new Error('missing scene')) })
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      service.changeScene('res://gone.pix3scene', {
        transition: 'fade',
        durationSec: 0.1,
        onLoaded,
      })
    ).rejects.toThrow(/missing scene/);
    expect(onLoaded).not.toHaveBeenCalled();
    // Reveal the still-running old scene rather than stranding a black screen.
    expect(fadeFromBlack).toHaveBeenCalledTimes(1);
  });

  it('does not deadlock when a competing fade drops the fade callback', async () => {
    vi.useFakeTimers();
    const service = new SceneService();
    // Simulate cancelFade(): the fade never fires its onComplete.
    vi.spyOn(service, 'fadeToBlack').mockImplementation(() => undefined);
    vi.spyOn(service, 'fadeFromBlack').mockImplementation(() => undefined);
    const loadAndStartScene = vi.fn(async () => undefined);
    service.setDelegate(makeDelegate({ loadAndStartScene }));

    const promise = service.changeScene('res://level.pix3scene', {
      transition: 'fade',
      durationSec: 0.05,
    });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
    expect(loadAndStartScene).toHaveBeenCalledTimes(1);
  });
});

describe('SceneService network session installation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the binder — and its bindings — when the SAME session is re-installed', () => {
    // The editor's Play Online card polls `getNetworkService()` once a second, and that getter
    // re-installs the session. Dropping the binder there would unbind every peer's avatar (they
    // stop receiving transforms) and let the next reconcile spawn duplicates.
    const service = new SceneService();
    const session = new NetworkService();

    service.setNetworkService(session);
    const binder = service.netNodes;
    service.setNetworkService(session);

    expect(service.netNodes).toBe(binder);
  });

  it('replaces the binder when a DIFFERENT session is installed', () => {
    const service = new SceneService();

    service.setNetworkService(new NetworkService());
    const binder = service.netNodes;
    service.setNetworkService(new NetworkService());

    expect(service.netNodes).not.toBe(binder);
  });
});

describe('SceneService.getPointer2DWorldPosition', () => {
  /**
   * The addressed form (`pointerId`) is what multi-touch needs from a script: with two fingers on
   * screen the shared `pointerPosition` describes only the oldest one, so a game resolving several
   * contacts has to name the finger it means. The no-argument call keeps its single-pointer
   * reading — the primary pointer — so every existing script is untouched.
   */
  const attachInput = (input: InputService, size: number): HTMLDivElement => {
    const element = document.createElement('div');
    element.setPointerCapture = vi.fn();
    element.releasePointerCapture = vi.fn();
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({
        left: 0,
        top: 0,
        width: size,
        height: size,
        right: size,
        bottom: size,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      configurable: true,
    });
    input.attach(element);
    return element;
  };

  const makeService = (input: InputService): SceneService => {
    const service = new SceneService();
    service.setDelegate({
      getActiveCameraNode: () => null,
      getActiveCamera2DNode: () => null,
      getInputService: () => input,
      getUICamera: () => null,
      // World = input size, so screen (100,100) is world (0,0) — the fallback mapping.
      getLogicalCameraSize: () => ({ width: 200, height: 200 }),
      setActiveCameraNode: () => undefined,
      findNodeById: () => null,
      getRootNodes: () => [],
      getAudioService: () => new AudioService(),
      getAssetLoader: () => new AssetLoader(new ResourceManager('/'), new AudioService()),
      getResourceManager: () => new ResourceManager('/'),
      getECSService: () => null,
      getGameTime: () => new GameTime(),
      raycastViewport: () => null,
      reportFrameProfilerActivities: () => undefined,
      loadAndStartScene: () => Promise.resolve(),
    });
    return service;
  };

  it('resolves the named finger, while the no-argument call keeps following the primary one', () => {
    const input = new InputService();
    const element = attachInput(input, 200);
    const service = makeService(input);

    element.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 })
    );
    element.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 2, clientX: 150, clientY: 50 })
    );

    expect(service.getPointer2DWorldPosition()).toMatchObject({ x: 0, y: 0 });
    expect(service.getPointer2DWorldPosition(1)).toMatchObject({ x: 0, y: 0 });
    expect(service.getPointer2DWorldPosition(2)).toMatchObject({ x: 50, y: 50 });

    input.detach();
  });

  it('returns null for a pointer that is not down, and still fills a supplied target', () => {
    const input = new InputService();
    const element = attachInput(input, 200);
    const service = makeService(input);

    element.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: 1, clientX: 150, clientY: 50 })
    );

    // A finger that already lifted has no position of its own — the caller decides what to do
    // about it (a same-frame tap falls back to the shared position).
    expect(service.getPointer2DWorldPosition(9)).toBeNull();

    const target = new Vector2();
    expect(service.getPointer2DWorldPosition(1, target)).toBe(target);
    expect(target.x).toBe(50);
    expect(service.getPointer2DWorldPosition(target)).toBe(target);

    input.detach();
  });
});
