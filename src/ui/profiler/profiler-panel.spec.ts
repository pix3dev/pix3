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
    expect(panel.querySelectorAll('.chart-card')).toHaveLength(2);
    expect(panel.querySelector('.fps-line')).not.toBeNull();
    expect(panel.querySelector('.chart-legend')).not.toBeNull();
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
  };
}
