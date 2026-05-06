import { injectable } from '@/fw/di';
import type {
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

export interface ProfilerSessionSnapshot {
  readonly status: ProfilerSessionStatus;
  readonly performance: ProfilerPerformanceSnapshot;
  readonly counters: ProfilerCountersSnapshot;
  readonly history: ProfilerHistorySnapshot;
}

type ProfilerListener = (snapshot: ProfilerSessionSnapshot) => void;

interface MemoryPerformance extends Performance {
  memory?: {
    usedJSHeapSize: number;
  };
}

const SAMPLE_WINDOW_SIZE = 30;
const HISTORY_WINDOW_SIZE = 360;

@injectable()
export class ProfilerSessionService {
  private readonly listeners = new Set<ProfilerListener>();
  private readonly frameTimesMs: number[] = [];
  private readonly fpsHistory: number[] = [];
  private readonly frameTimeHistory: number[] = [];
  private readonly logicHistory: number[] = [];
  private readonly renderHistory: number[] = [];
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
    };
  }

  beginSession(hostKind: GameHostKind): void {
    this.frameTimesMs.length = 0;
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
    };
    this.notify();
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

  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
