import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appState } from '@/state';
import { StudioViewportMountService } from './StudioViewportMountService';

/** Stand in for the shared editor canvas: `canvas` present == the viewport can be captured. */
const withViewport = (service: StudioViewportMountService, canvas: () => unknown): void => {
  Object.defineProperty(service, 'viewportRenderer', {
    value: { getCanvasElement: canvas },
    configurable: true,
  });
};

describe('StudioViewportMountService', () => {
  beforeEach(() => {
    appState.project.status = 'ready';
  });

  it('refuses when no shell has registered a mounter', async () => {
    const service = new StudioViewportMountService();
    // Deliberately never touches the renderer: a caller with no shell behind it must get its
    // answer without a WebGL service being constructed to deliver it.
    await expect(service.ensureStudioViewportMounted()).resolves.toBe(false);
  });

  it('runs the registered mounter and resolves once the viewport exists', async () => {
    const service = new StudioViewportMountService();
    let canvas: unknown = null;
    withViewport(service, () => canvas);
    const mounter = vi.fn(async () => {
      canvas = {};
      return true;
    });
    service.registerMounter(mounter);

    await expect(service.ensureStudioViewportMounted()).resolves.toBe(true);
    expect(mounter).toHaveBeenCalledTimes(1);
  });

  it('skips the mount entirely when the viewport is already there', async () => {
    const service = new StudioViewportMountService();
    withViewport(service, () => ({}));
    const mounter = vi.fn(async () => true);
    service.registerMounter(mounter);

    await expect(service.ensureStudioViewportMounted()).resolves.toBe(true);
    expect(mounter).not.toHaveBeenCalled();
  });

  it('reports failure when the mounted branch came up without a viewport', async () => {
    const service = new StudioViewportMountService();
    withViewport(service, () => null);
    service.registerMounter(async () => false);

    await expect(service.ensureStudioViewportMounted()).resolves.toBe(false);
  });

  it('stops calling a mounter after the shell disconnects', async () => {
    const service = new StudioViewportMountService();
    withViewport(service, () => null);
    const mounter = vi.fn(async () => true);
    const dispose = service.registerMounter(mounter);

    dispose();

    await expect(service.ensureStudioViewportMounted()).resolves.toBe(false);
    expect(mounter).not.toHaveBeenCalled();
  });

  it('a stale disposer does not unregister the shell that replaced it', async () => {
    // A hot reload connects the new shell before the old one disconnects; the disposer the old
    // shell still holds must not take the live registration with it.
    const service = new StudioViewportMountService();
    let canvas: unknown = null;
    withViewport(service, () => canvas);
    const disposeFirst = service.registerMounter(async () => true);
    const second = vi.fn(async () => {
      canvas = {};
      return true;
    });
    service.registerMounter(second);

    disposeFirst();

    await expect(service.ensureStudioViewportMounted()).resolves.toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('shares one mount between racing callers', async () => {
    const service = new StudioViewportMountService();
    let canvas: unknown = null;
    withViewport(service, () => canvas);
    const mounter = vi.fn(async () => {
      canvas = {};
      return true;
    });
    service.registerMounter(mounter);

    const [a, b] = await Promise.all([
      service.ensureStudioViewportMounted(),
      service.ensureStudioViewportMounted(),
    ]);

    expect([a, b]).toEqual([true, true]);
    expect(mounter).toHaveBeenCalledTimes(1);
  });

  it('refuses while no project is open', async () => {
    const service = new StudioViewportMountService();
    withViewport(service, () => null);
    const mounter = vi.fn(async () => true);
    service.registerMounter(mounter);
    appState.project.status = 'idle';

    await expect(service.ensureStudioViewportMounted()).resolves.toBe(false);
    expect(mounter).not.toHaveBeenCalled();
  });

  it('dispose() drops the registration', async () => {
    const service = new StudioViewportMountService();
    withViewport(service, () => null);
    const mounter = vi.fn(async () => true);
    service.registerMounter(mounter);

    service.dispose();

    await expect(service.ensureStudioViewportMounted()).resolves.toBe(false);
    expect(mounter).not.toHaveBeenCalled();
  });
});
