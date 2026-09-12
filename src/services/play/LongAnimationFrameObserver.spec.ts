import { afterEach, describe, expect, it, vi } from 'vitest';

import { LongAnimationFrameObserver } from '@/services/play/LongAnimationFrameObserver';

interface ObserverHarness {
  emit(entries: readonly unknown[]): void;
  observeCalls: number;
  disconnectCalls: number;
}

/**
 * Install a fake `PerformanceObserver` that reports `long-animation-frame`
 * support and hands the test a way to push entries at the observer.
 */
function stubPerformanceObserver(supportedTypes: readonly string[]): ObserverHarness {
  const harness: ObserverHarness = {
    emit: () => undefined,
    observeCalls: 0,
    disconnectCalls: 0,
  };

  class FakePerformanceObserver {
    static supportedEntryTypes: readonly string[] = supportedTypes;

    constructor(private readonly callback: (list: { getEntries: () => unknown[] }) => void) {
      harness.emit = entries => {
        this.callback({ getEntries: () => [...entries] });
      };
    }

    observe(): void {
      harness.observeCalls += 1;
    }

    disconnect(): void {
      harness.disconnectCalls += 1;
    }
  }

  vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
  return harness;
}

describe('LongAnimationFrameObserver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('degrades silently when the browser does not report long-animation-frame', () => {
    const harness = stubPerformanceObserver(['longtask']);
    const observer = new LongAnimationFrameObserver();

    observer.start();

    expect(observer.getStats().supported).toBe(false);
    // Nothing is observed, so the panel says "unsupported" instead of showing a
    // plausible-looking zero count that nobody could distinguish from "clean".
    expect(harness.observeCalls).toBe(0);
    observer.stop();
  });

  it('attributes the longest script of a frame by basename and function name', () => {
    const harness = stubPerformanceObserver(['long-animation-frame']);
    const observer = new LongAnimationFrameObserver();
    observer.start();

    harness.emit([
      {
        duration: 82,
        blockingDuration: 32,
        scripts: [
          { duration: 7, sourceURL: 'https://host/assets/a.js', sourceFunctionName: 'small' },
          {
            duration: 61,
            sourceURL: 'https://host/assets/EnemySpawner.js?v=3',
            sourceFunctionName: 'onUpdate',
          },
        ],
      },
    ]);

    const stats = observer.getStats();
    expect(stats.supported).toBe(true);
    expect(stats.count).toBe(1);
    expect(stats.worstDurationMs).toBe(82);
    expect(stats.worst[0]?.scriptLabel).toBe('EnemySpawner.js · onUpdate');
    expect(stats.worst[0]?.scriptDurationMs).toBe(61);
    expect(stats.worst[0]?.blockingDurationMs).toBe(32);
  });

  /**
   * The distinction the whole feature exists for: LoAF only attributes callbacks
   * over ~5 ms, so an empty `scripts` array on a long frame is evidence that the
   * time was NOT inside one long callback — not missing data.
   */
  it('reports a null script label when the browser attributed no long script', () => {
    const harness = stubPerformanceObserver(['long-animation-frame']);
    const observer = new LongAnimationFrameObserver();
    observer.start();

    harness.emit([{ duration: 74, blockingDuration: 24, scripts: [] }]);

    const stats = observer.getStats();
    expect(stats.count).toBe(1);
    expect(stats.worst[0]?.scriptLabel).toBeNull();
    expect(stats.worst[0]?.scriptDurationMs).toBeNull();
    expect(stats.worst[0]?.durationMs).toBe(74);
  });

  it('retains only the worst few frames however long the session runs', () => {
    const harness = stubPerformanceObserver(['long-animation-frame']);
    const observer = new LongAnimationFrameObserver();
    observer.start();

    for (let index = 1; index <= 40; index += 1) {
      harness.emit([{ duration: 50 + index, scripts: [] }]);
    }

    const stats = observer.getStats();
    expect(stats.count).toBe(40);
    expect(stats.worstDurationMs).toBe(90);
    expect(stats.worst).toHaveLength(4);
    expect(stats.worst.map(record => record.durationMs)).toEqual([90, 89, 88, 87]);
  });

  it('clears its counters and disconnects on stop', () => {
    const harness = stubPerformanceObserver(['long-animation-frame']);
    const observer = new LongAnimationFrameObserver();
    observer.start();
    harness.emit([{ duration: 120, scripts: [] }]);

    observer.stop();

    expect(harness.disconnectCalls).toBe(1);
    expect(observer.getStats().count).toBe(0);
    expect(observer.getStats().worstDurationMs).toBeNull();
  });

  it('ignores entries with no usable duration', () => {
    const harness = stubPerformanceObserver(['long-animation-frame']);
    const observer = new LongAnimationFrameObserver();
    observer.start();

    harness.emit([{ duration: 0 }, { duration: Number.NaN }, {}]);

    expect(observer.getStats().count).toBe(0);
  });
});
