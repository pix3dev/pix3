import { injectable } from '@/fw/di';
import type {
  FrameProfilerActivity,
  RuntimeRenderer,
  RuntimeRendererStatsSnapshot,
  SceneRunner,
  SceneRunnerFrameSample,
} from '@pix3/runtime';

type GameHostKind = 'tab' | 'popout';
export type ProfilerSessionStatus = 'idle' | 'starting' | 'running';

export interface ProfilerPerformanceSnapshot {
  readonly fps: number | null;
  readonly frameTimeMs: number | null;
  readonly logicMs: number | null;
  readonly renderMs: number | null;
  readonly drawCalls: number | null;
  readonly triangles: number | null;
  readonly geometries: number | null;
  readonly textures: number | null;
  readonly jsHeapUsedMb: number | null;
}

export interface ProfilerHistorySnapshot {
  readonly fps: readonly number[];
  readonly frameTimeMs: readonly number[];
  readonly logicMs: readonly number[];
  readonly renderMs: readonly number[];
}

export interface ProfilerCountersSnapshot {
  readonly elapsedMs: number;
  readonly frameCount: number;
  readonly hostKind: GameHostKind | null;
}

export interface ProfilerFrameImpactEntrySnapshot {
  readonly label: string;
  readonly selfTimeMs: number;
  readonly totalTimeMs: number;
  readonly selfPercent: number | null;
  readonly totalPercent: number | null;
  readonly sampleCount: number;
}

export interface ProfilerFrameImpactSnapshot {
  readonly activities: readonly ProfilerFrameImpactEntrySnapshot[];
  readonly sampledFrameCount: number;
  readonly windowDurationMs: number;
  readonly totalFrameTimeMs: number;
}

export interface ProfilerSessionSnapshot {
  readonly status: ProfilerSessionStatus;
  readonly performance: ProfilerPerformanceSnapshot;
  readonly counters: ProfilerCountersSnapshot;
  readonly history: ProfilerHistorySnapshot;
  readonly frameImpact: ProfilerFrameImpactSnapshot;
}

type ProfilerListener = (snapshot: ProfilerSessionSnapshot) => void;

interface MemoryPerformance extends Performance {
  memory?: {
    usedJSHeapSize: number;
  };
}

interface ActivityFrameSample {
  readonly frameTimeMs: number;
  readonly activities: readonly FrameProfilerActivity[];
}

const SAMPLE_WINDOW_SIZE = 30;
const HISTORY_WINDOW_SIZE = 360;
const FRAME_IMPACT_WINDOW_MS = 8000;
const MIN_FRAME_IMPACT_REORDER_HYSTERESIS_MS = 8;
const FRAME_IMPACT_REORDER_HYSTERESIS_RATIO = 0.002;
const MIN_RUNTIME_FRAME_IMPACT_ROW_MS = 0.01;
const RUNTIME_RENDER_LABEL = 'Runtime Render';
const RUNTIME_LOGIC_LABEL = 'Runtime Logic';
const RUNTIME_LOGIC_UNTRACKED_LABEL = 'Runtime Logic (Untracked)';

@injectable()
export class ProfilerSessionService {
  private readonly listeners = new Set<ProfilerListener>();
  private readonly frameTimesMs: number[] = [];
  private readonly fpsHistory: number[] = [];
  private readonly frameTimeHistory: number[] = [];
  private readonly logicHistory: number[] = [];
  private readonly renderHistory: number[] = [];
  private readonly activityFrames: ActivityFrameSample[] = [];
  private previousFrameImpactOrder: string[] = [];
  private disposeRunnerSubscription?: () => void;
  private runtimeRenderer: RuntimeRenderer | null = null;
  private state: ProfilerSessionSnapshot = this.createIdleSnapshot();

  subscribe(listener: ProfilerListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ProfilerSessionSnapshot {
    return {
      status: this.state.status,
      performance: { ...this.state.performance },
      counters: { ...this.state.counters },
      history: {
        fps: [...this.state.history.fps],
        frameTimeMs: [...this.state.history.frameTimeMs],
        logicMs: [...this.state.history.logicMs],
        renderMs: [...this.state.history.renderMs],
      },
      frameImpact: {
        activities: this.state.frameImpact.activities.map(activity => ({ ...activity })),
        sampledFrameCount: this.state.frameImpact.sampledFrameCount,
        windowDurationMs: this.state.frameImpact.windowDurationMs,
        totalFrameTimeMs: this.state.frameImpact.totalFrameTimeMs,
      },
    };
  }

  beginSession(hostKind: GameHostKind): void {
    this.frameTimesMs.length = 0;
    this.activityFrames.length = 0;
    this.previousFrameImpactOrder = [];
    this.runtimeRenderer = null;
    this.disposeRunnerSubscription?.();
    this.disposeRunnerSubscription = undefined;
    this.state = {
      status: 'starting',
      performance: {
        fps: null,
        frameTimeMs: null,
        logicMs: null,
        renderMs: null,
        drawCalls: null,
        triangles: null,
        geometries: null,
        textures: null,
        jsHeapUsedMb: this.readJsHeapUsedMb(),
      },
      counters: {
        elapsedMs: 0,
        frameCount: 0,
        hostKind,
      },
      history: this.createEmptyHistory(),
      frameImpact: this.createEmptyFrameImpact(),
    };
    this.notify();
  }

  bindRuntime(runner: SceneRunner, renderer: RuntimeRenderer, hostKind: GameHostKind): void {
    this.runtimeRenderer = renderer;
    this.state = {
      ...this.state,
      counters: {
        ...this.state.counters,
        hostKind,
      },
    };
    this.disposeRunnerSubscription?.();
    this.disposeRunnerSubscription = runner.subscribeFrameStats(sample => {
      this.handleFrameSample(sample);
    });
    this.notify();
  }

  endSession(): void {
    this.disposeRunnerSubscription?.();
    this.disposeRunnerSubscription = undefined;
    this.runtimeRenderer = null;
    this.frameTimesMs.length = 0;
    this.fpsHistory.length = 0;
    this.frameTimeHistory.length = 0;
    this.logicHistory.length = 0;
    this.renderHistory.length = 0;
    this.activityFrames.length = 0;
    this.previousFrameImpactOrder = [];
    this.state = this.createIdleSnapshot();
    this.notify();
  }

  private handleFrameSample(sample: SceneRunnerFrameSample): void {
    this.pushFrameTime(sample.dt * 1000);
    const averagedFrameTime = this.getAverageFrameTimeMs();
    const rendererStats =
      this.runtimeRenderer?.getStatsSnapshot() ??
      sample.rendererStats ??
      this.createEmptyRendererStats();
    const fps = averagedFrameTime > 0 ? 1000 / averagedFrameTime : null;
    const frameTimeMs = averagedFrameTime > 0 ? averagedFrameTime : null;
    this.pushActivityFrame(this.createFrameImpactActivities(sample), sample.dt * 1000);
    this.pushHistorySample(this.fpsHistory, fps);
    this.pushHistorySample(this.frameTimeHistory, frameTimeMs);
    this.pushHistorySample(this.logicHistory, sample.logicMs);
    this.pushHistorySample(this.renderHistory, sample.renderMs);
    this.state = {
      status: 'running',
      performance: {
        fps,
        frameTimeMs,
        logicMs: sample.logicMs,
        renderMs: sample.renderMs,
        drawCalls: rendererStats.calls,
        triangles: rendererStats.triangles,
        geometries: rendererStats.geometries,
        textures: rendererStats.textures,
        jsHeapUsedMb: this.readJsHeapUsedMb(),
      },
      counters: {
        elapsedMs: Math.max(0, sample.elapsedTime * 1000),
        frameCount: sample.frameNumber,
        hostKind: this.state.counters.hostKind,
      },
      history: {
        fps: [...this.fpsHistory],
        frameTimeMs: [...this.frameTimeHistory],
        logicMs: [...this.logicHistory],
        renderMs: [...this.renderHistory],
      },
      frameImpact: this.createFrameImpactSnapshot(),
    };
    this.notify();
  }

  private createFrameImpactActivities(sample: SceneRunnerFrameSample): FrameProfilerActivity[] {
    const customActivities = this.normalizeActivityFrame(sample.profilerActivities);
    return [...customActivities, ...this.createRuntimeFrameImpactActivities(sample, customActivities)];
  }

  private createRuntimeFrameImpactActivities(
    sample: SceneRunnerFrameSample,
    customActivities: readonly FrameProfilerActivity[]
  ): FrameProfilerActivity[] {
    const logicMs = this.normalizeActivityTime(sample.logicMs) ?? 0;
    const renderMs = this.normalizeActivityTime(sample.renderMs) ?? 0;
    const trackedCustomLogicMs = customActivities.reduce(
      (accumulator, activity) => accumulator + activity.selfTimeMs,
      0
    );
    const runtimeActivities: FrameProfilerActivity[] = [];

    if (renderMs > MIN_RUNTIME_FRAME_IMPACT_ROW_MS) {
      runtimeActivities.push({
        label: RUNTIME_RENDER_LABEL,
        selfTimeMs: renderMs,
      });
    }

    if (customActivities.length === 0) {
      if (logicMs > MIN_RUNTIME_FRAME_IMPACT_ROW_MS) {
        runtimeActivities.push({
          label: RUNTIME_LOGIC_LABEL,
          selfTimeMs: logicMs,
        });
      }

      return runtimeActivities;
    }

    const untrackedLogicMs = Math.max(0, logicMs - trackedCustomLogicMs);
    if (untrackedLogicMs > MIN_RUNTIME_FRAME_IMPACT_ROW_MS) {
      runtimeActivities.push({
        label: RUNTIME_LOGIC_UNTRACKED_LABEL,
        selfTimeMs: untrackedLogicMs,
      });
    }

    return runtimeActivities;
  }

  private pushFrameTime(frameTimeMs: number): void {
    this.frameTimesMs.push(frameTimeMs);
    if (this.frameTimesMs.length > SAMPLE_WINDOW_SIZE) {
      this.frameTimesMs.shift();
    }
  }

  private getAverageFrameTimeMs(): number {
    if (this.frameTimesMs.length === 0) {
      return 0;
    }

    const sum = this.frameTimesMs.reduce((accumulator, value) => accumulator + value, 0);
    return sum / this.frameTimesMs.length;
  }

  private pushHistorySample(target: number[], value: number | null): void {
    target.push(typeof value === 'number' && Number.isFinite(value) ? value : 0);
    if (target.length > HISTORY_WINDOW_SIZE) {
      target.shift();
    }
  }

  private pushActivityFrame(
    activities: readonly FrameProfilerActivity[] | undefined,
    frameTimeMs: number
  ): void {
    const normalizedFrameTimeMs = this.normalizeActivityTime(frameTimeMs) ?? 0;
    this.activityFrames.push({
      frameTimeMs: normalizedFrameTimeMs,
      activities: this.normalizeActivityFrame(activities),
    });

    while (
      this.activityFrames.length > 1 &&
      this.getActivityFrameWindowDurationMs() > FRAME_IMPACT_WINDOW_MS
    ) {
      this.activityFrames.shift();
    }
  }

  private normalizeActivityFrame(
    activities: readonly FrameProfilerActivity[] | undefined
  ): FrameProfilerActivity[] {
    if (!activities || activities.length === 0) {
      return [];
    }

    const normalized: FrameProfilerActivity[] = [];
    for (const activity of activities) {
      const label = typeof activity.label === 'string' ? activity.label.trim() : '';
      if (!label) {
        continue;
      }

      const selfTimeMs = this.normalizeActivityTime(activity.selfTimeMs);
      if (selfTimeMs === null) {
        continue;
      }

      const totalTimeMs = this.normalizeActivityTime(activity.totalTimeMs);
      normalized.push(
        totalTimeMs === null
          ? { label, selfTimeMs }
          : {
              label,
              selfTimeMs,
              totalTimeMs: Math.max(totalTimeMs, selfTimeMs),
            }
      );
    }

    return normalized;
  }

  private normalizeActivityTime(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return null;
    }

    return value;
  }

  private createFrameImpactSnapshot(): ProfilerFrameImpactSnapshot {
    if (this.activityFrames.length === 0) {
      return this.createEmptyFrameImpact();
    }

    const totalFrameTimeMs = this.getActivityFrameWindowDurationMs();
    const sampledFrameCount = this.activityFrames.length;
    const aggregates = new Map<
      string,
      {
        label: string;
        selfSum: number;
        totalSum: number;
        sampleCount: number;
      }
    >();

    for (const frame of this.activityFrames) {
      for (const activity of frame.activities) {
        const entry = aggregates.get(activity.label) ?? {
          label: activity.label,
          selfSum: 0,
          totalSum: 0,
          sampleCount: 0,
        };
        entry.selfSum += activity.selfTimeMs;
        entry.totalSum += activity.totalTimeMs ?? activity.selfTimeMs;
        entry.sampleCount += 1;
        aggregates.set(activity.label, entry);
      }
    }

    const activities = this.orderFrameImpactActivities(
      [...aggregates.values()]
      .map(entry => {
        const selfTimeMs = entry.selfSum;
        const totalTimeMs = entry.totalSum;
        return {
          label: entry.label,
          selfTimeMs,
          totalTimeMs,
          selfPercent: this.toFrameImpactPercent(selfTimeMs, totalFrameTimeMs),
          totalPercent: this.toFrameImpactPercent(totalTimeMs, totalFrameTimeMs),
          sampleCount: entry.sampleCount,
        } satisfies ProfilerFrameImpactEntrySnapshot;
      })
      .filter(activity => activity.totalTimeMs > 0 || activity.selfTimeMs > 0),
      totalFrameTimeMs
    );

    return {
      activities,
      sampledFrameCount,
      windowDurationMs: totalFrameTimeMs,
      totalFrameTimeMs,
    };
  }

  private getActivityFrameWindowDurationMs(): number {
    return this.activityFrames.reduce(
      (accumulator, frame) => accumulator + frame.frameTimeMs,
      0
    );
  }

  private orderFrameImpactActivities(
    activities: ProfilerFrameImpactEntrySnapshot[],
    totalFrameTimeMs: number
  ): ProfilerFrameImpactEntrySnapshot[] {
    if (activities.length === 0) {
      this.previousFrameImpactOrder = [];
      return [];
    }

    const activityByLabel = new Map(activities.map(activity => [activity.label, activity]));
    const previousLabels = this.previousFrameImpactOrder.filter(label => activityByLabel.has(label));
    const previousLabelSet = new Set(previousLabels);
    const newLabels = activities
      .map(activity => activity.label)
      .filter(label => !previousLabelSet.has(label))
      .sort((leftLabel, rightLabel) => {
        const leftActivity = activityByLabel.get(leftLabel);
        const rightActivity = activityByLabel.get(rightLabel);
        if (!leftActivity || !rightActivity) {
          return 0;
        }

        return this.compareFrameImpactActivities(leftActivity, rightActivity);
      });

    const orderedLabels = [...previousLabels, ...newLabels];
    const thresholdMs = this.getFrameImpactReorderThresholdMs(totalFrameTimeMs);

    let moved = true;
    while (moved) {
      moved = false;
      for (let index = 1; index < orderedLabels.length; index += 1) {
        const currentActivity = activityByLabel.get(orderedLabels[index] ?? '');
        const previousActivity = activityByLabel.get(orderedLabels[index - 1] ?? '');
        if (!currentActivity || !previousActivity) {
          continue;
        }

        if (!this.shouldPromoteFrameImpactActivity(currentActivity, previousActivity, thresholdMs)) {
          continue;
        }

        [orderedLabels[index - 1], orderedLabels[index]] = [
          orderedLabels[index] ?? '',
          orderedLabels[index - 1] ?? '',
        ];
        moved = true;
      }
    }

    this.previousFrameImpactOrder = [...orderedLabels];
    return orderedLabels
      .map(label => activityByLabel.get(label))
      .filter(
        (activity): activity is ProfilerFrameImpactEntrySnapshot => activity !== undefined
      );
  }

  private compareFrameImpactActivities(
    left: ProfilerFrameImpactEntrySnapshot,
    right: ProfilerFrameImpactEntrySnapshot
  ): number {
    return (
      right.totalTimeMs - left.totalTimeMs ||
      right.selfTimeMs - left.selfTimeMs ||
      left.label.localeCompare(right.label)
    );
  }

  private shouldPromoteFrameImpactActivity(
    candidate: ProfilerFrameImpactEntrySnapshot,
    currentAbove: ProfilerFrameImpactEntrySnapshot,
    thresholdMs: number
  ): boolean {
    const totalLeadMs = candidate.totalTimeMs - currentAbove.totalTimeMs;
    if (totalLeadMs > thresholdMs) {
      return true;
    }

    if (Math.abs(totalLeadMs) > thresholdMs) {
      return false;
    }

    return candidate.selfTimeMs - currentAbove.selfTimeMs > thresholdMs;
  }

  private getFrameImpactReorderThresholdMs(totalFrameTimeMs: number): number {
    if (!Number.isFinite(totalFrameTimeMs) || totalFrameTimeMs <= 0) {
      return MIN_FRAME_IMPACT_REORDER_HYSTERESIS_MS;
    }

    return Math.max(
      MIN_FRAME_IMPACT_REORDER_HYSTERESIS_MS,
      totalFrameTimeMs * FRAME_IMPACT_REORDER_HYSTERESIS_RATIO
    );
  }

  private toFrameImpactPercent(
    timeMs: number,
    averageFrameTimeMs: number | null
  ): number | null {
    if (
      !Number.isFinite(timeMs) ||
      timeMs < 0 ||
      typeof averageFrameTimeMs !== 'number' ||
      !Number.isFinite(averageFrameTimeMs) ||
      averageFrameTimeMs <= 0
    ) {
      return null;
    }

    return (timeMs / averageFrameTimeMs) * 100;
  }

  private readJsHeapUsedMb(): number | null {
    const perf = globalThis.performance as MemoryPerformance | undefined;
    const usedBytes = perf?.memory?.usedJSHeapSize;
    if (typeof usedBytes !== 'number' || !Number.isFinite(usedBytes) || usedBytes < 0) {
      return null;
    }

    return usedBytes / (1024 * 1024);
  }

  private createIdleSnapshot(): ProfilerSessionSnapshot {
    return {
      status: 'idle',
      performance: {
        fps: null,
        frameTimeMs: null,
        logicMs: null,
        renderMs: null,
        drawCalls: null,
        triangles: null,
        geometries: null,
        textures: null,
        jsHeapUsedMb: this.readJsHeapUsedMb(),
      },
      counters: {
        elapsedMs: 0,
        frameCount: 0,
        hostKind: null,
      },
      history: this.createEmptyHistory(),
      frameImpact: this.createEmptyFrameImpact(),
    };
  }

  private createEmptyRendererStats(): RuntimeRendererStatsSnapshot {
    return {
      calls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      geometries: 0,
      textures: 0,
    };
  }

  private createEmptyHistory(): ProfilerHistorySnapshot {
    return {
      fps: [],
      frameTimeMs: [],
      logicMs: [],
      renderMs: [],
    };
  }

  private createEmptyFrameImpact(): ProfilerFrameImpactSnapshot {
    return {
      activities: [],
      sampledFrameCount: 0,
      windowDurationMs: 0,
      totalFrameTimeMs: 0,
    };
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
