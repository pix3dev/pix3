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
      profilerActivities: [
        { label: 'Physics', selfTimeMs: 1.5, totalTimeMs: 2.25 },
        { label: 'Audio', selfTimeMs: 0.5 },
      ],
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
    const activitiesByLabel = new Map(
      snapshot.frameImpact.activities.map(activity => [activity.label, activity])
    );

    expect(snapshot.frameImpact.activities).toHaveLength(4);
    expect(activitiesByLabel.get('Runtime Render')).toMatchObject({
      label: 'Runtime Render',
      selfTimeMs: 5.2,
      totalTimeMs: 5.2,
      sampleCount: 1,
    });
    expect(activitiesByLabel.get('Runtime Render')?.selfPercent).toBeCloseTo(31.2, 5);
    expect(activitiesByLabel.get('Runtime Render')?.totalPercent).toBeCloseTo(31.2, 5);
    expect(activitiesByLabel.get('Physics')).toMatchObject({
      label: 'Physics',
      selfTimeMs: 1.5,
      totalTimeMs: 2.25,
      sampleCount: 1,
    });
    expect(snapshot.frameImpact.sampledFrameCount).toBe(1);
    expect(snapshot.frameImpact.windowDurationMs).toBeCloseTo(1000 / 60, 5);
    expect(snapshot.frameImpact.totalFrameTimeMs).toBeCloseTo(1000 / 60, 5);
    expect(activitiesByLabel.get('Physics')?.selfPercent).toBeCloseTo(9, 5);
    expect(activitiesByLabel.get('Physics')?.totalPercent).toBeCloseTo(13.5, 5);
    expect(activitiesByLabel.get('Runtime Logic (Untracked)')).toMatchObject({
      label: 'Runtime Logic (Untracked)',
      sampleCount: 1,
    });
    expect(activitiesByLabel.get('Runtime Logic (Untracked)')?.selfTimeMs).toBeCloseTo(1.2, 5);
    expect(activitiesByLabel.get('Runtime Logic (Untracked)')?.totalTimeMs).toBeCloseTo(1.2, 5);
    expect(activitiesByLabel.get('Runtime Logic (Untracked)')?.selfPercent).toBeCloseTo(7.2, 5);
    expect(activitiesByLabel.get('Runtime Logic (Untracked)')?.totalPercent).toBeCloseTo(7.2, 5);
    expect(activitiesByLabel.get('Audio')).toMatchObject({
      label: 'Audio',
      selfTimeMs: 0.5,
      totalTimeMs: 0.5,
      sampleCount: 1,
    });
    expect(activitiesByLabel.get('Audio')?.selfPercent).toBeCloseTo(3, 5);
    expect(activitiesByLabel.get('Audio')?.totalPercent).toBeCloseTo(3, 5);
  });

  it('aggregates frame impact entries across the rolling sample window', () => {
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
      calls: 1,
      triangles: 2,
      points: 0,
      lines: 0,
      geometries: 3,
      textures: 4,
    };
    const renderer = {
      getStatsSnapshot: vi.fn(() => rendererStats),
    } as unknown as import('@pix3/runtime').RuntimeRenderer;

    service.beginSession('tab');
    service.bindRuntime(runner, renderer, 'tab');
    frameListener?.({
      dt: 1 / 60,
      elapsedTime: 1,
      frameNumber: 60,
      logicMs: 5,
      renderMs: 4,
      totalFrameMs: 9,
      rendererStats,
      profilerActivities: [
        { label: 'Physics', selfTimeMs: 4, totalTimeMs: 5 },
        { label: 'Audio', selfTimeMs: 1 },
      ],
    });
    frameListener?.({
      dt: 1 / 60,
      elapsedTime: 2,
      frameNumber: 120,
      logicMs: 2,
      renderMs: 4,
      totalFrameMs: 6,
      rendererStats,
      profilerActivities: [{ label: 'Physics', selfTimeMs: 2, totalTimeMs: 4 }],
    });

    const activities = service.getSnapshot().frameImpact.activities;
    const activitiesByLabel = new Map(activities.map(activity => [activity.label, activity]));

    expect(activities).toHaveLength(3);
    expect(activitiesByLabel.get('Runtime Render')).toMatchObject({
      label: 'Runtime Render',
      selfTimeMs: 8,
      totalTimeMs: 8,
      sampleCount: 2,
    });
    expect(activitiesByLabel.get('Runtime Render')?.selfPercent).toBeCloseTo(24, 5);
    expect(activitiesByLabel.get('Runtime Render')?.totalPercent).toBeCloseTo(24, 5);
    expect(activitiesByLabel.get('Physics')).toMatchObject({
      label: 'Physics',
      selfTimeMs: 6,
      totalTimeMs: 9,
      sampleCount: 2,
    });
    expect(activitiesByLabel.get('Physics')?.selfPercent).toBeCloseTo(18, 5);
    expect(activitiesByLabel.get('Physics')?.totalPercent).toBeCloseTo(27, 5);
    expect(activitiesByLabel.get('Audio')).toMatchObject({
      label: 'Audio',
      selfTimeMs: 1,
      totalTimeMs: 1,
      sampleCount: 1,
    });
    expect(activitiesByLabel.get('Audio')?.selfPercent).toBeCloseTo(3, 5);
    expect(activitiesByLabel.get('Audio')?.totalPercent).toBeCloseTo(3, 5);
    expect(service.getSnapshot().frameImpact.windowDurationMs).toBeCloseTo(1000 / 30, 5);
  });

  it('includes runtime-only logic and render rows when no project instrumentation is reported', () => {
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
      calls: 1,
      triangles: 2,
      points: 0,
      lines: 0,
      geometries: 3,
      textures: 4,
    };
    const renderer = {
      getStatsSnapshot: vi.fn(() => rendererStats),
    } as unknown as import('@pix3/runtime').RuntimeRenderer;

    service.beginSession('tab');
    service.bindRuntime(runner, renderer, 'tab');
    frameListener?.({
      dt: 1 / 60,
      elapsedTime: 1,
      frameNumber: 1,
      logicMs: 2.5,
      renderMs: 4,
      totalFrameMs: 6.5,
      rendererStats,
    });

    expect(service.getSnapshot().frameImpact.activities.map(activity => activity.label)).toEqual([
      'Runtime Render',
      'Runtime Logic',
    ]);
  });

  it('keeps the previous ordering until an activity takes a clearly larger share', () => {
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
      calls: 1,
      triangles: 2,
      points: 0,
      lines: 0,
      geometries: 3,
      textures: 4,
    };
    const renderer = {
      getStatsSnapshot: vi.fn(() => rendererStats),
    } as unknown as import('@pix3/runtime').RuntimeRenderer;

    service.beginSession('tab');
    service.bindRuntime(runner, renderer, 'tab');

    frameListener?.({
      dt: 1,
      elapsedTime: 1,
      frameNumber: 1,
      logicMs: 40,
      renderMs: 4,
      totalFrameMs: 44,
      rendererStats,
      profilerActivities: [
        { label: 'Physics', selfTimeMs: 20, totalTimeMs: 20 },
        { label: 'Audio', selfTimeMs: 18, totalTimeMs: 18 },
      ],
    });
    expect(service.getSnapshot().frameImpact.activities.map(activity => activity.label).slice(0, 2)).toEqual([
      'Physics',
      'Audio',
    ]);

    frameListener?.({
      dt: 1,
      elapsedTime: 2,
      frameNumber: 2,
      logicMs: 20,
      renderMs: 4,
      totalFrameMs: 24,
      rendererStats,
      profilerActivities: [
        { label: 'Physics', selfTimeMs: 5, totalTimeMs: 5 },
        { label: 'Audio', selfTimeMs: 10, totalTimeMs: 10 },
      ],
    });
    expect(service.getSnapshot().frameImpact.activities.map(activity => activity.label).slice(0, 2)).toEqual([
      'Physics',
      'Audio',
    ]);

    frameListener?.({
      dt: 1,
      elapsedTime: 3,
      frameNumber: 3,
      logicMs: 28,
      renderMs: 4,
      totalFrameMs: 32,
      rendererStats,
      profilerActivities: [
        { label: 'Physics', selfTimeMs: 4, totalTimeMs: 4 },
        { label: 'Audio', selfTimeMs: 20, totalTimeMs: 20 },
      ],
    });
    expect(service.getSnapshot().frameImpact.activities.map(activity => activity.label).slice(0, 2)).toEqual([
      'Audio',
      'Physics',
    ]);
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
    expect(snapshot.frameImpact.activities).toEqual([]);
  });
});
