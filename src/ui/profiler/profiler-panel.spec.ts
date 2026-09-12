import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ProfilerFrameStabilitySnapshot,
  ProfilerOverheadComparisonSnapshot,
  ProfilerSessionService,
  ProfilerSessionSnapshot,
} from '@/services/play/ProfilerSessionService';

/**
 * The panel only needs the service's TYPES, but it also imports the module's
 * `createEmptyOverheadComparison` helper for its pre-subscription default — so the
 * mock has to provide that, and it has to stay consistent with the real one.
 */
vi.mock('@/services/play/ProfilerSessionService', () => ({
  ProfilerSessionService: class ProfilerSessionService {},
  PROFILER_AB_MIN_ARM_FRAMES: 600,
  createEmptyOverheadComparison: () => createOverhead(),
}));
vi.mock('@/services/play/RemotePreviewTelemetryService', () => ({
  RemotePreviewTelemetryService: class RemotePreviewTelemetryService {},
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
          unaccountedMs: 8.2,
          rafLatenessMs: 0.6,
          shaderPrograms: 12,
          shaderProgramsAdded: 0,
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
          unaccountedMs: null,
          rafLatenessMs: null,
          shaderPrograms: null,
          shaderProgramsAdded: null,
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
          files: [],
          activeInstanceCount: 0,
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

  /**
   * The readout that cost a real investigation hours was `FPS 60 / Frame 16.7 ms`
   * beside `logic + render`. These assertions pin the three things that make it
   * honest: a third chart band, an Unaccounted / Frame delivery row pair, and a
   * subtitle that no longer claims logic and render add up to the frame.
   */
  it('renders the unaccounted band, frame-delivery row and an honest breakdown subtitle', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        performance: {
          fps: 60,
          frameTimeMs: 16.7,
          logicMs: 0.3,
          renderMs: 1.1,
          unaccountedMs: 58.6,
          rafLatenessMs: 42.5,
          drawCalls: 24,
          triangles: 8000,
          geometries: 5,
          textures: 9,
          shaderPrograms: 14,
          shaderProgramsAdded: 3,
          jsHeapUsedMb: 12.5,
        },
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.textContent).toContain('Unaccounted');
    expect(panel.textContent).toContain('58.6 ms');
    expect(panel.textContent).toContain('Frame delivery');
    expect(panel.textContent).toContain('42.5 ms');
    expect(panel.textContent).toContain('where the frame went');
    expect(panel.textContent).not.toContain('logic + render');
    expect(panel.querySelector('.chart-bar-unaccounted')).not.toBeNull();
    expect(panel.querySelector('.chart-legend-swatch-unaccounted')).not.toBeNull();
    // Programs linked mid-play are flagged, since each link stalls the main thread.
    expect(panel.textContent).toContain('(+3 this session)');
    expect(panel.querySelector('.metric-value-warn')).not.toBeNull();
  });

  it('renders session percentiles and long-frame counters', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        frameStability: {
          sampleCount: 100,
          p50Ms: 17,
          p95Ms: 23,
          p99Ms: 56,
          over20Count: 7,
          over33Count: 4,
          over50Count: 2,
          worstMs: 90,
          over20Percent: 7,
        },
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.textContent).toContain('Frame Stability');
    expect(panel.textContent).toContain('p95');
    expect(panel.textContent).toContain('23.0 ms');
    expect(panel.textContent).toContain('56.0 ms');
    expect(panel.textContent).toContain('Worst frame');
    expect(panel.textContent).toContain('90.0 ms');
    // "60 fps with 7 % janky frames" must not be able to look like a clean 60.
    expect(panel.textContent).toContain('7 (7.0%)');
  });

  it('labels an unattributed long frame explicitly instead of showing an empty script list', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        longFrames: {
          supported: true,
          count: 2,
          worstDurationMs: 91,
          worst: [
            { durationMs: 91, blockingDurationMs: 41, scriptLabel: null, scriptDurationMs: null },
            {
              durationMs: 66,
              blockingDurationMs: 16,
              scriptLabel: 'EnemySpawner.js · onUpdate',
              scriptDurationMs: 58,
            },
          ],
        },
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.textContent).toContain('Long Animation Frames');
    expect(panel.textContent).toContain('no long script — delivered late / off-thread');
    expect(panel.textContent).toContain('EnemySpawner.js · onUpdate');
    expect(panel.querySelector('.long-frame-attribution-none')).not.toBeNull();
  });

  it('offers a pause control for a running local session and toggles the service', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    const { setPaused } = stubPanelService(panel, createSnapshot({ status: 'running' }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    const toggle = panel.querySelector<HTMLButtonElement>('[data-testid="profiler-pause-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain('Pause profiler');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    // Vector icon, never a ⏸ glyph — see AGENTS.md rule 5a.
    expect(toggle?.querySelector('svg')).not.toBeNull();

    toggle?.click();
    expect(setPaused).toHaveBeenCalledWith(true);
  });

  it('hides the pause control while no session is running', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(panel, createSnapshot({ status: 'idle' }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.querySelector('[data-testid="profiler-pause-toggle"]')).toBeNull();
  });

  it('replaces live rows and charts with an explicit paused state', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(panel, createSnapshot({ status: 'running', paused: true }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.textContent).toContain('Profiler paused');
    // The point of the paused arm: no charts to rebuild, no live rows to diff.
    expect(panel.querySelector('.chart-card')).toBeNull();
    expect(panel.querySelector('.profiler-impact-section')).toBeNull();
    expect(panel.querySelector('.profiler-audio-section')).toBeNull();
    // And the reader is told exactly which numbers survive the pause, so a frozen
    // value can never be mistaken for a live one.
    expect(panel.textContent).toContain('Still collected');
    expect(panel.textContent).toContain('long animation frames');
    expect(panel.textContent).toContain('Not collected');

    const toggle = panel.querySelector<HTMLButtonElement>('[data-testid="profiler-pause-toggle"]');
    expect(toggle?.textContent).toContain('Resume profiler');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
  });

  it('withholds an A/B verdict below the minimum arm size but still shows both counts', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        overhead: createOverhead({
          live: createStability({ sampleCount: 2140, p95Ms: 21.4, over20Percent: 5.2 }),
          paused: createStability({ sampleCount: 180, p95Ms: 17.1, over20Percent: 1.1 }),
          comparable: false,
        }),
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const verdict = panel.querySelector('.overhead-verdict');
    expect(verdict?.classList.contains('overhead-verdict-pending')).toBe(true);
    expect(verdict?.textContent).toContain('Not enough frames yet');
    // No delta may appear anywhere — an underpowered comparison is what produced
    // the wrong "40 % of the jank is this panel" conclusion in the first place.
    expect(panel.textContent).not.toContain('p95 is');
    // Counts stay visible so the reader can weigh the numbers themselves.
    expect(panel.textContent).toContain('2,140 frames');
    expect(panel.textContent).toContain('180 frames');
  });

  it('reports a verdict once both arms are sampled', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        overhead: createOverhead({
          live: createStability({ sampleCount: 2140, p95Ms: 21.4, over20Percent: 5.2 }),
          paused: createStability({ sampleCount: 1860, p95Ms: 17.1, over20Percent: 1.1 }),
          comparable: true,
          p95DeltaMs: 4.3,
          over20PercentDelta: 4.1,
        }),
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const verdict = panel.querySelector('.overhead-verdict');
    expect(verdict?.classList.contains('overhead-verdict-cost')).toBe(true);
    expect(verdict?.textContent).toContain('+4.3 ms');
    // A difference of percentages is percentage POINTS, not a percentage.
    expect(verdict?.textContent).toContain('+4.1 pp');
    expect(panel.textContent).toContain('21.4 ms');
    expect(panel.textContent).toContain('1,860 frames');
  });

  it('clears the panel when the two arms agree within the histogram bucket width', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(
      panel,
      createSnapshot({
        status: 'running',
        overhead: createOverhead({
          live: createStability({ sampleCount: 1200, p95Ms: 17.3, over20Percent: 1.4 }),
          paused: createStability({ sampleCount: 1200, p95Ms: 17.0, over20Percent: 1.2 }),
          comparable: true,
          p95DeltaMs: 0.3,
          over20PercentDelta: 0.2,
        }),
      })
    );

    document.body.appendChild(panel);
    await panel.updateComplete;

    const verdict = panel.querySelector('.overhead-verdict');
    expect(verdict?.classList.contains('overhead-verdict-clear')).toBe(true);
    expect(verdict?.textContent).toContain('not what you are chasing');
  });

  it('says so when the browser cannot report long animation frames', async () => {
    const panel = document.createElement('pix3-profiler-panel') as ProfilerPanelElement;
    stubPanelService(panel, createSnapshot({ status: 'running' }));

    document.body.appendChild(panel);
    await panel.updateComplete;

    expect(panel.textContent).toContain(
      'This browser does not report long-animation-frame entries'
    );
  });
});

function stubPanelService(
  panel: ProfilerPanelElement,
  snapshot: ProfilerSessionSnapshot
): { setPaused: ReturnType<typeof vi.fn> } {
  const setPaused = vi.fn();
  const profilerSessionService: Pick<ProfilerSessionService, 'subscribe' | 'setPaused'> = {
    subscribe(listener: (value: ProfilerSessionSnapshot) => void) {
      listener(snapshot);
      return () => undefined;
    },
    setPaused,
  };

  Object.defineProperty(panel, 'profilerSessionService', {
    value: profilerSessionService,
    configurable: true,
  });

  Object.defineProperty(panel, 'remotePreviewTelemetryService', {
    value: {
      subscribe(listener: (players: readonly unknown[]) => void) {
        listener([]);
        return () => undefined;
      },
      getProfilerSnapshot: () => null,
    },
    configurable: true,
  });

  return { setPaused };
}

function createStability(
  overrides: Partial<ProfilerFrameStabilitySnapshot> = {}
): ProfilerFrameStabilitySnapshot {
  return {
    sampleCount: overrides.sampleCount ?? 0,
    p50Ms: overrides.p50Ms ?? null,
    p95Ms: overrides.p95Ms ?? null,
    p99Ms: overrides.p99Ms ?? null,
    over20Count: overrides.over20Count ?? 0,
    over33Count: overrides.over33Count ?? 0,
    over50Count: overrides.over50Count ?? 0,
    worstMs: overrides.worstMs ?? null,
    over20Percent: overrides.over20Percent ?? null,
  };
}

function createOverhead(
  overrides: Partial<ProfilerOverheadComparisonSnapshot> = {}
): ProfilerOverheadComparisonSnapshot {
  return {
    live: overrides.live ?? createStability(),
    paused: overrides.paused ?? createStability(),
    minimumArmFrames: overrides.minimumArmFrames ?? 600,
    comparable: overrides.comparable ?? false,
    p95DeltaMs: overrides.p95DeltaMs ?? null,
    over20PercentDelta: overrides.over20PercentDelta ?? null,
  };
}

function createSnapshot(overrides: Partial<ProfilerSessionSnapshot>): ProfilerSessionSnapshot {
  return {
    status: overrides.status ?? 'running',
    paused: overrides.paused ?? false,
    overhead: overrides.overhead ?? createOverhead(),
    performance: {
      fps: overrides.performance ? (overrides.performance.fps ?? null) : 60,
      frameTimeMs: overrides.performance ? (overrides.performance.frameTimeMs ?? null) : 16.7,
      logicMs: overrides.performance ? (overrides.performance.logicMs ?? null) : 4.1,
      renderMs: overrides.performance ? (overrides.performance.renderMs ?? null) : 5.4,
      drawCalls: overrides.performance ? (overrides.performance.drawCalls ?? null) : 24,
      triangles: overrides.performance ? (overrides.performance.triangles ?? null) : 8000,
      geometries: overrides.performance ? (overrides.performance.geometries ?? null) : 5,
      textures: overrides.performance ? (overrides.performance.textures ?? null) : 9,
      unaccountedMs: overrides.performance ? (overrides.performance.unaccountedMs ?? null) : 7.2,
      rafLatenessMs: overrides.performance ? (overrides.performance.rafLatenessMs ?? null) : 1.4,
      shaderPrograms: overrides.performance ? (overrides.performance.shaderPrograms ?? null) : 11,
      shaderProgramsAdded: overrides.performance
        ? (overrides.performance.shaderProgramsAdded ?? null)
        : 0,
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
      unaccountedMs: [3.0, 2.5, 2.6, 2.6],
    },
    frameStability: overrides.frameStability ?? {
      sampleCount: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      over20Count: 0,
      over33Count: 0,
      over50Count: 0,
      worstMs: null,
      over20Percent: null,
    },
    longFrames: overrides.longFrames ?? {
      supported: false,
      count: 0,
      worstDurationMs: null,
      worst: [],
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
