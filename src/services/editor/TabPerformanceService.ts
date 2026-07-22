import { inject, injectable } from '@/fw/di';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';

/**
 * A snapshot of how hard the editor tab is working, surfaced in the status bar.
 */
export interface TabPerformanceSample {
  /**
   * Main-thread CPU load, 0..1, approximated from event-loop lag (how far the
   * fixed-interval probe slips when the thread is busy). A coarse but honest
   * whole-tab signal — it captures script/Lit/Valtio work, not just rendering.
   */
  readonly cpuLoad: number;
  /** Viewport GPU frame time (ms) from a WebGL2 timer query; null if unsupported. */
  readonly gpuMs: number | null;
  /** Viewport render frame time (ms, CPU-side) — the fallback when `gpuMs` is null. */
  readonly renderMs: number;
}

/**
 * Samples a lightweight CPU/GPU load estimate for the whole editor tab and
 * pushes it to subscribers (currently the status bar).
 *
 * CPU load comes from event-loop lag: a fixed-interval timer that slips late
 * whenever the main thread is busy. GPU/render cost is pulled from
 * {@link ViewportRendererService} (real GPU timer query when the backend supports
 * it, otherwise the render body's wall time).
 *
 * The probe only runs while something is subscribed, and browsers throttle the
 * timer in background tabs — so an idle/backgrounded editor stays near-zero cost,
 * in line with the on-demand rendering philosophy.
 */
@injectable()
export class TabPerformanceService {
  @inject(ViewportRendererService)
  private readonly viewport!: ViewportRendererService;

  /** Probe cadence: also the status-bar refresh rate (twice a second). */
  private static readonly PROBE_MS = 500;
  /** EMA weight for the newest CPU-load reading, to keep the number from jittering. */
  private static readonly CPU_SMOOTHING = 0.4;

  private timer: number | null = null;
  private expectedAt = 0;
  private cpuLoadEma = 0;
  private lastSample: TabPerformanceSample = { cpuLoad: 0, gpuMs: null, renderMs: 0 };
  private readonly listeners = new Set<(sample: TabPerformanceSample) => void>();

  subscribe(listener: (sample: TabPerformanceSample) => void): () => void {
    this.listeners.add(listener);
    listener(this.lastSample);
    this.ensureRunning();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  }

  getLastSample(): TabPerformanceSample {
    return this.lastSample;
  }

  private ensureRunning(): void {
    if (this.timer !== null) return;
    this.expectedAt = performance.now() + TabPerformanceService.PROBE_MS;
    this.timer = window.setInterval(() => this.tick(), TabPerformanceService.PROBE_MS);
  }

  private stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const now = performance.now();
    // How much later than scheduled the probe fired = time the main thread was
    // blocked and couldn't service the timer. Normalise against the interval.
    const lag = Math.max(0, now - this.expectedAt);
    this.expectedAt = now + TabPerformanceService.PROBE_MS;
    const instantLoad = Math.min(1, lag / TabPerformanceService.PROBE_MS);
    this.cpuLoadEma =
      this.cpuLoadEma * (1 - TabPerformanceService.CPU_SMOOTHING) +
      instantLoad * TabPerformanceService.CPU_SMOOTHING;

    const viewportPerf = this.viewport.getViewportPerfSample();
    this.lastSample = {
      cpuLoad: this.cpuLoadEma,
      gpuMs: viewportPerf.gpuMs,
      renderMs: viewportPerf.cpuMs,
    };

    for (const listener of this.listeners) {
      listener(this.lastSample);
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }
}
