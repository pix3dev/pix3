import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FrameIntervalHistogram,
  PROFILER_AB_MIN_ARM_FRAMES,
  ProfilerSessionService,
  type ProfilerSessionSnapshot,
} from '@/services/play/ProfilerSessionService';
import { appState } from '@/state';
import type { RuntimeRendererStatsSnapshot, SceneRunnerFrameSample } from '@pix3/runtime';

describe('ProfilerSessionService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a frame split whose parts sum to the Frame row', () => {
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
      triangles: 1,
      points: 0,
      lines: 0,
      geometries: 1,
      textures: 1,
      programs: 3,
    };
    const renderer = {
      getStatsSnapshot: vi.fn(() => rendererStats),
    } as unknown as import('@pix3/runtime').RuntimeRenderer;

    service.beginSession('tab');
    service.bindRuntime(runner, renderer, 'tab');

    // Frame durations and work times both vary, so a rolling-average Frame row paired with
    // single-sample parts would land on different instants and refuse to add up — which is
    // exactly what shipped first: `Frame 17.3` beside parts summing to 11.1.
    const frames = [
      { dtMs: 16.7, logicMs: 0.4, renderMs: 1.5 },
      { dtMs: 50.0, logicMs: 0.8, renderMs: 2.6 },
      { dtMs: 16.7, logicMs: 0.2, renderMs: 1.1 },
      { dtMs: 33.4, logicMs: 1.9, renderMs: 4.0 },
    ];
    for (const [index, frame] of frames.entries()) {
      frameListener?.({
        dt: frame.dtMs / 1000,
        elapsedTime: index * 0.0167,
        frameNumber: index,
        logicMs: frame.logicMs,
        renderMs: frame.renderMs,
        totalFrameMs: frame.logicMs + frame.renderMs,
        unaccountedMs: Math.max(0, frame.dtMs - frame.logicMs - frame.renderMs),
        rafLatenessMs: 0,
        rendererStats,
      });
    }

    const { frameTimeMs, logicMs, renderMs, unaccountedMs } = service.getSnapshot().performance;
    expect(frameTimeMs).not.toBeNull();
    expect(logicMs! + renderMs! + unaccountedMs!).toBeCloseTo(frameTimeMs!, 6);
    // And the split must describe the window, not the last frame alone.
    const averageDt = frames.reduce((total, f) => total + f.dtMs, 0) / frames.length;
    expect(frameTimeMs!).toBeCloseTo(averageDt, 6);
    expect(unaccountedMs!).toBeGreaterThan(logicMs! + renderMs!);
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
      programs: 0,
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
      unaccountedMs: 8.27,
      rafLatenessMs: 0,
      rendererStats,
      profilerActivities: [
        { label: 'Physics', selfTimeMs: 1.5, totalTimeMs: 2.25 },
        { label: 'Audio', selfTimeMs: 0.5 },
      ],
      activeAudioPlaybacks: [
        createAudioPlayback({
          id: 'playback-1',
          label: 'hitStone.ogg',
          resourcePath: 'res://audio/hitStone.ogg',
          startedAtMs: 1000,
          elapsedMs: 500,
          loop: false,
          volume: 0.35,
          playbackRate: 1.05,
          pan: -0.1,
          durationSeconds: 2,
          channelCount: 2,
          sampleRate: 48000,
          bitrateKbps: 256,
        }),
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
    expect(snapshot.audio.activeInstanceCount).toBe(1);
    expect(snapshot.audio.files).toEqual([
      {
        key: 'res://audio/hitStone.ogg',
        label: 'hitStone.ogg',
        resourcePath: 'res://audio/hitStone.ogg',
        durationSeconds: 2,
        channelCount: 2,
        sampleRate: 48000,
        bitrateKbps: 256,
        activeInstanceCount: 1,
        isActive: true,
        lastPlayedAtMs: 1000,
        currentInstances: [
          createAudioPlayback({
            id: 'playback-1',
            label: 'hitStone.ogg',
            resourcePath: 'res://audio/hitStone.ogg',
            startedAtMs: 1000,
            elapsedMs: 500,
            loop: false,
            volume: 0.35,
            playbackRate: 1.05,
            pan: -0.1,
            durationSeconds: 2,
            channelCount: 2,
            sampleRate: 48000,
            bitrateKbps: 256,
          }),
        ],
        lastPlayback: createAudioPlayback({
          id: 'playback-1',
          label: 'hitStone.ogg',
          resourcePath: 'res://audio/hitStone.ogg',
          startedAtMs: 1000,
          elapsedMs: 500,
          loop: false,
          volume: 0.35,
          playbackRate: 1.05,
          pan: -0.1,
          durationSeconds: 2,
          channelCount: 2,
          sampleRate: 48000,
          bitrateKbps: 256,
        }),
      },
    ]);
  });

  it('keeps previously played files until the session stops and marks them inactive', () => {
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
      programs: 0,
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
      logicMs: 2,
      renderMs: 3,
      totalFrameMs: 5,
      unaccountedMs: 11.67,
      rafLatenessMs: 0,
      rendererStats,
      activeAudioPlaybacks: [
        createAudioPlayback({
          id: 'playback-7',
          label: 'breakStone.ogg',
          resourcePath: 'res://audio/breakStone.ogg',
          startedAtMs: 100,
          elapsedMs: 250,
          loop: false,
          volume: 0.4,
          playbackRate: 0.98,
          pan: 0,
          durationSeconds: 1.4,
          channelCount: 1,
          sampleRate: 44100,
          bitrateKbps: 192,
        }),
      ],
    });

    expect(service.getSnapshot().audio.files.map(file => file.label)).toEqual(['breakStone.ogg']);

    frameListener?.({
      dt: 1 / 60,
      elapsedTime: 2,
      frameNumber: 2,
      logicMs: 2,
      renderMs: 3,
      totalFrameMs: 5,
      unaccountedMs: 11.67,
      rafLatenessMs: 0,
      rendererStats,
    });

    expect(service.getSnapshot().audio.activeInstanceCount).toBe(0);
    expect(service.getSnapshot().audio.files).toEqual([
      {
        key: 'res://audio/breakStone.ogg',
        label: 'breakStone.ogg',
        resourcePath: 'res://audio/breakStone.ogg',
        durationSeconds: 1.4,
        channelCount: 1,
        sampleRate: 44100,
        bitrateKbps: 192,
        activeInstanceCount: 0,
        isActive: false,
        lastPlayedAtMs: 100,
        currentInstances: [],
        lastPlayback: createAudioPlayback({
          id: 'playback-7',
          label: 'breakStone.ogg',
          resourcePath: 'res://audio/breakStone.ogg',
          startedAtMs: 100,
          elapsedMs: 250,
          loop: false,
          volume: 0.4,
          playbackRate: 0.98,
          pan: 0,
          durationSeconds: 1.4,
          channelCount: 1,
          sampleRate: 44100,
          bitrateKbps: 192,
        }),
      },
    ]);
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
      programs: 0,
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
      unaccountedMs: 7.67,
      rafLatenessMs: 0,
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
      unaccountedMs: 10.67,
      rafLatenessMs: 0,
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
      programs: 0,
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
      unaccountedMs: 10.17,
      rafLatenessMs: 0,
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
      programs: 0,
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
      unaccountedMs: 956,
      rafLatenessMs: 0,
      rendererStats,
      profilerActivities: [
        { label: 'Physics', selfTimeMs: 20, totalTimeMs: 20 },
        { label: 'Audio', selfTimeMs: 18, totalTimeMs: 18 },
      ],
    });
    expect(
      service
        .getSnapshot()
        .frameImpact.activities.map(activity => activity.label)
        .slice(0, 2)
    ).toEqual(['Physics', 'Audio']);

    frameListener?.({
      dt: 1,
      elapsedTime: 2,
      frameNumber: 2,
      logicMs: 20,
      renderMs: 4,
      totalFrameMs: 24,
      unaccountedMs: 976,
      rafLatenessMs: 0,
      rendererStats,
      profilerActivities: [
        { label: 'Physics', selfTimeMs: 5, totalTimeMs: 5 },
        { label: 'Audio', selfTimeMs: 10, totalTimeMs: 10 },
      ],
    });
    expect(
      service
        .getSnapshot()
        .frameImpact.activities.map(activity => activity.label)
        .slice(0, 2)
    ).toEqual(['Physics', 'Audio']);

    frameListener?.({
      dt: 1,
      elapsedTime: 3,
      frameNumber: 3,
      logicMs: 28,
      renderMs: 4,
      totalFrameMs: 32,
      unaccountedMs: 968,
      rafLatenessMs: 0,
      rendererStats,
      profilerActivities: [
        { label: 'Physics', selfTimeMs: 4, totalTimeMs: 4 },
        { label: 'Audio', selfTimeMs: 20, totalTimeMs: 20 },
      ],
    });
    expect(
      service
        .getSnapshot()
        .frameImpact.activities.map(activity => activity.label)
        .slice(0, 2)
    ).toEqual(['Audio', 'Physics']);
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
    expect(snapshot.audio.files).toEqual([]);
    expect(snapshot.audio.activeInstanceCount).toBe(0);
  });
});

/**
 * The bug these cover: the panel reported a rolling-average FPS and a
 * `logic + render` breakdown, so a session with 7 % of frames over 20 ms rendered
 * exactly like a clean 60 fps, and the ~15 ms of a frame that was nobody's work
 * had no representation at all.
 */
describe('ProfilerSessionService — frame stability and honest accounting', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createHarness(initialPrograms = 0) {
    let frameListener: ((sample: SceneRunnerFrameSample) => void) | undefined;
    const runner = {
      subscribeFrameStats(listener: (sample: SceneRunnerFrameSample) => void) {
        frameListener = listener;
        return () => {
          frameListener = undefined;
        };
      },
    } as unknown as import('@pix3/runtime').SceneRunner;
    let programs = initialPrograms;
    const renderer = {
      getStatsSnapshot: (): RuntimeRendererStatsSnapshot => ({
        calls: 1,
        triangles: 2,
        points: 0,
        lines: 0,
        geometries: 3,
        textures: 4,
        programs,
      }),
    } as unknown as import('@pix3/runtime').RuntimeRenderer;

    const service = new ProfilerSessionService();
    service.beginSession('tab');
    service.bindRuntime(runner, renderer, 'tab');

    return {
      service,
      setPrograms(next: number): void {
        programs = next;
      },
      pushFrame(frameIntervalMs: number, overrides: Partial<SceneRunnerFrameSample> = {}): void {
        const logicMs = overrides.logicMs ?? 1;
        const renderMs = overrides.renderMs ?? 1;
        frameListener?.({
          dt: frameIntervalMs / 1000,
          elapsedTime: 1,
          frameNumber: 1,
          logicMs,
          renderMs,
          totalFrameMs: logicMs + renderMs,
          unaccountedMs: Math.max(0, frameIntervalMs - (logicMs + renderMs)),
          rafLatenessMs: 0,
          rendererStats: {
            calls: 1,
            triangles: 2,
            points: 0,
            lines: 0,
            geometries: 3,
            textures: 4,
            programs: 0,
          },
          ...overrides,
        });
      },
    };
  }

  it('reports percentiles and long-frame counts that an averaged FPS cannot show', () => {
    const { service, pushFrame } = createHarness();

    // 93 clean frames + 7 janky ones: the exact shape that used to read "60 fps".
    for (let index = 0; index < 93; index += 1) {
      pushFrame(16.7);
    }
    pushFrame(21);
    pushFrame(22);
    pushFrame(25);
    pushFrame(34);
    pushFrame(40);
    pushFrame(55);
    pushFrame(90);

    const stability = service.getSnapshot().frameStability;
    expect(stability.sampleCount).toBe(100);
    // Percentiles report the containing 1 ms bucket's upper edge, so a session of
    // 16.7 ms frames has a p50 of 17 — never an optimistic value.
    expect(stability.p50Ms).toBe(17);
    expect(stability.p95Ms).toBe(23);
    expect(stability.p99Ms).toBe(56);
    expect(stability.worstMs).toBe(90);
    expect(stability.over20Count).toBe(7);
    expect(stability.over33Count).toBe(4);
    expect(stability.over50Count).toBe(2);
    expect(stability.over20Percent).toBeCloseTo(7, 5);
  });

  it('keeps percentiles bounded: the overflow bucket falls back to the worst frame seen', () => {
    const { service, pushFrame } = createHarness();

    pushFrame(16.7);
    pushFrame(430);

    const stability = service.getSnapshot().frameStability;
    // 430 ms is past the histogram's last bucket, so p99 cannot name a bucket edge
    // and reports the real worst frame instead of silently clamping to 100 ms.
    expect(stability.p99Ms).toBe(430);
    expect(stability.worstMs).toBe(430);
    expect(stability.over50Count).toBe(1);
  });

  it('surfaces unaccounted time and frame-delivery lateness per frame', () => {
    const { service, pushFrame } = createHarness();

    // The real failure mode: a 60 ms frame with 0.3 ms of logic in it.
    pushFrame(60, { logicMs: 0.3, renderMs: 1.1, unaccountedMs: 58.6, rafLatenessMs: 42.5 });

    const performance = service.getSnapshot().performance;
    expect(performance.logicMs).toBe(0.3);
    expect(performance.renderMs).toBe(1.1);
    expect(performance.unaccountedMs).toBeCloseTo(58.6, 5);
    expect(performance.rafLatenessMs).toBeCloseTo(42.5, 5);
    expect(service.getSnapshot().history.unaccountedMs).toEqual([58.6]);
  });

  it('flags shader programs linked after the session started', () => {
    const { service, pushFrame, setPrograms } = createHarness(11);

    pushFrame(16.7);
    expect(service.getSnapshot().performance.shaderPrograms).toBe(11);
    expect(service.getSnapshot().performance.shaderProgramsAdded).toBe(0);

    setPrograms(14);
    pushFrame(16.7);
    const performance = service.getSnapshot().performance;
    expect(performance.shaderPrograms).toBe(14);
    // Growth mid-play is the warning: each new program link stalls the main thread.
    expect(performance.shaderProgramsAdded).toBe(3);
  });

  it('resets the stability histogram with the session', () => {
    const { service, pushFrame } = createHarness();

    pushFrame(80);
    expect(service.getSnapshot().frameStability.over50Count).toBe(1);

    service.endSession();
    const idle = service.getSnapshot().frameStability;
    expect(idle.sampleCount).toBe(0);
    expect(idle.over50Count).toBe(0);
    expect(idle.worstMs).toBeNull();
    expect(idle.p95Ms).toBeNull();
  });
});

describe('FrameIntervalHistogram', () => {
  it('uses nearest-rank percentiles over fixed buckets, so memory does not grow with the session', () => {
    const histogram = new FrameIntervalHistogram();
    for (let index = 0; index < 10_000; index += 1) {
      histogram.record(16.7);
    }
    histogram.record(120);

    const snapshot = histogram.getSnapshot();
    expect(snapshot.sampleCount).toBe(10_001);
    expect(snapshot.p50Ms).toBe(17);
    expect(snapshot.p99Ms).toBe(17);
    expect(snapshot.worstMs).toBe(120);
    expect(snapshot.over50Count).toBe(1);
  });

  it('ignores non-finite and negative intervals instead of poisoning the counters', () => {
    const histogram = new FrameIntervalHistogram();
    histogram.record(Number.NaN);
    histogram.record(Number.POSITIVE_INFINITY);
    histogram.record(-5);

    expect(histogram.getSnapshot().sampleCount).toBe(0);
    expect(histogram.getSnapshot().p50Ms).toBeNull();
  });

  it('clamps a percentile to the worst sample rather than reporting a bucket edge above it', () => {
    const histogram = new FrameIntervalHistogram();
    histogram.record(16.2);

    // The 16 ms bucket's upper edge is 17, but no frame that long was ever seen.
    expect(histogram.getSnapshot().p50Ms).toBe(16.2);
  });
});

function createAudioPlayback(
  overrides: Partial<import('@pix3/runtime').ActiveAudioPlaybackSnapshot> & {
    id: string;
  }
): import('@pix3/runtime').ActiveAudioPlaybackSnapshot {
  return {
    id: overrides.id,
    label: overrides.label ?? 'Unknown',
    bus: overrides.bus ?? 'sfx',
    resourcePath: overrides.resourcePath ?? null,
    startedAtMs: overrides.startedAtMs ?? 0,
    elapsedMs: overrides.elapsedMs ?? 0,
    loop: overrides.loop ?? false,
    volume: overrides.volume ?? 1,
    playbackRate: overrides.playbackRate ?? 1,
    pan: overrides.pan ?? null,
    durationSeconds: overrides.durationSeconds ?? null,
    channelCount: overrides.channelCount ?? null,
    sampleRate: overrides.sampleRate ?? null,
    bitrateKbps: overrides.bitrateKbps ?? null,
  };
}

/**
 * The Profiler is part of Studio, and Studio stays mounted (hidden) while Vibe is on screen — so
 * without an explicit release the game keeps paying for a per-frame sample, and a 10 Hz rebuild,
 * for a panel nobody can see.
 */
describe('ProfilerSessionService — off-screen workspace', () => {
  function makeRunner(): {
    runner: import('@pix3/runtime').SceneRunner;
    isSubscribed: () => boolean;
  } {
    let subscribed = false;
    const runner = {
      subscribeFrameStats() {
        subscribed = true;
        return () => {
          subscribed = false;
        };
      },
    } as unknown as import('@pix3/runtime').SceneRunner;
    return { runner, isSubscribed: () => subscribed };
  }

  const renderer = {
    getStatsSnapshot: () => ({
      calls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
    }),
  } as unknown as import('@pix3/runtime').RuntimeRenderer;

  afterEach(() => {
    appState.ui.workspaceMode = 'studio';
  });

  it('drops the per-frame subscription while Vibe is on screen and takes it back in Studio', async () => {
    const service = new ProfilerSessionService();
    const { runner, isSubscribed } = makeRunner();

    appState.ui.workspaceMode = 'studio';
    service.beginSession('tab');
    service.bindRuntime(runner, renderer, 'tab');
    expect(isSubscribed()).toBe(true);

    appState.ui.workspaceMode = 'flow';
    await Promise.resolve();
    expect(isSubscribed()).toBe(false);

    appState.ui.workspaceMode = 'studio';
    await Promise.resolve();
    expect(isSubscribed()).toBe(true);

    service.endSession();
    expect(isSubscribed()).toBe(false);
  });

  it('does not subscribe at all when bound while Vibe is on screen', () => {
    const service = new ProfilerSessionService();
    const { runner, isSubscribed } = makeRunner();

    appState.ui.workspaceMode = 'flow';
    service.beginSession('tab');
    service.bindRuntime(runner, renderer, 'tab');

    expect(isSubscribed()).toBe(false);
    service.endSession();
  });
});

/**
 * The pause control exists to answer one question — "how much of this jank is the
 * Profiler panel itself?" — and it only answers it if pausing genuinely stops the
 * work. A pause that merely hid the UI would make the whole feature a lie, and
 * these tests are what keeps that from regressing silently.
 */
describe('ProfilerSessionService — pause', () => {
  beforeEach(() => {
    // The notify path is throttled against `performance.now()`, so notification
    // counts are only deterministic under fake timers.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createPauseHarness() {
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
      programs: 5,
    };
    // `getStatsSnapshot` is read exactly once per snapshot assembly, so its call
    // count is a direct, independent measure of how many snapshots were built —
    // rather than trusting the service's own report of what it skipped.
    const getStatsSnapshot = vi.fn(() => rendererStats);
    const renderer = { getStatsSnapshot } as unknown as import('@pix3/runtime').RuntimeRenderer;

    const service = new ProfilerSessionService();
    service.beginSession('tab');
    service.bindRuntime(runner, renderer, 'tab');

    return {
      service,
      /** Re-takes the frame subscription that `beginSession` drops. */
      bind(): void {
        service.bindRuntime(runner, renderer, 'tab');
      },
      snapshotBuildCount: () => getStatsSnapshot.mock.calls.length,
      isSubscribed: () => frameListener !== undefined,
      pushFrames(count: number, frameIntervalMs: number): void {
        for (let index = 0; index < count; index += 1) {
          frameListener?.({
            dt: frameIntervalMs / 1000,
            elapsedTime: index * (frameIntervalMs / 1000),
            frameNumber: index,
            logicMs: 1,
            renderMs: 1,
            totalFrameMs: 2,
            unaccountedMs: Math.max(0, frameIntervalMs - 2),
            rafLatenessMs: 0,
            rendererStats,
          });
        }
      },
    };
  }

  it('stops notifying and stops assembling snapshots while paused, but still records frames', () => {
    const harness = createPauseHarness();
    const notifications: ProfilerSessionSnapshot[] = [];
    harness.service.subscribe(snapshot => notifications.push(snapshot));

    harness.pushFrames(1, 16.7);
    vi.advanceTimersByTime(200);
    expect(notifications.length).toBeGreaterThan(1);
    expect(notifications[notifications.length - 1].paused).toBe(false);

    harness.service.setPaused(true);
    const notificationsAtPause = notifications.length;
    const snapshotsAtPause = harness.snapshotBuildCount();
    expect(notifications[notifications.length - 1].paused).toBe(true);

    harness.pushFrames(10, 30);
    vi.advanceTimersByTime(2000);

    // No listener was told anything, and no snapshot was assembled…
    expect(notifications.length).toBe(notificationsAtPause);
    expect(harness.snapshotBuildCount()).toBe(snapshotsAtPause);

    // …yet every frame landed in the paused arm, and the runner subscription was
    // deliberately left attached so its own sampling cost cancels out of the A/B.
    expect(harness.isSubscribed()).toBe(true);
    const snapshot = harness.service.getSnapshot();
    expect(snapshot.paused).toBe(true);
    expect(snapshot.overhead.paused.sampleCount).toBe(10);
    // History is the clearest proof the per-frame path really was skipped: one
    // live frame in, one sample out, ten paused frames added nothing.
    expect(snapshot.history.fps.length).toBe(1);
  });

  it('attributes every frame to the arm that was active when it happened', () => {
    const harness = createPauseHarness();

    harness.pushFrames(3, 16.7);
    harness.service.setPaused(true);
    harness.pushFrames(5, 16.7);
    harness.service.setPaused(false);
    harness.pushFrames(2, 16.7);

    const { overhead, frameStability } = harness.service.getSnapshot();
    expect(overhead.live.sampleCount).toBe(5);
    expect(overhead.paused.sampleCount).toBe(5);
    // The arms partition the session: nothing counted twice, nothing dropped.
    expect(overhead.live.sampleCount + overhead.paused.sampleCount).toBe(
      frameStability.sampleCount
    );
  });

  it('withholds the verdict until both arms clear the minimum sample count', () => {
    const harness = createPauseHarness();

    harness.pushFrames(PROFILER_AB_MIN_ARM_FRAMES, 25);
    harness.service.setPaused(true);
    harness.pushFrames(PROFILER_AB_MIN_ARM_FRAMES - 1, 16.7);

    const underpowered = harness.service.getSnapshot().overhead;
    expect(underpowered.live.sampleCount).toBe(PROFILER_AB_MIN_ARM_FRAMES);
    expect(underpowered.paused.sampleCount).toBe(PROFILER_AB_MIN_ARM_FRAMES - 1);
    expect(underpowered.comparable).toBe(false);
    // Null, not 0: an absent result must not render like a measured "no difference".
    expect(underpowered.p95DeltaMs).toBeNull();
    expect(underpowered.over20PercentDelta).toBeNull();

    harness.pushFrames(1, 16.7);

    const comparable = harness.service.getSnapshot().overhead;
    expect(comparable.comparable).toBe(true);
    // 25 ms live against 16.7 ms paused — the delta must carry the sign of the
    // more expensive arm (live), not just its magnitude.
    expect(comparable.p95DeltaMs).toBeGreaterThan(0);
    expect(comparable.over20PercentDelta).toBeCloseTo(100, 5);
  });

  it('clears both arms and un-pauses when a session starts or ends', () => {
    const harness = createPauseHarness();

    harness.pushFrames(4, 16.7);
    harness.service.setPaused(true);
    harness.pushFrames(6, 16.7);
    expect(harness.service.getSnapshot().overhead.paused.sampleCount).toBe(6);

    harness.service.beginSession('tab');
    harness.bind();
    const restarted = harness.service.getSnapshot();
    expect(restarted.paused).toBe(false);
    expect(harness.service.isPaused()).toBe(false);
    expect(restarted.overhead.live.sampleCount).toBe(0);
    expect(restarted.overhead.paused.sampleCount).toBe(0);

    harness.pushFrames(2, 16.7);
    harness.service.setPaused(true);
    harness.service.endSession();
    const ended = harness.service.getSnapshot();
    expect(ended.paused).toBe(false);
    expect(ended.overhead.live.sampleCount).toBe(0);
    expect(ended.overhead.paused.sampleCount).toBe(0);
  });
});
