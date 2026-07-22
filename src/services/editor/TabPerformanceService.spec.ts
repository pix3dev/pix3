import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServiceContainer } from '@/fw/di';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { TabPerformanceService } from '@/services/editor/TabPerformanceService';

// Mutable stand-in for the viewport's per-frame cost, so tests can drive what
// the perf service reads on each probe tick.
let stubPerf: { cpuMs: number; gpuMs: number | null } = { cpuMs: 0, gpuMs: null };

class ViewportStub {
  getViewportPerfSample() {
    return stubPerf;
  }
}

function makeService(): TabPerformanceService {
  const container = ServiceContainer.getInstance();
  container.addService(
    container.getOrCreateToken(ViewportRendererService),
    ViewportStub,
    'singleton'
  );
  // Resolve a fresh instance via a throwaway token so each test starts clean.
  return new TabPerformanceService();
}

describe('TabPerformanceService', () => {
  beforeEach(() => {
    stubPerf = { cpuMs: 0, gpuMs: null };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits an initial zero sample synchronously on subscribe', () => {
    const service = makeService();
    const samples: Array<{ cpuLoad: number; gpuMs: number | null; renderMs: number }> = [];

    service.subscribe(sample => samples.push(sample));

    expect(samples).toHaveLength(1);
    expect(samples[0]).toEqual({ cpuLoad: 0, gpuMs: null, renderMs: 0 });
  });

  it('pushes viewport GPU/render cost to subscribers on each probe tick', () => {
    const service = makeService();
    stubPerf = { cpuMs: 3.2, gpuMs: 1.5 };
    const samples: Array<{ cpuLoad: number; gpuMs: number | null; renderMs: number }> = [];

    service.subscribe(sample => samples.push(sample));
    vi.advanceTimersByTime(500);

    const latest = samples[samples.length - 1];
    expect(latest.gpuMs).toBe(1.5);
    expect(latest.renderMs).toBe(3.2);
  });

  it('stops probing once the last subscriber unsubscribes', () => {
    const service = makeService();
    const samples: unknown[] = [];

    const unsubscribe = service.subscribe(sample => samples.push(sample));
    unsubscribe();
    const countAfterUnsub = samples.length;

    vi.advanceTimersByTime(2000);

    expect(samples.length).toBe(countAfterUnsub);
  });

  it('reports null GPU time as-is when timer queries are unsupported', () => {
    const service = makeService();
    stubPerf = { cpuMs: 4.1, gpuMs: null };
    let latest: { cpuLoad: number; gpuMs: number | null; renderMs: number } | undefined;

    service.subscribe(sample => {
      latest = sample;
    });
    vi.advanceTimersByTime(500);

    expect(latest?.gpuMs).toBeNull();
    expect(latest?.renderMs).toBe(4.1);
  });
});
