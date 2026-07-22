import * as THREE from 'three';

/**
 * Minimal shape of the `EXT_disjoint_timer_query_webgl2` extension (not in the
 * TS DOM lib). Used to measure real GPU frame time for the status-bar load
 * readout; absent on backends that don't expose it (then GPU timing is null).
 */
interface DisjointTimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** Per-frame viewport cost sample surfaced to the tab-performance readout. */
export interface ViewportPerfSample {
  /** Wall-clock time spent in the render body (CPU-side), in ms. */
  readonly cpuMs: number;
  /** GPU frame time from a WebGL2 timer query, in ms; null when unsupported. */
  readonly gpuMs: number | null;
}

/**
 * Owns the viewport's GPU frame-timing concern, extracted from
 * `ViewportRendererService`. Measures real GPU frame time via a WebGL2
 * `EXT_disjoint_timer_query_webgl2` timer query and tracks the CPU-side render
 * cost, so the status-bar tab-load readout can display both.
 *
 * The renderer is created lazily and can be re-created (viewport re-init), so
 * this class takes a getter and always reads the *current* renderer rather than
 * capturing a possibly-stale reference at construction time.
 */
export class ViewportGpuTimer {
  // CPU-side wall time of the last render body, and the last resolved GPU frame
  // time (via a WebGL2 timer query). `timer` is undefined until first probed;
  // `null` ext means the backend doesn't support timer queries.
  private lastRenderCpuMs = 0;
  private lastRenderGpuMs: number | null = null;
  private timer:
    | { ext: DisjointTimerQueryExt | null; query: WebGLQuery | null; inFlight: boolean }
    | undefined;

  constructor(private readonly getRenderer: () => THREE.WebGLRenderer | undefined) {}

  /** Record the CPU-side wall time of the last render body, in ms. */
  recordCpuMs(ms: number): void {
    this.lastRenderCpuMs = ms;
  }

  /**
   * Latest viewport render cost, for the status-bar tab-load readout. Polls any
   * pending GPU timer so the value keeps updating even while the on-demand loop
   * is idle (no new frames). `gpuMs` is null when timer queries are unsupported.
   */
  getSample(): ViewportPerfSample {
    this.resolve();
    return { cpuMs: this.lastRenderCpuMs, gpuMs: this.lastRenderGpuMs };
  }

  /** Lazily resolve the WebGL2 timer-query extension (null if unsupported). */
  private ensureTimer(): {
    ext: DisjointTimerQueryExt | null;
    query: WebGLQuery | null;
    inFlight: boolean;
  } {
    if (this.timer) return this.timer;
    let ext: DisjointTimerQueryExt | null = null;
    try {
      const gl = this.getRenderer()?.getContext();
      // Timer queries are a WebGL2 feature (core beginQuery/endQuery + the ext enums).
      if (gl && typeof (gl as WebGL2RenderingContext).createQuery === 'function') {
        ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerQueryExt | null;
      }
    } catch {
      ext = null;
    }
    this.timer = { ext, query: null, inFlight: false };
    return this.timer;
  }

  /** Open a GPU timer query around the coming render. Returns false if it couldn't. */
  beginFrame(): boolean {
    const timer = this.ensureTimer();
    if (!timer.ext || timer.inFlight) return false;
    const gl = this.getRenderer()?.getContext() as WebGL2RenderingContext | undefined;
    if (!gl) return false;
    try {
      if (!timer.query) {
        timer.query = gl.createQuery();
      }
      if (!timer.query) return false;
      gl.beginQuery(timer.ext.TIME_ELAPSED_EXT, timer.query);
      timer.inFlight = true;
      return true;
    } catch {
      return false;
    }
  }

  endFrame(started: boolean): void {
    if (!started) return;
    const timer = this.timer;
    if (!timer?.ext) return;
    const gl = this.getRenderer()?.getContext() as WebGL2RenderingContext | undefined;
    if (!gl) return;
    try {
      gl.endQuery(timer.ext.TIME_ELAPSED_EXT);
    } catch {
      timer.inFlight = false;
    }
  }

  /** Read back the GPU time once the driver reports the query as available. */
  resolve(): void {
    const timer = this.timer;
    if (!timer?.ext || !timer.inFlight || !timer.query) return;
    const gl = this.getRenderer()?.getContext() as WebGL2RenderingContext | undefined;
    if (!gl) return;
    try {
      const available = gl.getQueryParameter(timer.query, gl.QUERY_RESULT_AVAILABLE) as boolean;
      const disjoint = gl.getParameter(timer.ext.GPU_DISJOINT_EXT) as boolean;
      if (!available) return;
      timer.inFlight = false;
      if (disjoint) {
        // Timing was interrupted (e.g. context switch) — discard this sample.
        return;
      }
      const elapsedNs = gl.getQueryParameter(timer.query, gl.QUERY_RESULT) as number;
      this.lastRenderGpuMs = elapsedNs / 1e6;
    } catch {
      timer.inFlight = false;
    }
  }
}
