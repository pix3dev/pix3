/**
 * Session-scoped `PerformanceObserver` over the browser's **Long Animation Frame**
 * (LoAF) entries, owned by `ProfilerSessionService`.
 *
 * Why this exists at all: the Profiler used to report FPS and a `logic + render`
 * breakdown computed entirely from the runner's own instrumentation. During a real
 * investigation into intermittent 50-90 ms hitches it therefore read
 * `FPS 60 / Frame 16.7 ms / Logic 0.3 ms / Render 1.1 ms` while ~7 % of frames
 * blew past 20 ms — because the time was not inside the runner's stopwatch at all.
 * LoAF is the browser's own view of the same frame, and it is the only source that
 * can say *what else* ran.
 *
 * Why a plain collaborator rather than an `@injectable()` service: its whole state
 * (counters, worst entries) is scoped to one play session and is cleared by
 * `beginSession`. A DI singleton would outlive that scope and would have to be
 * reset by its consumer anyway, so the lifetime is better expressed by ownership.
 *
 * **The nuance that makes this worth surfacing** — LoAF only attributes scripts
 * that themselves ran longer than ~5 ms. A long entry with an EMPTY `scripts`
 * array is therefore not a gap in the data: it is positive evidence that the time
 * was *not* spent inside one long JS callback (late delivery, compositing, GC,
 * off-thread work). That distinction is the single most useful thing the panel
 * could have told the user in the investigation above, so it is modelled
 * explicitly (`scriptLabel === null`) instead of rendering an empty list.
 */

/** One `scripts[]` entry of a LoAF timing. Hand-declared: TS's DOM lib has no LoAF types yet. */
interface LongAnimationFrameScriptTimingLike {
  readonly sourceURL?: string;
  readonly sourceFunctionName?: string;
  readonly duration?: number;
  readonly invoker?: string;
}

/** Structural subset of `PerformanceLongAnimationFrameTiming` this module reads. */
interface LongAnimationFrameTimingLike {
  readonly duration?: number;
  readonly startTime?: number;
  readonly blockingDuration?: number;
  readonly scripts?: readonly LongAnimationFrameScriptTimingLike[];
}

/** One of the worst frames of the session, as rendered by the Profiler. */
export interface LongAnimationFrameRecord {
  readonly durationMs: number;
  /** Time past the 50 ms LoAF threshold that actually blocked input, per the browser. */
  readonly blockingDurationMs: number;
  /**
   * `basename.js · functionName` for the longest attributed script, or `null` when
   * the browser attributed none — see the class doc: `null` is a finding, not a gap.
   */
  readonly scriptLabel: string | null;
  /** Duration of the attributed script, when there is one. */
  readonly scriptDurationMs: number | null;
}

export interface LongAnimationFrameStats {
  /** False when the browser has no `long-animation-frame` entry type (degrade silently). */
  readonly supported: boolean;
  readonly count: number;
  readonly worstDurationMs: number | null;
  /** The worst few frames of the session, longest first. */
  readonly worst: readonly LongAnimationFrameRecord[];
}

/** How many of the worst frames are retained — bounded so a long session cannot grow. */
const WORST_FRAME_RETENTION = 4;

const EMPTY_WORST: readonly LongAnimationFrameRecord[] = Object.freeze([]);

export class LongAnimationFrameObserver {
  private observer: PerformanceObserver | null = null;
  private count = 0;
  private worstDurationMs: number | null = null;
  private worst: LongAnimationFrameRecord[] = [];
  private readonly supported = LongAnimationFrameObserver.isSupported();

  /**
   * Whether this browser reports LoAF. Feature-detected through
   * `PerformanceObserver.supportedEntryTypes` (not a try/catch around `observe`),
   * so an unsupported browser costs nothing and surfaces as `supported: false`
   * rather than as an empty-but-plausible-looking zero count.
   */
  static isSupported(): boolean {
    if (typeof PerformanceObserver === 'undefined') {
      return false;
    }

    const types: readonly string[] | undefined = PerformanceObserver.supportedEntryTypes;
    return Array.isArray(types) && types.includes('long-animation-frame');
  }

  /** Clear the counters and (re-)arm the observer. Safe to call repeatedly. */
  start(): void {
    this.reset();
    if (!this.supported || this.observer) {
      return;
    }

    this.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        this.record(entry as PerformanceEntry & LongAnimationFrameTimingLike);
      }
    });
    // `buffered` is deliberately off: entries from before Play started belong to
    // the editor's own work, not to the session being profiled.
    this.observer.observe({ type: 'long-animation-frame' });
  }

  /** Disarm and forget everything; the Profiler calls this when the session ends. */
  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.reset();
  }

  getStats(): LongAnimationFrameStats {
    return {
      supported: this.supported,
      count: this.count,
      worstDurationMs: this.worstDurationMs,
      worst: this.worst.length === 0 ? EMPTY_WORST : this.worst.map(record => ({ ...record })),
    };
  }

  private reset(): void {
    this.count = 0;
    this.worstDurationMs = null;
    this.worst = [];
  }

  private record(entry: PerformanceEntry & LongAnimationFrameTimingLike): void {
    const durationMs = typeof entry.duration === 'number' ? entry.duration : 0;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }

    this.count += 1;
    if (this.worstDurationMs === null || durationMs > this.worstDurationMs) {
      this.worstDurationMs = durationMs;
    }

    const blockingDurationMs =
      typeof entry.blockingDuration === 'number' && Number.isFinite(entry.blockingDuration)
        ? entry.blockingDuration
        : 0;
    const longestScript = this.pickLongestScript(entry.scripts);

    // Insertion sort into a list capped at WORST_FRAME_RETENTION — no unbounded
    // retention of a session's frames, and no sort of a growing array per entry.
    const record: LongAnimationFrameRecord = {
      durationMs,
      blockingDurationMs,
      scriptLabel: longestScript ? this.formatScriptLabel(longestScript) : null,
      scriptDurationMs:
        longestScript && typeof longestScript.duration === 'number' ? longestScript.duration : null,
    };
    const insertAt = this.worst.findIndex(existing => record.durationMs > existing.durationMs);
    if (insertAt === -1) {
      if (this.worst.length < WORST_FRAME_RETENTION) {
        this.worst.push(record);
      }
      return;
    }

    this.worst.splice(insertAt, 0, record);
    if (this.worst.length > WORST_FRAME_RETENTION) {
      this.worst.length = WORST_FRAME_RETENTION;
    }
  }

  private pickLongestScript(
    scripts: readonly LongAnimationFrameScriptTimingLike[] | undefined
  ): LongAnimationFrameScriptTimingLike | null {
    if (!scripts || scripts.length === 0) {
      return null;
    }

    let longest: LongAnimationFrameScriptTimingLike | null = null;
    let longestDuration = -1;
    for (const script of scripts) {
      const duration = typeof script.duration === 'number' ? script.duration : 0;
      if (duration > longestDuration) {
        longestDuration = duration;
        longest = script;
      }
    }

    return longest;
  }

  /**
   * `basename.js · functionName`. The full `sourceURL` is a blob: URL for
   * in-editor user scripts and a bundle path otherwise — neither is readable in a
   * narrow panel column, and the basename is what identifies the file.
   */
  private formatScriptLabel(script: LongAnimationFrameScriptTimingLike): string | null {
    const basename = this.toBasename(script.sourceURL);
    const fnName = script.sourceFunctionName?.trim();
    if (basename && fnName) {
      return `${basename} · ${fnName}`;
    }

    return basename ?? fnName ?? script.invoker?.trim() ?? null;
  }

  private toBasename(sourceURL: string | undefined): string | null {
    const url = sourceURL?.trim();
    if (!url) {
      return null;
    }

    const withoutQuery = url.split(/[?#]/)[0] ?? url;
    const segments = withoutQuery.split('/');
    const last = segments[segments.length - 1]?.trim();
    return last ? last : withoutQuery;
  }
}
