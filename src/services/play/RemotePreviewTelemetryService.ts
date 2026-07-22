import { injectable, inject } from '@/fw/di';
import type {
  PreviewDeviceInfo,
  PreviewLogEntryPayload,
  PreviewMetricsSample,
  PreviewPlayModeStatus,
} from '@/core/remote-preview/protocol';
import { LoggingService, type LogLevel } from '@/services/core/LoggingService';
import type { ProfilerSessionSnapshot } from '@/services/play/ProfilerSessionService';

export interface RemotePlayerTelemetry {
  readonly clientId: string;
  /** Human label derived from the device info (e.g. "Pixel 7", "iPhone"). */
  readonly label: string;
  readonly deviceInfo: PreviewDeviceInfo | null;
  readonly playModeStatus: PreviewPlayModeStatus;
  readonly statusDetail: string | null;
  readonly lastSample: PreviewMetricsSample | null;
  readonly lastSeenAt: number;
  /** False once the player stops reporting (metrics arrive every second). */
  readonly connected: boolean;
}

type TelemetryListener = (players: readonly RemotePlayerTelemetry[]) => void;

interface PlayerEntry {
  clientId: string;
  deviceInfo: PreviewDeviceInfo | null;
  playModeStatus: PreviewPlayModeStatus;
  statusDetail: string | null;
  lastSample: PreviewMetricsSample | null;
  lastSeenAt: number;
  connected: boolean;
  fpsHistory: number[];
  frameTimeHistory: number[];
  logicHistory: number[];
  renderHistory: number[];
}

/** Matches the profiler panel's local history window (360 points = 6 min at 1Hz). */
const HISTORY_WINDOW_SIZE = 360;
/** Metrics arrive at 1Hz; a few missed beats means the player went away. */
const STALE_AFTER_MS = 4000;
const STALE_CHECK_INTERVAL_MS = 2000;

/**
 * Editor-side sink for telemetry reported by remote preview players (relay
 * `log` / `metrics` / `status` / `device-info` messages, keyed by relay
 * clientId). Remote logs are mirrored into LoggingService with the device
 * label as `source`; metrics are kept per player and exposed to the profiler
 * panel as ProfilerSessionSnapshot-shaped data.
 */
@injectable()
export class RemotePreviewTelemetryService {
  @inject(LoggingService)
  private readonly loggingService!: LoggingService;

  private readonly players = new Map<string, PlayerEntry>();
  private readonly listeners = new Set<TelemetryListener>();
  private staleTimer: number | null = null;

  subscribe(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    listener(this.getPlayers());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getPlayers(): RemotePlayerTelemetry[] {
    return Array.from(this.players.values()).map(entry => ({
      clientId: entry.clientId,
      label: this.getLabel(entry),
      deviceInfo: entry.deviceInfo,
      playModeStatus: entry.playModeStatus,
      statusDetail: entry.statusDetail,
      lastSample: entry.lastSample,
      lastSeenAt: entry.lastSeenAt,
      connected: entry.connected,
    }));
  }

  hasPlayers(): boolean {
    return this.players.size > 0;
  }

  /** Profiler-panel view of one remote player, built from 1Hz aggregates. */
  getProfilerSnapshot(clientId: string): ProfilerSessionSnapshot | null {
    const entry = this.players.get(clientId);
    if (!entry) {
      return null;
    }

    const sample = entry.lastSample;
    const running = entry.connected && sample !== null;
    return {
      status: running ? 'running' : entry.playModeStatus === 'loading' ? 'starting' : 'idle',
      performance: {
        fps: sample?.fps ?? null,
        frameTimeMs: sample?.frameMs ?? null,
        logicMs: sample?.logicMs ?? null,
        renderMs: sample?.renderMs ?? null,
        drawCalls: sample?.drawCalls ?? null,
        triangles: sample?.triangles ?? null,
        geometries: sample?.geometries ?? null,
        textures: sample?.textures ?? null,
        jsHeapUsedMb: sample?.jsHeapUsedMb ?? null,
      },
      counters: {
        elapsedMs: Math.max(0, (sample?.elapsedTime ?? 0) * 1000),
        frameCount: sample?.frameNumber ?? 0,
        hostKind: 'remote',
      },
      history: {
        fps: [...entry.fpsHistory],
        frameTimeMs: [...entry.frameTimeHistory],
        logicMs: [...entry.logicHistory],
        renderMs: [...entry.renderHistory],
      },
      frameImpact: {
        activities: [],
        sampledFrameCount: 0,
        windowDurationMs: 0,
        totalFrameTimeMs: 0,
      },
      audio: {
        files: [],
        activeInstanceCount: 0,
      },
    };
  }

  handleMetrics(clientId: string, sample: PreviewMetricsSample): void {
    const entry = this.ensurePlayer(clientId);
    entry.lastSample = sample;
    entry.lastSeenAt = Date.now();
    entry.connected = true;
    this.pushHistory(entry.fpsHistory, sample.fps);
    this.pushHistory(entry.frameTimeHistory, sample.frameMs);
    this.pushHistory(entry.logicHistory, sample.logicMs);
    this.pushHistory(entry.renderHistory, sample.renderMs);
    this.ensureStaleTimer();
    this.notify();
  }

  handleLogEntries(clientId: string, entries: readonly PreviewLogEntryPayload[]): void {
    const entry = this.ensurePlayer(clientId);
    entry.lastSeenAt = Date.now();
    const source = this.getLabel(entry);
    for (const logEntry of entries) {
      if (typeof logEntry?.message !== 'string') {
        continue;
      }
      // Editor receipt time keeps ordering sane across devices with skewed clocks.
      this.loggingService.logFrom(source, this.normalizeLevel(logEntry.level), logEntry.message);
    }
  }

  handleStatus(clientId: string, status: PreviewPlayModeStatus, detail?: string): void {
    const entry = this.ensurePlayer(clientId);
    entry.playModeStatus = status;
    entry.statusDetail = detail ?? null;
    entry.lastSeenAt = Date.now();
    entry.connected = true;
    if (status === 'error' && detail) {
      this.loggingService.logFrom(
        this.getLabel(entry),
        'error',
        `Player failed to start: ${detail}`
      );
    }
    this.notify();
  }

  handleDeviceInfo(clientId: string, info: PreviewDeviceInfo): void {
    const entry = this.ensurePlayer(clientId);
    entry.deviceInfo = info;
    entry.lastSeenAt = Date.now();
    entry.connected = true;
    this.notify();
  }

  /** Relay peer-status: with zero players everything left is disconnected. */
  handlePlayerCount(playerCount: number): void {
    if (playerCount === 0) {
      let changed = false;
      for (const entry of this.players.values()) {
        if (entry.connected) {
          entry.connected = false;
          changed = true;
        }
      }
      if (changed) {
        this.notify();
      }
    }
  }

  /** Preview session ended: drop all per-player state. */
  reset(): void {
    this.players.clear();
    this.clearStaleTimer();
    this.notify();
  }

  dispose(): void {
    this.reset();
    this.listeners.clear();
  }

  private ensurePlayer(clientId: string): PlayerEntry {
    let entry = this.players.get(clientId);
    if (!entry) {
      entry = {
        clientId,
        deviceInfo: null,
        playModeStatus: 'idle',
        statusDetail: null,
        lastSample: null,
        lastSeenAt: Date.now(),
        connected: true,
        fpsHistory: [],
        frameTimeHistory: [],
        logicHistory: [],
        renderHistory: [],
      };
      this.players.set(clientId, entry);
    }
    return entry;
  }

  private pushHistory(target: number[], value: number): void {
    target.push(Number.isFinite(value) ? value : 0);
    if (target.length > HISTORY_WINDOW_SIZE) {
      target.shift();
    }
  }

  private getLabel(entry: PlayerEntry): string {
    const base = entry.deviceInfo
      ? this.describeDevice(entry.deviceInfo)
      : `Player ${entry.clientId.slice(0, 4)}`;

    // Disambiguate identical device models with a short client id suffix.
    for (const other of this.players.values()) {
      if (
        other.clientId !== entry.clientId &&
        other.deviceInfo &&
        entry.deviceInfo &&
        this.describeDevice(other.deviceInfo) === base
      ) {
        return `${base} ${entry.clientId.slice(0, 4)}`;
      }
    }
    return base;
  }

  private describeDevice(info: PreviewDeviceInfo): string {
    const ua = info.userAgent;
    const androidModel = /Android [\d.]+; ([^);]+)/.exec(ua)?.[1]?.replace(/ Build\/.*$/, '');
    if (androidModel) {
      return androidModel.trim();
    }
    if (/iPhone/.test(ua)) {
      return 'iPhone';
    }
    if (/iPad/.test(ua)) {
      return 'iPad';
    }
    if (/Windows/.test(ua)) {
      return 'Windows';
    }
    if (/Macintosh/.test(ua)) {
      return 'Mac';
    }
    if (/Linux/.test(ua)) {
      return 'Linux';
    }
    return 'Player';
  }

  private normalizeLevel(level: unknown): LogLevel {
    return level === 'debug' || level === 'info' || level === 'warn' || level === 'error'
      ? level
      : 'info';
  }

  private ensureStaleTimer(): void {
    if (this.staleTimer !== null) {
      return;
    }
    this.staleTimer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      let anyConnected = false;
      for (const entry of this.players.values()) {
        const stale = now - entry.lastSeenAt > STALE_AFTER_MS;
        if (stale && entry.connected) {
          entry.connected = false;
          changed = true;
        }
        anyConnected ||= entry.connected;
      }
      if (!anyConnected) {
        this.clearStaleTimer();
      }
      if (changed) {
        this.notify();
      }
    }, STALE_CHECK_INTERVAL_MS);
  }

  private clearStaleTimer(): void {
    if (this.staleTimer !== null) {
      window.clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private notify(): void {
    const players = this.getPlayers();
    for (const listener of this.listeners) {
      listener(players);
    }
  }
}
