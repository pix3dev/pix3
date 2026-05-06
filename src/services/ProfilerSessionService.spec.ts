import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfilerSessionService } from './ProfilerSessionService';
import type { RuntimeRendererStatsSnapshot, SceneRunnerFrameSample } from '@pix3/runtime';

describe('ProfilerSessionService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts idle', () => {
    const service = new ProfilerSessionService();

    expect(service.getSnapshot().status).toBe('idle');
    expect(service.getSnapshot().counters.frameCount).toBe(0);
  });

  it('resets counters on beginSession and updates from frame samples', () => {
    const service = new ProfilerSessionService();
    let frameListener: ((sample: SceneRunnerFrameSample) => void) | undefined;
    const runner = {
      subscribeFrameStats(listener: (sample: SceneRunnerFrameSample) => void) {
        frameListener = listener;
        return () => {
          frameListener = undefined;
        };
      },
    } as unknown as import('@pix3/runtime').SceneRunner;
    const rendererStats: RuntimeRendererStatsSnapshot = {
      calls: 42,
      triangles: 11308,
      points: 0,
      lines: 0,
      geometries: 8,
      textures: 14,
    };
    const renderer = {
      getStatsSnapshot: vi.fn(() => rendererStats),
    } as unknown as import('@pix3/runtime').RuntimeRenderer;

    service.beginSession('tab');
    service.bindRuntime(runner, renderer, 'tab');
    frameListener?.({
      dt: 1 / 60,
      elapsedTime: 1.5,
      frameNumber: 90,
      logicMs: 3.2,
      renderMs: 5.2,
      totalFrameMs: 8.4,
      rendererStats,
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.status).toBe('running');
    expect(snapshot.counters.hostKind).toBe('tab');
    expect(snapshot.counters.frameCount).toBe(90);
    expect(snapshot.counters.elapsedMs).toBeCloseTo(1500);
    expect(snapshot.performance.fps).toBeCloseTo(60, 0);
    expect(snapshot.performance.logicMs).toBe(3.2);
    expect(snapshot.performance.renderMs).toBe(5.2);
    expect(snapshot.performance.drawCalls).toBe(42);
    expect(snapshot.performance.triangles).toBe(11308);
    expect(snapshot.performance.geometries).toBe(8);
    expect(snapshot.performance.textures).toBe(14);
    expect(snapshot.history.fps.length).toBe(1);
    expect(snapshot.history.logicMs[0]).toBe(3.2);
    expect(snapshot.history.renderMs[0]).toBe(5.2);
  });

  it('keeps unsupported JS heap as null', () => {
    const service = new ProfilerSessionService();
    vi.stubGlobal('performance', {});

    service.beginSession('popout');
    expect(service.getSnapshot().performance.jsHeapUsedMb).toBeNull();
  });

  it('returns to idle on endSession', () => {
    const service = new ProfilerSessionService();

    service.beginSession('tab');
    service.endSession();

    const snapshot = service.getSnapshot();
    expect(snapshot.status).toBe('idle');
    expect(snapshot.counters.hostKind).toBeNull();
    expect(snapshot.counters.frameCount).toBe(0);
  });
});
