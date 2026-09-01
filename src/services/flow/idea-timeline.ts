/**
 * Phase timer for the Flow idea path (prompt → project open with its design document on screen).
 *
 * Why this exists: the gap measurement clocked that span at 10–16 s **without a single model call**
 * — a quarter to a half of the whole budget the reference product needs to hand back a finished
 * game — and nobody could say which part of it was slow. Guessing is expensive here (the span
 * crosses OPFS writes, lazily-imported template chunks, editor boot and the first scene load), so
 * the path is instrumented instead.
 *
 * Cost when idle is a boolean check: phases are only recorded between {@link begin} and
 * {@link complete}, which only the Flow idea path calls. The breakdown lands in three places —
 * `console.info` for a human, `performance.measure` marks so it shows up in a devtools trace next
 * to everything else, and {@link snapshot} on `window.__pix3IdeaTimeline` so an automated run can
 * read the numbers instead of scraping console text.
 */

interface IdeaPhaseRecord {
  readonly name: string;
  /** Milliseconds from the start of the run. */
  readonly startedAt: number;
  readonly durationMs: number;
}

export interface IdeaTimelineSnapshot {
  readonly running: boolean;
  readonly totalMs: number;
  readonly phases: readonly IdeaPhaseRecord[];
}

class IdeaTimeline {
  private startedAt: number | null = null;
  private phases: IdeaPhaseRecord[] = [];
  private last: IdeaTimelineSnapshot | null = null;
  private armed = false;

  /** Start a run. A second call restarts it — a retried prompt measures itself, not the failed try. */
  begin(): void {
    this.startedAt = performance.now();
    this.phases = [];
    this.armed = false;
    this.mark('begin');
  }

  /**
   * Allow {@link complete} to close the run. Called once the NEW project is open, because the
   * document that ends the stopwatch is rendered by a component that may already be on screen
   * showing the PREVIOUS project — its re-render would otherwise stop the clock in the first
   * frames, before this run had written anything. The hand-run gap measurement hit exactly this
   * trap ("the runner caught the previous project's button") and had to be redone.
   */
  armCompletion(): void {
    if (this.startedAt === null) return;
    this.armed = true;
    this.mark('projectOpen');
  }

  private get active(): boolean {
    return this.startedAt !== null;
  }

  /** Record an instantaneous milestone (zero-length phase) at the current offset. */
  mark(name: string): void {
    if (this.startedAt === null) return;
    this.phases.push({ name, startedAt: performance.now() - this.startedAt, durationMs: 0 });
  }

  /**
   * Time one awaited step. Records even when the step throws — a failure that took 8 s is exactly
   * the datum you want — then rethrows.
   */
  async phase<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (!this.active) {
      return await run();
    }
    const startedAt = performance.now();
    try {
      return await run();
    } finally {
      this.record(name, startedAt);
    }
  }

  /** Same as {@link phase} for a synchronous step. */
  private record(name: string, startedAt: number): void {
    if (this.startedAt === null) return;
    const endedAt = performance.now();
    this.phases.push({
      name,
      startedAt: startedAt - this.startedAt,
      durationMs: endedAt - startedAt,
    });
    try {
      performance.measure(`pix3.idea.${name}`, { start: startedAt, end: endedAt });
    } catch {
      // performance.measure with an options object is unsupported in some test environments.
    }
  }

  /**
   * Close the run at the moment the user can act — the design document rendered with its
   * "Start prototype" call to action, which is the signal the gap measurement timed by hand.
   * Idempotent: only the first call after {@link begin} closes the run.
   */
  complete(name = 'ideaDocVisible'): void {
    if (this.startedAt === null || !this.armed) return;
    this.mark(name);
    const totalMs = performance.now() - this.startedAt;
    this.startedAt = null;
    this.last = { running: false, totalMs, phases: this.phases };
    const rows = this.phases
      .filter(phase => phase.durationMs > 0)
      .map(phase => `${phase.name} ${phase.durationMs.toFixed(0)}ms`)
      .join(' · ');
    console.info(
      `[pix3.idea] prompt → design document on screen: ${totalMs.toFixed(0)}ms${rows ? ` — ${rows}` : ''}`
    );
  }

  /** The last completed run (or the one in flight), for automated measurement runs. */
  snapshot(): IdeaTimelineSnapshot {
    if (this.startedAt !== null) {
      return {
        running: true,
        totalMs: performance.now() - this.startedAt,
        phases: this.phases,
      };
    }
    return this.last ?? { running: false, totalMs: 0, phases: [] };
  }
}

export const ideaTimeline = new IdeaTimeline();

declare global {
  interface Window {
    __pix3IdeaTimeline?: () => IdeaTimelineSnapshot;
  }
}

if (typeof window !== 'undefined') {
  window.__pix3IdeaTimeline = () => ideaTimeline.snapshot();
}
