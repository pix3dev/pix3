// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  computeCpuPercent,
  computeProcessCpuPercent,
  parseCpuTicks,
  parseMemoryInfo,
  sampleResources,
} from './resource-metrics.js';

/**
 * The `/proc` parsers and the CPU arithmetic behind the management dashboard.
 *
 * They are tested against literal kernel text rather than the live files: those differ per host and
 * are absent on Windows, so a test that read the real `/proc` would prove nothing locally and could
 * not cover the cases that matter (a `cpu0`-first file, a counter that went backwards, `MemFree`
 * present but `MemAvailable` missing).
 */
describe('parseCpuTicks', () => {
  it('reads the aggregate line and treats idle+iowait as not busy', () => {
    const procStat = [
      'cpu  100 20 30 500 40 5 5 0 0 0',
      'cpu0 50 10 15 250 20 2 3 0 0 0',
      'intr 12345',
    ].join('\n');

    // total = 100+20+30+500+40+5+5+0 = 700; idle+iowait = 540; busy = 160.
    expect(parseCpuTicks(procStat)).toEqual({ busy: 160, total: 700 });
  });

  it('refuses a file whose first line is a single core rather than the aggregate', () => {
    expect(parseCpuTicks('cpu0 50 10 15 250 20\ncpu  1 2 3 4 5')).toBeNull();
    expect(parseCpuTicks('cpu  1 2')).toBeNull();
    expect(parseCpuTicks(null)).toBeNull();
  });
});

describe('computeCpuPercent', () => {
  it('is the busy share of the window', () => {
    expect(computeCpuPercent({ busy: 100, total: 400 }, { busy: 150, total: 600 })).toBe(25);
    expect(computeCpuPercent({ busy: 100, total: 400 }, { busy: 100, total: 600 })).toBe(0);
  });

  it('has no answer for an empty window or counters that went backwards', () => {
    expect(computeCpuPercent({ busy: 100, total: 400 }, { busy: 100, total: 400 })).toBeNull();
    expect(computeCpuPercent({ busy: 100, total: 400 }, { busy: 50, total: 600 })).toBeNull();
  });
});

describe('computeProcessCpuPercent', () => {
  it('normalizes against the core count', () => {
    // Ten CPU-seconds over ten wall-seconds is one saturated core: 100% on the single-core
    // production host, 25% on a four-core box.
    expect(computeProcessCpuPercent(10_000_000, 10_000, 1)).toBe(100);
    expect(computeProcessCpuPercent(10_000_000, 10_000, 4)).toBe(25);
  });

  it('clamps sampling skew instead of reporting more than a machine has', () => {
    expect(computeProcessCpuPercent(14_000_000, 10_000, 1)).toBe(100);
    expect(computeProcessCpuPercent(-1_000, 10_000, 1)).toBe(0);
  });

  it('returns null when the window or the core count is unusable', () => {
    expect(computeProcessCpuPercent(1_000, 0, 1)).toBeNull();
    expect(computeProcessCpuPercent(1_000, 10_000, 0)).toBeNull();
  });
});

describe('parseMemoryInfo', () => {
  it('reports MemTotal and MemAvailable in bytes', () => {
    const procMemInfo = [
      'MemTotal:        4030524 kB',
      'MemFree:          204848 kB',
      'MemAvailable:    1892160 kB',
      'Buffers:           50000 kB',
    ].join('\n');

    // MemAvailable, not MemFree: on a healthy Linux box MemFree is small because the page cache is used.
    expect(parseMemoryInfo(procMemInfo)).toEqual({
      totalBytes: 4030524 * 1024,
      availableBytes: 1892160 * 1024,
    });
  });

  it('survives a file that carries only one of the two keys', () => {
    expect(parseMemoryInfo('MemTotal: 1024 kB\n')).toEqual({
      totalBytes: 1024 * 1024,
      availableBytes: null,
    });
    expect(parseMemoryInfo('Slab: 1024 kB\n')).toEqual({ totalBytes: null, availableBytes: null });
    expect(parseMemoryInfo(null)).toEqual({ totalBytes: null, availableBytes: null });
  });
});

describe('sampleResources', () => {
  it('reports this process and falls back to os values off Linux', async () => {
    const sample = await sampleResources();

    expect(sample.process.pid).toBe(process.pid);
    expect(sample.process.rssBytes).toBeGreaterThan(0);
    expect(sample.process.node).toBe(process.version);
    expect(sample.host.cpuCount).toBeGreaterThan(0);
    // Total memory always resolves: /proc/meminfo on Linux, os.totalmem() everywhere else.
    expect(sample.host.memoryTotalBytes).toBeGreaterThan(0);
  });
});
