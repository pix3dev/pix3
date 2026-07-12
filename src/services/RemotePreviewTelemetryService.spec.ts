import { beforeEach, describe, expect, it } from 'vitest';

import { RemotePreviewTelemetryService } from './RemotePreviewTelemetryService';
import type { LogLevel } from './LoggingService';
import type { PreviewMetricsSample } from '@/core/remote-preview/protocol';

interface RecordedLog {
  source: string;
  level: LogLevel;
  message: string;
}

function createService(): { service: RemotePreviewTelemetryService; logged: RecordedLog[] } {
  const logged: RecordedLog[] = [];
  const service = new RemotePreviewTelemetryService();
  Object.defineProperty(service, 'loggingService', {
    value: {
      logFrom(source: string, level: LogLevel, message: string) {
        logged.push({ source, level, message });
      },
    },
    configurable: true,
  });
  return { service, logged };
}

function createSample(overrides: Partial<PreviewMetricsSample> = {}): PreviewMetricsSample {
  return {
    fps: 59.5,
    frameMs: 16.8,
    logicMs: 4.2,
    renderMs: 9.1,
    drawCalls: 42,
    triangles: 10500,
    geometries: 7,
    textures: 12,
    elapsedTime: 12.5,
    frameNumber: 750,
    maxFrameMs: 41.2,
    longFrameCount: 2,
    jsHeapUsedMb: 38.4,
    ...overrides,
  };
}

describe('RemotePreviewTelemetryService', () => {
  let service: RemotePreviewTelemetryService;
  let logged: RecordedLog[];

  beforeEach(() => {
    ({ service, logged } = createService());
  });

  it('maps metrics samples into a profiler snapshot with history', () => {
    service.handleMetrics('client-a', createSample());
    service.handleMetrics('client-a', createSample({ fps: 30, frameMs: 33.3 }));

    const snapshot = service.getProfilerSnapshot('client-a');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.status).toBe('running');
    expect(snapshot?.performance.fps).toBe(30);
    expect(snapshot?.performance.frameTimeMs).toBe(33.3);
    expect(snapshot?.performance.jsHeapUsedMb).toBe(38.4);
    expect(snapshot?.counters.hostKind).toBe('remote');
    expect(snapshot?.counters.frameCount).toBe(750);
    expect(snapshot?.history.fps).toEqual([59.5, 30]);
    expect(snapshot?.history.logicMs).toHaveLength(2);
  });

  it('mirrors player logs into LoggingService with the device label as source', () => {
    service.handleDeviceInfo('client-a', {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A) AppleWebKit/537.36 Chrome/120 Mobile',
      devicePixelRatio: 2.6,
      screenWidth: 412,
      screenHeight: 915,
      viewportWidth: 412,
      viewportHeight: 800,
      gpu: 'Adreno 730',
      deviceMemoryGb: 8,
      hardwareConcurrency: 8,
      language: 'en-US',
    });

    service.handleLogEntries('client-a', [
      { level: 'info', message: 'game started', timestamp: 1 },
      { level: 'error', message: 'boom', timestamp: 2 },
    ]);

    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({ source: 'Pixel 7', level: 'info', message: 'game started' });
    expect(logged[1]).toMatchObject({ source: 'Pixel 7', level: 'error', message: 'boom' });
  });

  it('labels players without device info by client id', () => {
    service.handleMetrics('abcdef', createSample());
    const players = service.getPlayers();
    expect(players).toHaveLength(1);
    expect(players[0].label).toBe('Player abcd');
  });

  it('marks all players disconnected when the relay reports zero players', () => {
    service.handleMetrics('client-a', createSample());
    expect(service.getPlayers()[0].connected).toBe(true);

    service.handlePlayerCount(0);
    expect(service.getPlayers()[0].connected).toBe(false);
    expect(service.getProfilerSnapshot('client-a')?.status).toBe('idle');
  });

  it('drops all state on reset', () => {
    service.handleMetrics('client-a', createSample());
    service.reset();
    expect(service.hasPlayers()).toBe(false);
    expect(service.getProfilerSnapshot('client-a')).toBeNull();
  });
});
