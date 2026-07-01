import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProfilerSessionService, ProfilerSessionSnapshot } from '@/services';

vi.mock('@/services', () => ({
  ProfilerSessionService: class ProfilerSessionService {},
}));

await import('./profiler-panel');

type ProfilerPanelElement = HTMLElementTagNameMap['pix3-profiler-panel'];

describe('ProfilerPanel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders idle state when play session is not active', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(panel, createSnapshot({ status: 'idle' }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.textContent).toContain('Profiler metrics appear here while Play mode is running.');
  });

  it('renders live values from snapshot', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        performance: {
          fps: 60,
          frameTimeMs: 8.4,
          logicMs: 3.1,
          renderMs: 5.3,
          drawCalls: 42,
          triangles: 11308,
          geometries: 8,
          textures: 14,
          jsHeapUsedMb: 34.2,
        },
        counters: {
          elapsedMs: 95000,
          frameCount: 312,
          hostKind: 'popout',
        },
        frameImpact: {
          sampledFrameCount: 12,
          windowDurationMs: 8000,
          totalFrameTimeMs: 8000,
          activities: [
            {
              label: 'Physics',
              selfTimeMs: 120,
              totalTimeMs: 180,
              selfPercent: 9,
              totalPercent: 13.5,
              sampleCount: 12,
            },
            {
              label: 'Audio',
              selfTimeMs: 24,
              totalTimeMs: 24,
              selfPercent: 3,
              totalPercent: 3,
              sampleCount: 6,
            },
          ],
        },
        audio: {
          activeInstanceCount: 3,
          files: [
            createAudioFile({
              key: 'res://audio/hitStone.ogg',
              label: 'hitStone.ogg',
              resourcePath: 'res://audio/hitStone.ogg',
              durationSeconds: 2,
              channelCount: 2,
              sampleRate: 48000,
              bitrateKbps: 256,
              activeInstanceCount: 2,
              isActive: true,
              lastPlayedAtMs: 1100,
              currentInstances: [
                createAudioPlayback({
                  id: 'playback-1',
                  label: 'hitStone.ogg',
                  resourcePath: 'res://audio/hitStone.ogg',
                  startedAtMs: 1000,
                  elapsedMs: 450,
                  loop: false,
                  volume: 0.35,
                  playbackRate: 1.05,
                  pan: -0.1,
                  durationSeconds: 2,
                  channelCount: 2,
                  sampleRate: 48000,
                  bitrateKbps: 256,
                }),
                createAudioPlayback({
                  id: 'playback-2',
                  label: 'hitStone.ogg',
                  resourcePath: 'res://audio/hitStone.ogg',
                  startedAtMs: 1100,
                  elapsedMs: 280,
                  loop: false,
                  volume: 0.35,
                  playbackRate: 0.98,
                  pan: 0.12,
                  durationSeconds: 2,
                  channelCount: 2,
                  sampleRate: 48000,
                  bitrateKbps: 256,
                }),
              ],
              lastPlayback: createAudioPlayback({
                id: 'playback-2',
                label: 'hitStone.ogg',
                resourcePath: 'res://audio/hitStone.ogg',
                startedAtMs: 1100,
                elapsedMs: 280,
                loop: false,
                volume: 0.35,
                playbackRate: 0.98,
                pan: 0.12,
                durationSeconds: 2,
                channelCount: 2,
                sampleRate: 48000,
                bitrateKbps: 256,
              }),
            }),
            createAudioFile({
              key: 'res://audio/lootPickup.ogg',
              label: 'lootPickup.ogg',
              resourcePath: 'res://audio/lootPickup.ogg',
              durationSeconds: 1.5,
              channelCount: 2,
              sampleRate: 44100,
              bitrateKbps: 192,
              activeInstanceCount: 1,
              isActive: true,
              lastPlayedAtMs: 900,
              currentInstances: [
                createAudioPlayback({
                  id: 'playback-3',
                  label: 'lootPickup.ogg',
                  resourcePath: 'res://audio/lootPickup.ogg',
                  startedAtMs: 900,
                  elapsedMs: 1200,
                  loop: true,
                  volume: 0.8,
                  playbackRate: 1,
                  pan: null,
                  durationSeconds: 1.5,
                  channelCount: 2,
                  sampleRate: 44100,
                  bitrateKbps: 192,
                }),
              ],
              lastPlayback: createAudioPlayback({
                id: 'playback-3',
                label: 'lootPickup.ogg',
                resourcePath: 'res://audio/lootPickup.ogg',
                startedAtMs: 900,
                elapsedMs: 1200,
                loop: true,
                volume: 0.8,
                playbackRate: 1,
                pan: null,
                durationSeconds: 1.5,
                channelCount: 2,
                sampleRate: 44100,
                bitrateKbps: 192,
              }),
            }),
            createAudioFile({
              key: 'res://audio/breakStone.ogg',
              label: 'breakStone.ogg',
              resourcePath: 'res://audio/breakStone.ogg',
              durationSeconds: 1.4,
              channelCount: 1,
              sampleRate: 44100,
              bitrateKbps: 192,
              activeInstanceCount: 0,
              isActive: false,
              lastPlayedAtMs: 300,
              currentInstances: [],
              lastPlayback: createAudioPlayback({
                id: 'playback-4',
                label: 'breakStone.ogg',
                resourcePath: 'res://audio/breakStone.ogg',
                startedAtMs: 300,
                elapsedMs: 801,
                loop: false,
                volume: 0.23,
                playbackRate: 1.02,
                pan: 0.04,
                durationSeconds: 1.4,
                channelCount: 1,
                sampleRate: 44100,
                bitrateKbps: 192,
              }),
            }),
          ],
        },
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.textContent).toContain('Performance');
    expect(panel.textContent).toContain('60');
    expect(panel.textContent).toContain('8.4 ms');
    expect(panel.textContent).toContain('3.1 ms');
    expect(panel.textContent).toContain('5.3 ms');
    expect(panel.textContent).toContain('11,308');
    expect(panel.textContent).toContain('34.2 MB');
    expect(panel.textContent).toContain('1:35');
    expect(panel.textContent).toContain('popout');
    expect(panel.textContent).toContain('Audio Files');
    expect(panel.textContent).toContain('3 files');
    expect(panel.textContent).toContain('3 active');
    expect(panel.textContent).toContain('2 playing');
    expect(panel.textContent).toContain('hitStone.ogg');
    expect(panel.textContent).toContain('lootPickup.ogg');
    expect(panel.textContent).toContain('breakStone.ogg');
    expect(panel.textContent).toContain('Frame Impact');
    expect(panel.textContent).toContain('8.0 s');
    expect(panel.textContent).toContain('Physics');
    expect(panel.textContent).toContain('13.5%');
    expect(panel.textContent).toContain('180 ms');
    expect(panel.textContent).toContain('Count = frames where the activity appeared.');
    expect(panel.textContent).toContain('6');
    expect(panel.querySelectorAll('.chart-card')).toHaveLength(2);
    expect(panel.querySelectorAll('.audio-file-card')).toHaveLength(3);
    expect(panel.querySelector('.fps-line')).not.toBeNull();
    expect(panel.querySelector('.chart-legend')).not.toBeNull();
    expect(panel.querySelectorAll('.frame-impact-row')).toHaveLength(3);
    const sectionTitles = [...panel.querySelectorAll('.profiler-section-title')].map(node =>
      node.textContent?.trim()
    );
    expect(sectionTitles.at(-1)).toBe('Frame Impact');
  });

  it('renders fallback placeholder for unsupported metrics', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        performance: {
          fps: null,
          frameTimeMs: null,
          logicMs: null,
          renderMs: null,
          drawCalls: null,
          triangles: null,
          geometries: null,
          textures: null,
          jsHeapUsedMb: null,
        },
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const values = [...panel.querySelectorAll('.metric-value')].map(node =>
      node.textContent?.trim()
    );
    expect(values).toContain('—');
  });

  it('renders an empty frame impact state when the runtime does not publish activities', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        frameImpact: {
          activities: [],
          sampledFrameCount: 0,
          windowDurationMs: 0,
          totalFrameTimeMs: 0,
        },
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.textContent).toContain(
      'No frame activity breakdown reported by the active runtime yet.'
    );
  });

  it('renders an empty audio state when the runtime reports no active sounds', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        audio: {
          instances: [],
        },
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.textContent).toContain('No audio files have played in this session yet.');
  });

  it('opens audio details for the selected file tile', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        audio: {
          activeInstanceCount: 1,
          files: [
            createAudioFile({
              key: 'res://audio/breakStone.ogg',
              label: 'breakStone.ogg',
              resourcePath: 'res://audio/breakStone.ogg',
              durationSeconds: 1.4,
              channelCount: 1,
              sampleRate: 44100,
              bitrateKbps: 192,
              activeInstanceCount: 1,
              isActive: true,
              lastPlayedAtMs: 300,
              currentInstances: [
                createAudioPlayback({
                  id: 'playback-4',
                  label: 'breakStone.ogg',
                  resourcePath: 'res://audio/breakStone.ogg',
                  startedAtMs: 300,
                  elapsedMs: 801,
                  loop: false,
                  volume: 0.23,
                  playbackRate: 1.02,
                  pan: 0.04,
                  durationSeconds: 1.4,
                  channelCount: 1,
                  sampleRate: 44100,
                  bitrateKbps: 192,
                }),
              ],
              lastPlayback: createAudioPlayback({
                id: 'playback-4',
                label: 'breakStone.ogg',
                resourcePath: 'res://audio/breakStone.ogg',
                startedAtMs: 300,
                elapsedMs: 801,
                loop: false,
                volume: 0.23,
                playbackRate: 1.02,
                pan: 0.04,
                durationSeconds: 1.4,
                channelCount: 1,
                sampleRate: 44100,
                bitrateKbps: 192,
              }),
            }),
          ],
        },
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const tile = panel.querySelector(
      '[data-audio-key="res://audio/breakStone.ogg"]'
    ) as HTMLButtonElement | null;
    expect(tile).not.toBeNull();

    tile?.click();
    await panel.updateComplete;

    expect(panel.textContent).toContain('Bitrate');
    expect(panel.textContent).toContain('192 kbps');
    expect(panel.textContent).toContain('1.40 s');
    expect(panel.textContent).toContain('Playback Params');
    expect(panel.textContent).toContain('vol 23%');
    expect(panel.textContent).toContain('rate 1.02x');
    expect(panel.textContent).toContain('pan 0.04');
    expect(panel.querySelector('.audio-detail-card')).not.toBeNull();
  });
});

function stubPanelService(panel: ProfilerPanelElement, snapshot: ProfilerSessionSnapshot): void {
  const profilerSessionService: Pick<ProfilerSessionService, 'subscribe'> = {
    subscribe(listener: (value: ProfilerSessionSnapshot) => void) {
      listener(snapshot);
      return () => undefined;
    },
  };

  Object.defineProperty(panel, 'profilerSessionService', {
    value: profilerSessionService,
    configurable: true,
  });
}

function createSnapshot(overrides: Partial<ProfilerSessionSnapshot>): ProfilerSessionSnapshot {
  return {
    status: overrides.status ?? 'running',
    performance: {
      fps: overrides.performance ? (overrides.performance.fps ?? null) : 60,
      frameTimeMs: overrides.performance ? (overrides.performance.frameTimeMs ?? null) : 16.7,
      logicMs: overrides.performance ? (overrides.performance.logicMs ?? null) : 4.1,
      renderMs: overrides.performance ? (overrides.performance.renderMs ?? null) : 5.4,
      drawCalls: overrides.performance ? (overrides.performance.drawCalls ?? null) : 24,
      triangles: overrides.performance ? (overrides.performance.triangles ?? null) : 8000,
      geometries: overrides.performance ? (overrides.performance.geometries ?? null) : 5,
      textures: overrides.performance ? (overrides.performance.textures ?? null) : 9,
      jsHeapUsedMb: overrides.performance ? (overrides.performance.jsHeapUsedMb ?? null) : 12.5,
    },
    counters: {
      elapsedMs: overrides.counters?.elapsedMs ?? 1000,
      frameCount: overrides.counters?.frameCount ?? 60,
      hostKind: overrides.counters?.hostKind ?? 'tab',
    },
    history: overrides.history ?? {
      fps: [58, 60, 59, 61],
      frameTimeMs: [17.2, 16.7, 16.9, 16.3],
      logicMs: [5.8, 6.1, 5.7, 5.5],
      renderMs: [8.4, 8.1, 8.6, 8.2],
    },
    frameImpact: overrides.frameImpact ?? {
      activities: [],
      sampledFrameCount: 0,
      windowDurationMs: 0,
      totalFrameTimeMs: 0,
    },
    audio: {
      files: overrides.audio?.files ?? [],
      activeInstanceCount: overrides.audio?.activeInstanceCount ?? 0,
    },
  };
}

function createAudioFile(
  overrides: Partial<ProfilerSessionSnapshot['audio']['files'][number]> & {
    key: string;
  }
): ProfilerSessionSnapshot['audio']['files'][number] {
  return {
    key: overrides.key,
    label: overrides.label ?? 'Unknown',
    resourcePath: overrides.resourcePath ?? null,
    durationSeconds: overrides.durationSeconds ?? null,
    channelCount: overrides.channelCount ?? null,
    sampleRate: overrides.sampleRate ?? null,
    bitrateKbps: overrides.bitrateKbps ?? null,
    activeInstanceCount: overrides.activeInstanceCount ?? 0,
    isActive: overrides.isActive ?? false,
    lastPlayedAtMs: overrides.lastPlayedAtMs ?? 0,
    currentInstances: overrides.currentInstances ?? [],
    lastPlayback: overrides.lastPlayback ?? null,
  };
}

function createAudioPlayback(
  overrides: Partial<
    ProfilerSessionSnapshot['audio']['files'][number]['currentInstances'][number]
  > & {
    id: string;
  }
): ProfilerSessionSnapshot['audio']['files'][number]['currentInstances'][number] {
  return {
    id: overrides.id,
    label: overrides.label ?? 'Unknown',
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
