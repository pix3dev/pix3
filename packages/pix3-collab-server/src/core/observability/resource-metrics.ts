import os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';

/**
 * Process and host resource sampling for the management dashboard.
 *
 * Two things make this more than `os.freemem()`:
 *
 * - **Both CPU figures are deltas between calls.** A cumulative counter divided by uptime is an
 *   average over the whole run and says nothing about right now. The baseline is taken when this
 *   module is first imported, so the first poll already has a window to divide by.
 * - **`MemAvailable`, not `MemFree`.** `os.freemem()` reports `MemFree`, which looks alarming on
 *   every healthy Linux box because the page cache is doing its job. `/proc/meminfo`'s
 *   `MemAvailable` is the number an operator can act on, and `os.freemem()` is only the fallback.
 *
 * cloud.pix3.dev and rooms.pix3.dev are the same machine today, so the host block reported here is
 * also the fabric's host. The dashboard compares hostnames rather than assuming that.
 */

/** What this Node process itself is consuming. */
export interface ProcessResources {
  readonly pid: number;
  /** CPU use since the previous sample, normalized against the core count — 100 = every core busy. */
  readonly cpuPercent: number | null;
  /** CPU seconds burned since start (user + system). */
  readonly cpuSecondsTotal: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  /** Off-heap memory held by native bindings (better-sqlite3, ws) plus ArrayBuffers. */
  readonly externalBytes: number;
  readonly uptimeSeconds: number;
  readonly node: string;
}

/**
 * The host's load and headroom. Nullable throughout: the good numbers come from `/proc`, and a
 * platform without it answers "unknown" rather than a fabricated zero.
 */
export interface HostResources {
  readonly hostname: string;
  readonly os: string;
  readonly cpuCount: number;
  readonly cpuPercent: number | null;
  readonly load1: number | null;
  readonly load5: number | null;
  readonly load15: number | null;
  readonly memoryTotalBytes: number | null;
  readonly memoryAvailableBytes: number | null;
  readonly diskTotalBytes: number | null;
  readonly diskFreeBytes: number | null;
  readonly uptimeSeconds: number | null;
}

/** One reading: this process, and the host it shares with nginx and the Room Fabric. */
export interface ResourceSample {
  readonly process: ProcessResources;
  readonly host: HostResources;
}

/** Host CPU accounting, as jiffies since boot. */
export interface CpuTicks {
  readonly busy: number;
  readonly total: number;
}

const PROC_STAT_PATH = '/proc/stat';
const PROC_MEMINFO_PATH = '/proc/meminfo';

/**
 * Shortest window a fresh percentage is computed over. Two polls in the same instant would divide by
 * a near-zero elapsed time and produce noise; below this the previous answer is repeated.
 */
const MINIMUM_WINDOW_MS = 200;

interface Baseline {
  sampledAt: number;
  processCpuMicros: number;
  hostTicks: CpuTicks | null;
  processPercent: number | null;
  hostPercent: number | null;
}

function totalCpuMicros(usage: NodeJS.CpuUsage): number {
  return usage.user + usage.system;
}

const baseline: Baseline = {
  sampledAt: Date.now(),
  processCpuMicros: totalCpuMicros(process.cpuUsage()),
  hostTicks: null,
  processPercent: null,
  hostPercent: null,
};

/**
 * Parses the aggregate `cpu` line of `/proc/stat` into busy and total jiffies.
 *
 * Busy excludes `idle` and `iowait`: a core waiting on disk is not doing work, and counting it as
 * busy makes a quiet server look loaded. `guest`/`guest_nice` are already inside `user`/`nice`.
 */
export function parseCpuTicks(content: string | null): CpuTicks | null {
  if (!content) {
    return null;
  }

  const [firstLine = ''] = content.split('\n', 1);
  const parts = firstLine.trim().split(/\s+/);

  // 'cpu' is the all-core aggregate; 'cpu0' is one core and must not be mistaken for it.
  if (parts.length < 5 || parts[0] !== 'cpu') {
    return null;
  }

  let total = 0;
  let idle = 0;
  const fields = Math.min(parts.length - 1, 8);
  for (let index = 0; index < fields; index += 1) {
    const value = Number.parseInt(parts[index + 1], 10);
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }

    total += value;
    // Field order: user nice system idle iowait irq softirq steal.
    if (index === 3 || index === 4) {
      idle += value;
    }
  }

  return total > 0 ? { busy: total - idle, total } : null;
}

/** Parses `MemTotal` / `MemAvailable` out of `/proc/meminfo`, in bytes. */
export function parseMemoryInfo(content: string | null): {
  totalBytes: number | null;
  availableBytes: number | null;
} {
  const result: { totalBytes: number | null; availableBytes: number | null } = {
    totalBytes: null,
    availableBytes: null,
  };
  if (!content) {
    return result;
  }

  for (const line of content.split('\n')) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)(?:\s+(\w+))?/.exec(line);
    if (!match) {
      continue;
    }

    const amount = Number.parseInt(match[2], 10);
    if (!Number.isFinite(amount)) {
      continue;
    }

    // The unit is always kB on Linux; parse it anyway rather than hardcoding the multiplier.
    const bytes = match[3]?.toLowerCase() === 'kb' ? amount * 1024 : amount;
    if (match[1] === 'MemTotal') {
      result.totalBytes = bytes;
    } else {
      result.availableBytes = bytes;
    }
  }

  return result;
}

/** Busy share of a `/proc/stat` jiffy delta, as a percentage. */
export function computeCpuPercent(previous: CpuTicks, current: CpuTicks): number | null {
  const totalDelta = current.total - previous.total;
  const busyDelta = current.busy - previous.busy;
  if (totalDelta <= 0 || busyDelta < 0) {
    return null;
  }

  return clampPercent((busyDelta / totalDelta) * 100);
}

/**
 * Turns a CPU-time delta into a percentage of the host's total capacity over the same wall-clock
 * window. 100 means every core saturated, not one core.
 */
export function computeProcessCpuPercent(
  cpuMicrosDelta: number,
  elapsedMs: number,
  cpuCount: number
): number | null {
  if (elapsedMs <= 0 || cpuCount <= 0) {
    return null;
  }

  return clampPercent((cpuMicrosDelta / (elapsedMs * 1000 * cpuCount)) * 100);
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0) {
    return 0;
  }

  return Math.round(Math.min(percent, 100) * 100) / 100;
}

async function readProcFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // Not Linux, or a hardened host: "unknown" is the honest answer, not an error.
    return null;
  }
}

async function readDisk(
  path: string
): Promise<{ totalBytes: number | null; freeBytes: number | null }> {
  try {
    const stats = await statfs(path);
    const blockSize = Number(stats.bsize);
    return {
      totalBytes: blockSize * Number(stats.blocks),
      // bavail, not bfree: the reserved root blocks are not space this service can use.
      freeBytes: blockSize * Number(stats.bavail),
    };
  } catch {
    return { totalBytes: null, freeBytes: null };
  }
}

/** Takes a reading and re-bases the CPU window on it. */
export async function sampleResources(diskPath: string = process.cwd()): Promise<ResourceSample> {
  const now = Date.now();
  const cpuMicros = totalCpuMicros(process.cpuUsage());
  const [statContent, memInfoContent, disk] = await Promise.all([
    readProcFile(PROC_STAT_PATH),
    readProcFile(PROC_MEMINFO_PATH),
    readDisk(diskPath),
  ]);
  const hostTicks = parseCpuTicks(statContent);

  const elapsedMs = now - baseline.sampledAt;
  let processPercent = baseline.processPercent;
  let hostPercent = baseline.hostPercent;

  if (elapsedMs >= MINIMUM_WINDOW_MS) {
    processPercent = computeProcessCpuPercent(
      cpuMicros - baseline.processCpuMicros,
      elapsedMs,
      os.cpus().length
    );
    hostPercent =
      hostTicks && baseline.hostTicks ? computeCpuPercent(baseline.hostTicks, hostTicks) : null;

    baseline.sampledAt = now;
    baseline.processCpuMicros = cpuMicros;
    if (hostTicks) {
      baseline.hostTicks = hostTicks;
    }
    baseline.processPercent = processPercent;
    baseline.hostPercent = hostPercent;
  } else if (!baseline.hostTicks && hostTicks) {
    // First call inside the minimum window still deserves a baseline for the next one.
    baseline.hostTicks = hostTicks;
  }

  const memory = process.memoryUsage();
  const { totalBytes, availableBytes } = parseMemoryInfo(memInfoContent);
  const [load1, load5, load15] = os.loadavg();

  return {
    process: {
      pid: process.pid,
      cpuPercent: processPercent,
      cpuSecondsTotal: Math.round((cpuMicros / 1_000_000) * 1000) / 1000,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      uptimeSeconds: Math.round(process.uptime() * 1000) / 1000,
      node: process.version,
    },
    host: {
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      cpuCount: os.cpus().length,
      cpuPercent: hostPercent,
      load1: load1 ?? null,
      load5: load5 ?? null,
      load15: load15 ?? null,
      memoryTotalBytes: totalBytes ?? os.totalmem(),
      // os.freemem() is MemFree, which understates availability; it is the fallback, not the source.
      memoryAvailableBytes: availableBytes ?? os.freemem(),
      diskTotalBytes: disk.totalBytes,
      diskFreeBytes: disk.freeBytes,
      uptimeSeconds: Math.round(os.uptime()),
    },
  };
}
