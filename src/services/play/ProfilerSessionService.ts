import { subscribe } from 'valtio/vanilla';

import { injectable } from '@/fw/di';
import { appState } from '@/state';
import {
  LongAnimationFrameObserver,
  type LongAnimationFrameStats,
} from '@/services/play/LongAnimationFrameObserver';
import type {
  ActiveAudioPlaybackSnapshot,
  FrameProfilerActivity,
  RuntimeRenderer,
  RuntimeRendererStatsSnapshot,
  SceneRunner,
  SceneRunnerFrameSample,
} from '@pix3/runtime';

/**
 * Initial value of `ProfilerSessionService.lastReconciledAudioInstances`: a
 * reference no runtime sample can ever carry, so the first sample of a session
 * (even one with no audio) always runs the reconcile.
 */
const NOT_YET_RECONCILED: readonly ActiveAudioPlaybackSnapshot[] = Object.freeze([]);

export type GameHostKind = 'tab' | 'popout' | 'remote';
export type ProfilerSessionStatus = 'idle' | 'starting' | 'running';

export interface ProfilerPerformanceSnapshot {
  readonly fps: number | null;
  readonly frameTimeMs: number | null;
  readonly logicMs: number | null;
  readonly renderMs: number | null;
  /**
   * Wall-clock time in the frame that was neither logic nor render — see
   * `SceneRunnerFrameSample.unaccountedMs`. Displayed as a peer of Logic/Render
   * because the panel's old `logic + render` framing silently implied that those
   * two added up to the frame, which is exactly the lie that cost a real
   * investigation hours: a 50-90 ms hitch with 0.3 ms of logic in it.
   */
  readonly unaccountedMs: number | null;
  /** How late the browser delivered the frame — `SceneRunnerFrameSample.rafLatenessMs`. */
  readonly rafLatenessMs: number | null;
  readonly drawCalls: number | null;
  readonly triangles: number | null;
  readonly geometries: number | null;
  readonly textures: number | null;
  /** Linked WebGL programs right now (`renderer.info.programs.length`). */
  readonly shaderPrograms: number | null;
  /**
   * Programs linked since the session's first sample. Non-zero means a new
   * material was drawn mid-gameplay, and each such link stalls the main thread
   * synchronously (measured: 50-76 ms), so this predicts a hitch that the frame
   * chart can only confirm afterwards.
   */
  readonly shaderProgramsAdded: number | null;
  readonly jsHeapUsedMb: number | null;
}

export interface ProfilerHistorySnapshot {
  readonly fps: readonly number[];
  readonly frameTimeMs: readonly number[];
  readonly logicMs: readonly number[];
  readonly renderMs: readonly number[];
  readonly unaccountedMs: readonly number[];
}

/**
 * Session-wide distribution of the FRAME INTERVAL (`dt`), not of the runner's
 * work time. FPS in this panel is derived from a 30-frame rolling average, which
 * flattens a spike into "60" — "a clean 60 fps" and "60 fps with 7 % of frames
 * over 20 ms" used to render identically. Percentiles and long-frame counts are
 * what tell those apart.
 */
export interface ProfilerFrameStabilitySnapshot {
  readonly sampleCount: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly over20Count: number;
  readonly over33Count: number;
  readonly over50Count: number;
  readonly worstMs: number | null;
  /** `over20Count / sampleCount` as a percentage, or null before any frame landed. */
  readonly over20Percent: number | null;
}

/**
 * Frames one A/B arm must accumulate before its numbers are allowed to carry a
 * verdict.
 *
 * The investigation that motivated the pause control drew a *wrong* conclusion —
 * "the Profiler panel is 40 % of the jank" — from a single pair of 10-second
 * windows. Re-run under an unchanged condition, the same measurement produced
 * 34 / 43 / 68 janky frames across three identical windows: the between-window
 * spread was larger than the effect being claimed. 600 frames is ~10 s at 60 fps
 * per arm, which is where that spread stops swamping a p95 difference worth
 * acting on. Below it the UI shows counts and withholds the delta entirely — a
 * number you must not trust is worse than no number, because it reads exactly
 * like one you can.
 */
export const PROFILER_AB_MIN_ARM_FRAMES = 600;

/**
 * The in-window A/B: frame-interval distributions accumulated separately while
 * the Profiler was live and while it was paused.
 *
 * The question this answers is "how much does the Profiler panel itself cost?",
 * and the only previously available way to ask it — switch the dock to another
 * tab — changes several things at once (layout, Golden Layout tab activation,
 * the panel's ResizeObserver, whether the canvas is composited) and leaves the
 * reader comparing two different sessions from memory. Pausing in place changes
 * exactly one thing, in one session, with both arms measured by the same code.
 */
export interface ProfilerOverheadComparisonSnapshot {
  /** Frames that landed while the profiler was assembling snapshots and rendering. */
  readonly live: ProfilerFrameStabilitySnapshot;
  /** Frames that landed while the profiler was paused (histogram record only). */
  readonly paused: ProfilerFrameStabilitySnapshot;
  /** {@link PROFILER_AB_MIN_ARM_FRAMES}, carried in the snapshot so the UI states the bar it applies. */
  readonly minimumArmFrames: number;
  /** Both arms reached {@link minimumArmFrames}. Only then may a delta be presented. */
  readonly comparable: boolean;
  /**
   * `live.p95 - paused.p95`, positive when the live panel is the more expensive
   * arm. `null` until {@link comparable} — deliberately not "0", which would
   * render as a measured result rather than an absent one.
   */
  readonly p95DeltaMs: number | null;
  /** `live.over20Percent - paused.over20Percent`, same null-until-comparable rule. */
  readonly over20PercentDelta: number | null;
}

/** All-zero stability block — the shape every "nothing measured here" case uses. */
export function createEmptyFrameStabilitySnapshot(): ProfilerFrameStabilitySnapshot {
  return {
    sampleCount: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    over20Count: 0,
    over33Count: 0,
    over50Count: 0,
    worstMs: null,
    over20Percent: null,
  };
}

/**
 * An A/B block with both arms empty and no verdict. Used for sources that cannot
 * run the experiment at all (a remote device has no local Profiler panel to pause)
 * and as the panel's pre-subscription default.
 */
export function createEmptyOverheadComparison(): ProfilerOverheadComparisonSnapshot {
  return {
    live: createEmptyFrameStabilitySnapshot(),
    paused: createEmptyFrameStabilitySnapshot(),
    minimumArmFrames: PROFILER_AB_MIN_ARM_FRAMES,
    comparable: false,
    p95DeltaMs: null,
    over20PercentDelta: null,
  };
}

export interface ProfilerLongFrameRecordSnapshot {
  readonly durationMs: number;
  readonly blockingDurationMs: number;
  /** `null` = the browser attributed no long script; see `LongAnimationFrameObserver`. */
  readonly scriptLabel: string | null;
  readonly scriptDurationMs: number | null;
}

export interface ProfilerLongFrameSnapshot {
  readonly supported: boolean;
  readonly count: number;
  readonly worstDurationMs: number | null;
  readonly worst: readonly ProfilerLongFrameRecordSnapshot[];
}

export interface ProfilerCountersSnapshot {
  readonly elapsedMs: number;
  readonly frameCount: number;
  readonly hostKind: GameHostKind | null;
}

export interface ProfilerFrameImpactEntrySnapshot {
  readonly label: string;
  readonly selfTimeMs: number;
  readonly totalTimeMs: number;
  readonly selfPercent: number | null;
  readonly totalPercent: number | null;
  readonly sampleCount: number;
}

export interface ProfilerFrameImpactSnapshot {
  readonly activities: readonly ProfilerFrameImpactEntrySnapshot[];
  readonly sampledFrameCount: number;
  readonly windowDurationMs: number;
  readonly totalFrameTimeMs: number;
}

export interface ProfilerAudioSnapshot {
  readonly files: readonly ProfilerAudioFileSnapshot[];
  readonly activeInstanceCount: number;
}

export interface ProfilerAudioFileSnapshot {
  readonly key: string;
  readonly label: string;
  readonly resourcePath: string | null;
  readonly durationSeconds: number | null;
  readonly channelCount: number | null;
  readonly sampleRate: number | null;
  readonly bitrateKbps: number | null;
  readonly activeInstanceCount: number;
  readonly isActive: boolean;
  readonly lastPlayedAtMs: number;
  readonly currentInstances: readonly ActiveAudioPlaybackSnapshot[];
  readonly lastPlayback: ActiveAudioPlaybackSnapshot | null;
}

export interface ProfilerSessionSnapshot {
  readonly status: ProfilerSessionStatus;
  /**
   * The profiler is paused: it is still fed every frame, but does nothing with a
   * frame beyond recording its interval. Everything else in this snapshot is
   * frozen at the instant of the pause — the UI must say so rather than let a
   * stale number pass for a live one.
   */
  readonly paused: boolean;
  readonly performance: ProfilerPerformanceSnapshot;
  readonly counters: ProfilerCountersSnapshot;
  readonly history: ProfilerHistorySnapshot;
  readonly frameStability: ProfilerFrameStabilitySnapshot;
  readonly longFrames: ProfilerLongFrameSnapshot;
  readonly frameImpact: ProfilerFrameImpactSnapshot;
  readonly audio: ProfilerAudioSnapshot;
  readonly overhead: ProfilerOverheadComparisonSnapshot;
}

type ProfilerListener = (snapshot: ProfilerSessionSnapshot) => void;

/**
 * What the service actually stores between notifications.
 *
 * `paused` and `overhead` are deliberately NOT part of it: both must read current
 * at the moment a snapshot is handed out, and while the profiler is paused this
 * object is by design not rebuilt at all.
 */
type ProfilerSessionCoreState = Omit<ProfilerSessionSnapshot, 'paused' | 'overhead'>;

interface MemoryPerformance extends Performance {
  memory?: {
    usedJSHeapSize: number;
  };
}

interface ActivityFrameSample {
  readonly frameTimeMs: number;
  readonly activities: readonly FrameProfilerActivity[];
}

interface AudioFileSessionEntry {
  key: string;
  label: string;
  resourcePath: string | null;
  durationSeconds: number | null;
  channelCount: number | null;
  sampleRate: number | null;
  bitrateKbps: number | null;
  activeInstanceCount: number;
  isActive: boolean;
  lastPlayedAtMs: number;
  currentInstances: ActiveAudioPlaybackSnapshot[];
  lastPlayback: ActiveAudioPlaybackSnapshot | null;
}

const SAMPLE_WINDOW_SIZE = 30;
const HISTORY_WINDOW_SIZE = 360;
const FRAME_IMPACT_WINDOW_MS = 8000;
const MIN_FRAME_IMPACT_REORDER_HYSTERESIS_MS = 8;
const FRAME_IMPACT_REORDER_HYSTERESIS_RATIO = 0.002;
const MIN_RUNTIME_FRAME_IMPACT_ROW_MS = 0.01;
const RUNTIME_RENDER_LABEL = 'Runtime Render';
const RUNTIME_LOGIC_LABEL = 'Runtime Logic';
const RUNTIME_LOGIC_UNTRACKED_LABEL = 'Runtime Logic (Untracked)';

/** 1 ms buckets from 0 to this value; everything above lands in the overflow bucket. */
const FRAME_HISTOGRAM_MAX_MS = 100;

/**
 * Fixed-bucket histogram of frame intervals, plus the running counters the
 * Profiler's stability block needs.
 *
 * A session can run for hours, so retaining every frame's `dt` to sort for
 * percentiles is not an option — memory grows without bound and the percentile
 * itself costs O(n log n). 1 ms buckets up to {@link FRAME_HISTOGRAM_MAX_MS} plus
 * one overflow bucket make `record` O(1) with zero allocation and a percentile
 * O(buckets), which is the shape this measurement actually needs: nobody cares
 * whether p99 was 41.3 ms or 41.8 ms, they care that it was not 16.7 ms.
 *
 * Percentiles use nearest-rank and report the **upper edge** of the bucket the
 * ranked sample fell in, clamped to the worst sample seen — i.e. "at least p % of
 * frames were at or below this" — so the number is never optimistic.
 */
export class FrameIntervalHistogram {
  private readonly buckets = new Uint32Array(FRAME_HISTOGRAM_MAX_MS + 1);
  private sampleCount = 0;
  private over20 = 0;
  private over33 = 0;
  private over50 = 0;
  private worstMs = 0;

  reset(): void {
    this.buckets.fill(0);
    this.sampleCount = 0;
    this.over20 = 0;
    this.over33 = 0;
    this.over50 = 0;
    this.worstMs = 0;
  }

  record(frameIntervalMs: number): void {
    if (!Number.isFinite(frameIntervalMs) || frameIntervalMs < 0) {
      return;
    }

    const bucket = Math.min(Math.floor(frameIntervalMs), FRAME_HISTOGRAM_MAX_MS);
    this.buckets[bucket] += 1;
    this.sampleCount += 1;
    if (frameIntervalMs > this.worstMs) {
      this.worstMs = frameIntervalMs;
    }
    if (frameIntervalMs > 20) {
      this.over20 += 1;
    }
    if (frameIntervalMs > 33) {
      this.over33 += 1;
    }
    if (frameIntervalMs > 50) {
      this.over50 += 1;
    }
  }

  getSnapshot(): ProfilerFrameStabilitySnapshot {
    return {
      sampleCount: this.sampleCount,
      p50Ms: this.percentile(50),
      p95Ms: this.percentile(95),
      p99Ms: this.percentile(99),
      over20Count: this.over20,
      over33Count: this.over33,
      over50Count: this.over50,
      worstMs: this.sampleCount === 0 ? null : this.worstMs,
      over20Percent: this.sampleCount === 0 ? null : (this.over20 / this.sampleCount) * 100,
    };
  }

  private percentile(percent: number): number | null {
    if (this.sampleCount === 0) {
      return null;
    }

    const targetRank = Math.max(1, Math.ceil((percent / 100) * this.sampleCount));
    let cumulative = 0;
    for (let bucket = 0; bucket < this.buckets.length; bucket += 1) {
      cumulative += this.buckets[bucket] ?? 0;
      if (cumulative >= targetRank) {
        // The overflow bucket has no upper edge — the worst sample is the only
        // honest answer there.
        if (bucket === FRAME_HISTOGRAM_MAX_MS) {
          return this.worstMs;
        }
        return Math.min(bucket + 1, this.worstMs);
      }
    }

    return this.worstMs;
  }
}

@injectable()
export class ProfilerSessionService {
  private readonly listeners = new Set<ProfilerListener>();
  private readonly frameTimesMs: number[] = [];
  /**
   * Rolling windows for the work halves of the frame, over the SAME window as
   * {@link frameTimesMs}.
   *
   * The displayed Frame row is a rolling average (it feeds FPS), so pairing it with
   * single-sample Logic/Render/Unaccounted made the four numbers irreconcilable — the panel
   * showed `Frame 17.3` beside parts summing to 11.1. That was tolerable while the section
   * merely listed "logic + render", but it now claims to say *where the frame went*, so the
   * decomposition has to actually add up.
   */
  private readonly logicTimesMs: number[] = [];
  private readonly renderTimesMs: number[] = [];
  private readonly fpsHistory: number[] = [];
  private readonly frameTimeHistory: number[] = [];
  private readonly logicHistory: number[] = [];
  private readonly renderHistory: number[] = [];
  private readonly unaccountedHistory: number[] = [];
  /** Session-wide `dt` distribution — O(1) per frame, O(buckets) per read. */
  private readonly frameIntervals = new FrameIntervalHistogram();
  /**
   * The A/B arms. Every frame is recorded into exactly the arm that was active
   * when it happened, so the two never double-count and their counts sum to the
   * session-wide {@link frameIntervals} count.
   */
  private readonly liveFrameIntervals = new FrameIntervalHistogram();
  private readonly pausedFrameIntervals = new FrameIntervalHistogram();
  /** See {@link setPaused}. */
  private paused = false;
  /** Browser-side view of the same frames; see {@link LongAnimationFrameObserver}. */
  private readonly longAnimationFrames = new LongAnimationFrameObserver();
  /** `renderer.info.programs.length` at the session's first sample (growth baseline). */
  private shaderProgramBaseline: number | null = null;
  private readonly activityFrames: ActivityFrameSample[] = [];
  private readonly audioFiles = new Map<string, AudioFileSessionEntry>();
  private previousFrameImpactOrder: string[] = [];
  private disposeRunnerSubscription?: () => void;
  /**
   * The runner this session is bound to, kept so the per-frame subscription can be dropped and
   * re-taken as the Profiler goes off and back on screen (see {@link applyFrameSubscription}).
   */
  private boundRunner: SceneRunner | null = null;
  private disposeWorkspaceSubscription?: () => void;
  private runtimeRenderer: RuntimeRenderer | null = null;
  private state: ProfilerSessionCoreState = this.createIdleState();
  private notifyThrottleTimer: number | null = null;
  private lastNotifyTime = 0;
  /** Newest frame sample not yet folded into {@link state} (see rebuildRunningState). */
  private latestFrameSample: SceneRunnerFrameSample | null = null;
  /**
   * The `activeAudioPlaybacks` array most recently folded into {@link audioFiles}.
   * The runtime hands out the same array by reference until the active set
   * changes or its 10 Hz refresh fires (see `SceneRunnerFrameSample`), so an
   * identical reference means there is nothing new to reconcile — skipping the
   * per-instance copies and sort that used to run on every frame regardless.
   */
  private lastReconciledAudioInstances: readonly ActiveAudioPlaybackSnapshot[] | undefined =
    NOT_YET_RECONCILED;

  subscribe(listener: ProfilerListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Pause (or resume) everything the profiler does with a frame *except* putting
   * its interval in a histogram.
   *
   * While paused the service skips snapshot assembly, history pushes, frame-impact
   * aggregation, audio reconcile and all listener notification, so the panel stops
   * re-rendering and stops rebuilding its SVG charts. Two things deliberately keep
   * running, and both are load-bearing for the measurement:
   *
   * - **The runner's frame subscription stays attached.** The runner still assembles
   *   its (already 10 Hz-throttled) per-frame sample in both arms, so that residual
   *   cost is identical on both sides and cancels out of the comparison. Dropping the
   *   subscription would fold the runner's sampling into the delta and the result
   *   would no longer isolate *the panel* — which is the thing the user asked about.
   * - **{@link LongAnimationFrameObserver} keeps observing.** It is a browser-side
   *   PerformanceObserver, effectively free, and long-frame attribution is precisely
   *   the evidence that has to survive the pause for the pause to be worth taking.
   *
   * The transition itself notifies once, so the UI can flip to its paused state and
   * fold in the last pre-pause frame; that is the final notification until resume.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) {
      return;
    }

    this.paused = paused;
    this.notify();
  }

  getSnapshot(): ProfilerSessionSnapshot {
    if (this.latestFrameSample) {
      this.rebuildRunningState();
    }
    return {
      status: this.state.status,
      paused: this.paused,
      performance: { ...this.state.performance },
      counters: { ...this.state.counters },
      history: {
        fps: [...this.state.history.fps],
        frameTimeMs: [...this.state.history.frameTimeMs],
        logicMs: [...this.state.history.logicMs],
        renderMs: [...this.state.history.renderMs],
        unaccountedMs: [...this.state.history.unaccountedMs],
      },
      frameStability: { ...this.state.frameStability },
      longFrames: {
        supported: this.state.longFrames.supported,
        count: this.state.longFrames.count,
        worstDurationMs: this.state.longFrames.worstDurationMs,
        worst: this.state.longFrames.worst.map(record => ({ ...record })),
      },
      frameImpact: {
        activities: this.state.frameImpact.activities.map(activity => ({ ...activity })),
        sampledFrameCount: this.state.frameImpact.sampledFrameCount,
        windowDurationMs: this.state.frameImpact.windowDurationMs,
        totalFrameTimeMs: this.state.frameImpact.totalFrameTimeMs,
      },
      audio: {
        files: this.state.audio.files.map(file => ({
          ...file,
          currentInstances: file.currentInstances.map(instance => ({ ...instance })),
          lastPlayback: file.lastPlayback ? { ...file.lastPlayback } : null,
        })),
        activeInstanceCount: this.state.audio.activeInstanceCount,
      },
      // Built here rather than folded into `state`: the arms keep filling while
      // paused (that is the whole point), so reading them off a snapshot frozen at
      // the pause would report the paused arm as permanently empty.
      overhead: this.buildOverheadComparison(),
    };
  }

  /**
   * The A/B block. The delta is withheld — `null`, not `0` — until **both** arms
   * clear {@link PROFILER_AB_MIN_ARM_FRAMES}, because an underpowered comparison
   * here is not a weak signal but a misleading one: see the constant's note for
   * the run-to-run spread that produced a confidently wrong answer.
   */
  private buildOverheadComparison(): ProfilerOverheadComparisonSnapshot {
    const live = this.liveFrameIntervals.getSnapshot();
    const paused = this.pausedFrameIntervals.getSnapshot();
    const comparable =
      live.sampleCount >= PROFILER_AB_MIN_ARM_FRAMES &&
      paused.sampleCount >= PROFILER_AB_MIN_ARM_FRAMES;

    return {
      live,
      paused,
      minimumArmFrames: PROFILER_AB_MIN_ARM_FRAMES,
      comparable,
      p95DeltaMs:
        comparable && live.p95Ms !== null && paused.p95Ms !== null
          ? live.p95Ms - paused.p95Ms
          : null,
      over20PercentDelta:
        comparable && live.over20Percent !== null && paused.over20Percent !== null
          ? live.over20Percent - paused.over20Percent
          : null,
    };
  }

  beginSession(hostKind: GameHostKind): void {
    this.frameTimesMs.length = 0;
    this.logicTimesMs.length = 0;
    this.renderTimesMs.length = 0;
    this.activityFrames.length = 0;
    this.audioFiles.clear();
    this.lastReconciledAudioInstances = NOT_YET_RECONCILED;
    this.previousFrameImpactOrder = [];
    this.latestFrameSample = null;
    this.runtimeRenderer = null;
    this.frameIntervals.reset();
    // Both A/B arms belong to the session that produced them: carrying frames from
    // a previous run into this comparison would mix two different scenes, builds or
    // window sizes into one p95. A new session also starts LIVE — resuming into an
    // already-paused profiler would show a frozen panel with two empty arms, which
    // reads as broken rather than as deliberate.
    this.liveFrameIntervals.reset();
    this.pausedFrameIntervals.reset();
    this.paused = false;
    this.shaderProgramBaseline = null;
    // Arm LoAF with the session: entries observed before Play started describe
    // the editor's own work, not the game's.
    this.longAnimationFrames.start();
    this.disposeRunnerSubscription?.();
    this.disposeRunnerSubscription = undefined;
    this.state = {
      status: 'starting',
      performance: this.createEmptyPerformance(),
      counters: {
        elapsedMs: 0,
        frameCount: 0,
        hostKind,
      },
      history: this.createEmptyHistory(),
      frameStability: this.frameIntervals.getSnapshot(),
      longFrames: this.toLongFrameSnapshot(this.longAnimationFrames.getStats()),
      frameImpact: this.createEmptyFrameImpact(),
      audio: this.createEmptyAudioSnapshot(),
    };
    this.notify();
  }

  bindRuntime(runner: SceneRunner, renderer: RuntimeRenderer, hostKind: GameHostKind): void {
    this.runtimeRenderer = renderer;
    this.state = {
      ...this.state,
      counters: {
        ...this.state.counters,
        hostKind,
      },
    };
    this.boundRunner = runner;
    this.applyFrameSubscription();
    this.disposeWorkspaceSubscription ??= subscribe(appState.ui, () =>
      this.applyFrameSubscription()
    );
    this.notify();
  }

  /**
   * Take (or drop) the runner's per-frame stats subscription depending on whether anything can show
   * them. In Vibe the whole Studio workspace — Profiler panel included — is still in the DOM but
   * hidden, so without this the game pays for a full frame sample (activity copies, audio snapshot,
   * renderer stats) plus a 10 Hz rebuild of a panel nobody can see. Re-taking it on the way back
   * restarts the history graphs, which is the honest thing to show: nothing was measured meanwhile.
   */
  private applyFrameSubscription(): void {
    const shouldObserve = this.boundRunner !== null && appState.ui.workspaceMode !== 'flow';
    if (shouldObserve === Boolean(this.disposeRunnerSubscription)) {
      return;
    }
    if (!shouldObserve) {
      this.disposeRunnerSubscription?.();
      this.disposeRunnerSubscription = undefined;
      return;
    }
    this.disposeRunnerSubscription = this.boundRunner?.subscribeFrameStats(sample => {
      this.handleFrameSample(sample);
    });
  }

  endSession(): void {
    this.disposeRunnerSubscription?.();
    this.disposeRunnerSubscription = undefined;
    this.disposeWorkspaceSubscription?.();
    this.disposeWorkspaceSubscription = undefined;
    this.boundRunner = null;
    this.runtimeRenderer = null;
    this.frameTimesMs.length = 0;
    this.logicTimesMs.length = 0;
    this.renderTimesMs.length = 0;
    this.fpsHistory.length = 0;
    this.frameTimeHistory.length = 0;
    this.logicHistory.length = 0;
    this.renderHistory.length = 0;
    this.unaccountedHistory.length = 0;
    this.frameIntervals.reset();
    this.liveFrameIntervals.reset();
    this.pausedFrameIntervals.reset();
    this.paused = false;
    this.longAnimationFrames.stop();
    this.shaderProgramBaseline = null;
    this.activityFrames.length = 0;
    this.audioFiles.clear();
    this.lastReconciledAudioInstances = NOT_YET_RECONCILED;
    this.previousFrameImpactOrder = [];
    this.latestFrameSample = null;
    this.state = this.createIdleState();
    this.notify();
  }

  private handleFrameSample(sample: SceneRunnerFrameSample): void {
    const frameIntervalMs = sample.dt * 1000;
    // Session-wide distribution: fed the RAW per-frame interval, never the
    // rolling average the FPS readout uses. Averaging first is what made a
    // session with 7 % of frames over 20 ms indistinguishable from a clean one.
    this.frameIntervals.record(frameIntervalMs);
    // …and into exactly the A/B arm that was active for THIS frame. Both records
    // are O(1) with zero allocation, which is what lets the paused arm survive the
    // pause without contaminating what it is measuring.
    (this.paused ? this.pausedFrameIntervals : this.liveFrameIntervals).record(frameIntervalMs);

    if (this.paused) {
      // Everything below is the work being A/B-tested: snapshot assembly, history
      // pushes, frame-impact aggregation, audio reconcile, listener notification.
      // Returning here is the entire pause — if this line ever stops being the
      // first thing after the histograms, the feature silently becomes a lie that
      // only hides the UI. See `setPaused` for what deliberately keeps running.
      return;
    }

    // Per-frame accumulators — these must see every frame (rolling averages,
    // the frame-impact window, and the session audio-file registry, which would
    // miss sub-100ms sounds if sampled at notify cadence).
    this.pushFrameTime(frameIntervalMs);
    this.pushWindowed(this.logicTimesMs, sample.logicMs);
    this.pushWindowed(this.renderTimesMs, sample.renderMs);
    const averagedFrameTime = this.getAverageFrameTimeMs();
    const fps = averagedFrameTime > 0 ? 1000 / averagedFrameTime : null;
    const frameTimeMs = averagedFrameTime > 0 ? averagedFrameTime : null;
    this.pushActivityFrame(this.createFrameImpactActivities(sample), frameIntervalMs);
    this.pushHistorySample(this.fpsHistory, fps);
    this.pushHistorySample(this.frameTimeHistory, frameTimeMs);
    this.pushHistorySample(this.logicHistory, sample.logicMs);
    this.pushHistorySample(this.renderHistory, sample.renderMs);
    this.pushHistorySample(this.unaccountedHistory, sample.unaccountedMs);
    this.reconcileAudioFiles(sample.activeAudioPlaybacks);

    // Snapshot assembly (history array copies, frame-impact aggregation, audio
    // DTO sort, renderer-stats + JS-heap reads) is deferred to notify time —
    // building it per frame only to throw it away between throttled UI pushes
    // was measurable churn.
    this.latestFrameSample = sample;
    this.notifyThrottled();
  }

  /** Assemble {@link state} from the newest frame sample (10Hz, not per-frame). */
  private rebuildRunningState(): void {
    const sample = this.latestFrameSample;
    if (!sample) {
      return;
    }
    this.latestFrameSample = null;

    const averagedFrameTime = this.getAverageFrameTimeMs();
    const rendererStats =
      this.runtimeRenderer?.getStatsSnapshot() ??
      sample.rendererStats ??
      this.createEmptyRendererStats();
    const fps = averagedFrameTime > 0 ? 1000 / averagedFrameTime : null;
    const split = this.getAveragedFrameSplit();
    const frameTimeMs = averagedFrameTime > 0 ? averagedFrameTime : null;
    const shaderPrograms = rendererStats.programs;
    // Baseline on the first sample that carries a count: the programs linked
    // while the scene was booting are expected, growth afterwards is the signal.
    this.shaderProgramBaseline ??= shaderPrograms;
    this.state = {
      status: 'running',
      performance: {
        fps,
        frameTimeMs,
        // Averaged over the same window as `frameTimeMs`, so Logic + Render + Unaccounted
        // equals the Frame row rather than describing a different instant.
        logicMs: split.logicMs,
        renderMs: split.renderMs,
        unaccountedMs: split.unaccountedMs,
        rafLatenessMs: sample.rafLatenessMs,
        drawCalls: rendererStats.calls,
        triangles: rendererStats.triangles,
        geometries: rendererStats.geometries,
        textures: rendererStats.textures,
        shaderPrograms,
        shaderProgramsAdded: Math.max(0, shaderPrograms - (this.shaderProgramBaseline ?? 0)),
        jsHeapUsedMb: this.readJsHeapUsedMb(),
      },
      counters: {
        elapsedMs: Math.max(0, sample.elapsedTime * 1000),
        frameCount: sample.frameNumber,
        hostKind: this.state.counters.hostKind,
      },
      history: {
        fps: [...this.fpsHistory],
        frameTimeMs: [...this.frameTimeHistory],
        logicMs: [...this.logicHistory],
        renderMs: [...this.renderHistory],
        unaccountedMs: [...this.unaccountedHistory],
      },
      // Both blocks are aggregated here, on the 10 Hz notify cadence, never per
      // frame: the per-frame side stays O(1) counter bumps.
      frameStability: this.frameIntervals.getSnapshot(),
      longFrames: this.toLongFrameSnapshot(this.longAnimationFrames.getStats()),
      frameImpact: this.createFrameImpactSnapshot(),
      audio: this.buildAudioSnapshot(),
    };
  }

  private toLongFrameSnapshot(stats: LongAnimationFrameStats): ProfilerLongFrameSnapshot {
    return {
      supported: stats.supported,
      count: stats.count,
      worstDurationMs: stats.worstDurationMs,
      worst: stats.worst.map(record => ({
        durationMs: record.durationMs,
        blockingDurationMs: record.blockingDurationMs,
        scriptLabel: record.scriptLabel,
        scriptDurationMs: record.scriptDurationMs,
      })),
    };
  }

  /**
   * One frame's frame-impact rows: the sample's normalized custom activities with
   * the runtime's own render / logic rows appended to that same, fresh array. It
   * is built exactly once per frame and then owned by the activity window, so
   * nothing downstream copies it again (this path runs on every frame while the
   * Profiler is open; the spread-and-renormalize it replaced was pure churn).
   */
  private createFrameImpactActivities(sample: SceneRunnerFrameSample): FrameProfilerActivity[] {
    const activities = this.normalizeActivityFrame(sample.profilerActivities);
    this.appendRuntimeFrameImpactActivities(sample, activities);
    return activities;
  }

  private appendRuntimeFrameImpactActivities(
    sample: SceneRunnerFrameSample,
    activities: FrameProfilerActivity[]
  ): void {
    const logicMs = this.normalizeActivityTime(sample.logicMs) ?? 0;
    const renderMs = this.normalizeActivityTime(sample.renderMs) ?? 0;
    // Read the custom rows before appending the runtime ones below.
    const customCount = activities.length;
    let trackedCustomLogicMs = 0;
    for (let index = 0; index < customCount; index += 1) {
      trackedCustomLogicMs += activities[index].selfTimeMs;
    }

    if (renderMs > MIN_RUNTIME_FRAME_IMPACT_ROW_MS) {
      activities.push({
        label: RUNTIME_RENDER_LABEL,
        selfTimeMs: renderMs,
      });
    }

    if (customCount === 0) {
      if (logicMs > MIN_RUNTIME_FRAME_IMPACT_ROW_MS) {
        activities.push({
          label: RUNTIME_LOGIC_LABEL,
          selfTimeMs: logicMs,
        });
      }

      return;
    }

    const untrackedLogicMs = Math.max(0, logicMs - trackedCustomLogicMs);
    if (untrackedLogicMs > MIN_RUNTIME_FRAME_IMPACT_ROW_MS) {
      activities.push({
        label: RUNTIME_LOGIC_UNTRACKED_LABEL,
        selfTimeMs: untrackedLogicMs,
      });
    }
  }

  private pushFrameTime(frameTimeMs: number): void {
    this.frameTimesMs.push(frameTimeMs);
    if (this.frameTimesMs.length > SAMPLE_WINDOW_SIZE) {
      this.frameTimesMs.shift();
    }
  }

  /** Append to a rolling window bounded by {@link SAMPLE_WINDOW_SIZE}. */
  private pushWindowed(window: number[], value: number): void {
    window.push(value);
    if (window.length > SAMPLE_WINDOW_SIZE) {
      window.shift();
    }
  }

  private averageOf(window: readonly number[]): number {
    if (window.length === 0) {
      return 0;
    }
    return window.reduce((accumulator, value) => accumulator + value, 0) / window.length;
  }

  /**
   * The frame split as the panel displays it: three parts that sum to the Frame row.
   *
   * Unaccounted is DERIVED from the averages rather than averaged from the per-frame
   * `unaccountedMs`, so the decomposition reconciles exactly by construction. (Averaging the
   * per-frame value would drift whenever its `max(0, …)` clamp fired.) The per-frame value is
   * still what the history chart plots, where each point is one real frame.
   */
  private getAveragedFrameSplit(): {
    frameTimeMs: number;
    logicMs: number;
    renderMs: number;
    unaccountedMs: number;
  } {
    const frameTimeMs = this.getAverageFrameTimeMs();
    const logicMs = this.averageOf(this.logicTimesMs);
    const renderMs = this.averageOf(this.renderTimesMs);
    return {
      frameTimeMs,
      logicMs,
      renderMs,
      unaccountedMs: Math.max(0, frameTimeMs - logicMs - renderMs),
    };
  }

  private getAverageFrameTimeMs(): number {
    if (this.frameTimesMs.length === 0) {
      return 0;
    }

    const sum = this.frameTimesMs.reduce((accumulator, value) => accumulator + value, 0);
    return sum / this.frameTimesMs.length;
  }

  private pushHistorySample(target: number[], value: number | null): void {
    target.push(typeof value === 'number' && Number.isFinite(value) ? value : 0);
    if (target.length > HISTORY_WINDOW_SIZE) {
      target.shift();
    }
  }

  /**
   * `activities` must already be normalized and owned by the caller — it is:
   * {@link createFrameImpactActivities} builds a fresh array per frame. It is
   * stored as-is; re-normalizing here used to copy every row a second time.
   */
  private pushActivityFrame(activities: FrameProfilerActivity[], frameTimeMs: number): void {
    const normalizedFrameTimeMs = this.normalizeActivityTime(frameTimeMs) ?? 0;
    this.activityFrames.push({
      frameTimeMs: normalizedFrameTimeMs,
      activities,
    });

    while (
      this.activityFrames.length > 1 &&
      this.getActivityFrameWindowDurationMs() > FRAME_IMPACT_WINDOW_MS
    ) {
      this.activityFrames.shift();
    }
  }

  private normalizeActivityFrame(
    activities: readonly FrameProfilerActivity[] | undefined
  ): FrameProfilerActivity[] {
    if (!activities || activities.length === 0) {
      return [];
    }

    const normalized: FrameProfilerActivity[] = [];
    for (const activity of activities) {
      const label = typeof activity.label === 'string' ? activity.label.trim() : '';
      if (!label) {
        continue;
      }

      const selfTimeMs = this.normalizeActivityTime(activity.selfTimeMs);
      if (selfTimeMs === null) {
        continue;
      }

      const totalTimeMs = this.normalizeActivityTime(activity.totalTimeMs);
      normalized.push(
        totalTimeMs === null
          ? { label, selfTimeMs }
          : {
              label,
              selfTimeMs,
              totalTimeMs: Math.max(totalTimeMs, selfTimeMs),
            }
      );
    }

    return normalized;
  }

  private normalizeActivityTime(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return null;
    }

    return value;
  }

  private createFrameImpactSnapshot(): ProfilerFrameImpactSnapshot {
    if (this.activityFrames.length === 0) {
      return this.createEmptyFrameImpact();
    }

    const totalFrameTimeMs = this.getActivityFrameWindowDurationMs();
    const sampledFrameCount = this.activityFrames.length;
    const aggregates = new Map<
      string,
      {
        label: string;
        selfSum: number;
        totalSum: number;
        sampleCount: number;
      }
    >();

    for (const frame of this.activityFrames) {
      for (const activity of frame.activities) {
        const entry = aggregates.get(activity.label) ?? {
          label: activity.label,
          selfSum: 0,
          totalSum: 0,
          sampleCount: 0,
        };
        entry.selfSum += activity.selfTimeMs;
        entry.totalSum += activity.totalTimeMs ?? activity.selfTimeMs;
        entry.sampleCount += 1;
        aggregates.set(activity.label, entry);
      }
    }

    const activities = this.orderFrameImpactActivities(
      [...aggregates.values()]
        .map(entry => {
          const selfTimeMs = entry.selfSum;
          const totalTimeMs = entry.totalSum;
          return {
            label: entry.label,
            selfTimeMs,
            totalTimeMs,
            selfPercent: this.toFrameImpactPercent(selfTimeMs, totalFrameTimeMs),
            totalPercent: this.toFrameImpactPercent(totalTimeMs, totalFrameTimeMs),
            sampleCount: entry.sampleCount,
          } satisfies ProfilerFrameImpactEntrySnapshot;
        })
        .filter(activity => activity.totalTimeMs > 0 || activity.selfTimeMs > 0),
      totalFrameTimeMs
    );

    return {
      activities,
      sampledFrameCount,
      windowDurationMs: totalFrameTimeMs,
      totalFrameTimeMs,
    };
  }

  private getActivityFrameWindowDurationMs(): number {
    return this.activityFrames.reduce((accumulator, frame) => accumulator + frame.frameTimeMs, 0);
  }

  private orderFrameImpactActivities(
    activities: ProfilerFrameImpactEntrySnapshot[],
    totalFrameTimeMs: number
  ): ProfilerFrameImpactEntrySnapshot[] {
    if (activities.length === 0) {
      this.previousFrameImpactOrder = [];
      return [];
    }

    const activityByLabel = new Map(activities.map(activity => [activity.label, activity]));
    const previousLabels = this.previousFrameImpactOrder.filter(label =>
      activityByLabel.has(label)
    );
    const previousLabelSet = new Set(previousLabels);
    const newLabels = activities
      .map(activity => activity.label)
      .filter(label => !previousLabelSet.has(label))
      .sort((leftLabel, rightLabel) => {
        const leftActivity = activityByLabel.get(leftLabel);
        const rightActivity = activityByLabel.get(rightLabel);
        if (!leftActivity || !rightActivity) {
          return 0;
        }

        return this.compareFrameImpactActivities(leftActivity, rightActivity);
      });

    const orderedLabels = [...previousLabels, ...newLabels];
    const thresholdMs = this.getFrameImpactReorderThresholdMs(totalFrameTimeMs);

    let moved = true;
    while (moved) {
      moved = false;
      for (let index = 1; index < orderedLabels.length; index += 1) {
        const currentActivity = activityByLabel.get(orderedLabels[index] ?? '');
        const previousActivity = activityByLabel.get(orderedLabels[index - 1] ?? '');
        if (!currentActivity || !previousActivity) {
          continue;
        }

        if (
          !this.shouldPromoteFrameImpactActivity(currentActivity, previousActivity, thresholdMs)
        ) {
          continue;
        }

        [orderedLabels[index - 1], orderedLabels[index]] = [
          orderedLabels[index] ?? '',
          orderedLabels[index - 1] ?? '',
        ];
        moved = true;
      }
    }

    this.previousFrameImpactOrder = [...orderedLabels];
    return orderedLabels
      .map(label => activityByLabel.get(label))
      .filter((activity): activity is ProfilerFrameImpactEntrySnapshot => activity !== undefined);
  }

  private compareFrameImpactActivities(
    left: ProfilerFrameImpactEntrySnapshot,
    right: ProfilerFrameImpactEntrySnapshot
  ): number {
    return (
      right.totalTimeMs - left.totalTimeMs ||
      right.selfTimeMs - left.selfTimeMs ||
      left.label.localeCompare(right.label)
    );
  }

  private shouldPromoteFrameImpactActivity(
    candidate: ProfilerFrameImpactEntrySnapshot,
    currentAbove: ProfilerFrameImpactEntrySnapshot,
    thresholdMs: number
  ): boolean {
    const totalLeadMs = candidate.totalTimeMs - currentAbove.totalTimeMs;
    if (totalLeadMs > thresholdMs) {
      return true;
    }

    if (Math.abs(totalLeadMs) > thresholdMs) {
      return false;
    }

    return candidate.selfTimeMs - currentAbove.selfTimeMs > thresholdMs;
  }

  private getFrameImpactReorderThresholdMs(totalFrameTimeMs: number): number {
    if (!Number.isFinite(totalFrameTimeMs) || totalFrameTimeMs <= 0) {
      return MIN_FRAME_IMPACT_REORDER_HYSTERESIS_MS;
    }

    return Math.max(
      MIN_FRAME_IMPACT_REORDER_HYSTERESIS_MS,
      totalFrameTimeMs * FRAME_IMPACT_REORDER_HYSTERESIS_RATIO
    );
  }

  private toFrameImpactPercent(timeMs: number, averageFrameTimeMs: number | null): number | null {
    if (
      !Number.isFinite(timeMs) ||
      timeMs < 0 ||
      typeof averageFrameTimeMs !== 'number' ||
      !Number.isFinite(averageFrameTimeMs) ||
      averageFrameTimeMs <= 0
    ) {
      return null;
    }

    return (timeMs / averageFrameTimeMs) * 100;
  }

  private readJsHeapUsedMb(): number | null {
    const perf = globalThis.performance as MemoryPerformance | undefined;
    const usedBytes = perf?.memory?.usedJSHeapSize;
    if (typeof usedBytes !== 'number' || !Number.isFinite(usedBytes) || usedBytes < 0) {
      return null;
    }

    return usedBytes / (1024 * 1024);
  }

  private createIdleState(): ProfilerSessionCoreState {
    return {
      status: 'idle',
      performance: this.createEmptyPerformance(),
      counters: {
        elapsedMs: 0,
        frameCount: 0,
        hostKind: null,
      },
      history: this.createEmptyHistory(),
      frameStability: createEmptyFrameStabilitySnapshot(),
      longFrames: this.createEmptyLongFrames(),
      frameImpact: this.createEmptyFrameImpact(),
      audio: this.createEmptyAudioSnapshot(),
    };
  }

  private createEmptyPerformance(): ProfilerPerformanceSnapshot {
    return {
      fps: null,
      frameTimeMs: null,
      logicMs: null,
      renderMs: null,
      unaccountedMs: null,
      rafLatenessMs: null,
      drawCalls: null,
      triangles: null,
      geometries: null,
      textures: null,
      shaderPrograms: null,
      shaderProgramsAdded: null,
      jsHeapUsedMb: this.readJsHeapUsedMb(),
    };
  }

  private createEmptyRendererStats(): RuntimeRendererStatsSnapshot {
    return {
      calls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      geometries: 0,
      textures: 0,
      programs: 0,
    };
  }

  private createEmptyHistory(): ProfilerHistorySnapshot {
    return {
      fps: [],
      frameTimeMs: [],
      logicMs: [],
      renderMs: [],
      unaccountedMs: [],
    };
  }

  private createEmptyLongFrames(): ProfilerLongFrameSnapshot {
    return {
      supported: LongAnimationFrameObserver.isSupported(),
      count: 0,
      worstDurationMs: null,
      worst: [],
    };
  }

  private createEmptyFrameImpact(): ProfilerFrameImpactSnapshot {
    return {
      activities: [],
      sampledFrameCount: 0,
      windowDurationMs: 0,
      totalFrameTimeMs: 0,
    };
  }

  /** Pure DTO over the (per-frame reconciled) audio-file registry. */
  private buildAudioSnapshot(): ProfilerAudioSnapshot {
    const files = [...this.audioFiles.values()]
      .map(entry => ({
        key: entry.key,
        label: entry.label,
        resourcePath: entry.resourcePath,
        durationSeconds: entry.durationSeconds,
        channelCount: entry.channelCount,
        sampleRate: entry.sampleRate,
        bitrateKbps: entry.bitrateKbps,
        activeInstanceCount: entry.activeInstanceCount,
        isActive: entry.isActive,
        lastPlayedAtMs: entry.lastPlayedAtMs,
        currentInstances: entry.currentInstances.map(instance => ({ ...instance })),
        lastPlayback: entry.lastPlayback ? { ...entry.lastPlayback } : null,
      }))
      .sort((left, right) => {
        return (
          Number(right.isActive) - Number(left.isActive) ||
          right.activeInstanceCount - left.activeInstanceCount ||
          right.lastPlayedAtMs - left.lastPlayedAtMs ||
          left.label.localeCompare(right.label) ||
          left.key.localeCompare(right.key)
        );
      });

    return {
      files,
      activeInstanceCount: files.reduce(
        (accumulator, file) => accumulator + file.activeInstanceCount,
        0
      ),
    };
  }

  private createEmptyAudioSnapshot(): ProfilerAudioSnapshot {
    return {
      files: [],
      activeInstanceCount: 0,
    };
  }

  private reconcileAudioFiles(instances: readonly ActiveAudioPlaybackSnapshot[] | undefined): void {
    // Same reference as last frame ⇒ the runtime saw no change in the active set
    // and did not refresh elapsed times; the registry is already up to date.
    if (instances === this.lastReconciledAudioInstances) {
      return;
    }
    this.lastReconciledAudioInstances = instances;

    for (const entry of this.audioFiles.values()) {
      entry.activeInstanceCount = 0;
      entry.isActive = false;
      entry.currentInstances = [];
    }

    for (const instance of instances ?? []) {
      const nextInstance = { ...instance };
      const key = this.getAudioFileKey(nextInstance);
      const entry = this.audioFiles.get(key) ?? this.createAudioFileEntry(key, nextInstance);

      entry.label = this.pickAudioLabel(entry.label, nextInstance);
      entry.resourcePath = nextInstance.resourcePath ?? entry.resourcePath;
      entry.durationSeconds = nextInstance.durationSeconds ?? entry.durationSeconds;
      entry.channelCount = nextInstance.channelCount ?? entry.channelCount;
      entry.sampleRate = nextInstance.sampleRate ?? entry.sampleRate;
      entry.bitrateKbps = nextInstance.bitrateKbps ?? entry.bitrateKbps;
      entry.activeInstanceCount += 1;
      entry.isActive = true;
      entry.currentInstances.push(nextInstance);

      if (
        !entry.lastPlayback ||
        nextInstance.startedAtMs > entry.lastPlayedAtMs ||
        (nextInstance.startedAtMs === entry.lastPlayedAtMs &&
          nextInstance.id.localeCompare(entry.lastPlayback.id) > 0)
      ) {
        entry.lastPlayedAtMs = nextInstance.startedAtMs;
        entry.lastPlayback = nextInstance;
      }

      this.audioFiles.set(key, entry);
    }

    for (const entry of this.audioFiles.values()) {
      entry.currentInstances.sort(
        (left, right) =>
          right.startedAtMs - left.startedAtMs ||
          right.elapsedMs - left.elapsedMs ||
          left.id.localeCompare(right.id)
      );
    }
  }

  private getAudioFileKey(instance: ActiveAudioPlaybackSnapshot): string {
    const resourcePath = instance.resourcePath?.trim();
    if (resourcePath) {
      return resourcePath;
    }

    return instance.label;
  }

  private createAudioFileEntry(
    key: string,
    instance: ActiveAudioPlaybackSnapshot
  ): AudioFileSessionEntry {
    return {
      key,
      label: this.pickAudioLabel(null, instance),
      resourcePath: instance.resourcePath,
      durationSeconds: instance.durationSeconds,
      channelCount: instance.channelCount,
      sampleRate: instance.sampleRate,
      bitrateKbps: instance.bitrateKbps,
      activeInstanceCount: 0,
      isActive: false,
      lastPlayedAtMs: instance.startedAtMs,
      currentInstances: [],
      lastPlayback: null,
    };
  }

  private pickAudioLabel(
    currentLabel: string | null,
    instance: ActiveAudioPlaybackSnapshot
  ): string {
    if (instance.label !== 'Unknown') {
      return instance.label;
    }

    return currentLabel ?? 'Unknown';
  }

  private notify(): void {
    if (this.notifyThrottleTimer !== null) {
      window.clearTimeout(this.notifyThrottleTimer);
      this.notifyThrottleTimer = null;
    }
    this.lastNotifyTime = monotonicNowMs();
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  /**
   * Frame samples arrive on every rAF tick, but pushing each one straight to
   * the UI made the profiler panel re-render (snapshot deep-copy + Lit diff +
   * SVG chart update) at the game's frame rate — the observer measurably
   * dragged down the thing it was observing. Coalesce UI pushes to
   * {@link ProfilerSessionService.LIVE_NOTIFY_INTERVAL_MS}; session lifecycle
   * transitions still notify immediately via {@link notify}.
   */
  private notifyThrottled(): void {
    const elapsed = monotonicNowMs() - this.lastNotifyTime;
    if (elapsed >= ProfilerSessionService.LIVE_NOTIFY_INTERVAL_MS) {
      this.notify();
      return;
    }
    if (this.notifyThrottleTimer === null) {
      this.notifyThrottleTimer = window.setTimeout(
        () => {
          this.notifyThrottleTimer = null;
          this.notify();
        },
        Math.max(0, ProfilerSessionService.LIVE_NOTIFY_INTERVAL_MS - elapsed)
      );
    }
  }

  private static readonly LIVE_NOTIFY_INTERVAL_MS = 100;
}

/** performance.now() with a Date.now() fallback (test envs stub `performance`). */
function monotonicNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
