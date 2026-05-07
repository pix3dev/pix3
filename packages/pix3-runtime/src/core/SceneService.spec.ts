import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLoader } from './AssetLoader';
import { AudioService } from './AudioService';
import { ECSService } from './ECSService';
import { ResourceManager } from './ResourceManager';
import { SceneService, type FrameProfilerActivity } from './SceneService';

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
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 800 });
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
      getUICamera: () => null,
      getLogicalCameraSize: () => ({ width: 0, height: 0 }),
      setActiveCameraNode: () => undefined,
      findNodeById: () => null,
      getAudioService: () => new AudioService(),
      getAssetLoader: () => assetLoader,
      getResourceManager: () => resources,
      getECSService: () => null,
      raycastViewport: () => null,
      reportFrameProfilerActivities: () => undefined,
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
      getUICamera: () => null,
      getLogicalCameraSize: () => ({ width: 0, height: 0 }),
      setActiveCameraNode: () => undefined,
      findNodeById: () => null,
      getAudioService: () => new AudioService(),
      getAssetLoader: () => new AssetLoader(new ResourceManager('/'), new AudioService()),
      getResourceManager: () => new ResourceManager('/'),
      getECSService: () => ecsService,
      raycastViewport: () => hit as never,
      reportFrameProfilerActivities: () => undefined,
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
      getUICamera: () => null,
      getLogicalCameraSize: () => ({ width: 0, height: 0 }),
      setActiveCameraNode: () => undefined,
      findNodeById: () => null,
      getAudioService: () => new AudioService(),
      getAssetLoader: () => new AssetLoader(new ResourceManager('/'), new AudioService()),
      getResourceManager: () => new ResourceManager('/'),
      getECSService: () => null,
      raycastViewport: () => null,
      reportFrameProfilerActivities,
    });

    service.reportFrameProfilerActivities(activities);

    expect(reportFrameProfilerActivities).toHaveBeenCalledWith(activities);
  });
});
