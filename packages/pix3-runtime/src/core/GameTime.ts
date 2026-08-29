/**
 * GameTime — global time-scale controller for the running scene (P0.3).
 *
 * Owns the single multiplier that {@link SceneRunner} applies to the per-frame
 * delta before it reaches gameplay (ECS, node ticks, scripts/behaviors,
 * keyframe clips, fixed-step physics). This is the Unity `Time.timeScale`
 * model:
 *
 *   - `scale === 1`  → normal speed
 *   - `scale < 1`    → slow motion
 *   - `scale === 0`  → fully frozen (hitstop); the frame still renders, so the
 *                      freeze is visible.
 *
 * Its own timers (hitstop countdown, slow-motion blend/hold) advance on the
 * REAL (unscaled) delta passed to {@link advance}, so they keep ticking — and
 * can expire — even while the game itself is frozen. Exposed to scripts as
 * `this.scene.time`; the "juicy hit" recipe is `scene.time.hitstop(80)`.
 */
export interface SlowMotionOptions {
  /**
   * Real-time milliseconds to hold at the target scale before automatically
   * blending back to 1. Omit for an open-ended slow-mo that persists until
   * {@link GameTime.reset} / {@link GameTime.setScale}.
   */
  durationMs?: number;
  /** Real-time milliseconds to ease in (and, when auto-releasing, ease out). */
  blendMs?: number;
}

const DEFAULT_BLEND_MS = 150;
const DEFAULT_SLOW_SCALE = 0.3;

/** ~0.5 s at 60 fps: long past any legitimate burst of distinct hits. */
const HITSTOP_STREAK_WARN_FRAMES = 30;

export class GameTime {
  /** Effective multiplier applied to gameplay dt this frame (0..∞). */
  private effectiveScale = 1;

  // Blended "base" scale (slow-mo), independent of hitstop.
  private blendedScale = 1;
  private blendFrom = 1;
  private blendTo = 1;
  private blendDurationSec = 0;
  private blendElapsedSec = 0;

  // Auto-release (hold-at-target then blend back to 1) bookkeeping.
  private autoRelease = false;
  private holdRemainingSec = Infinity;
  private releaseBlendSec = 0;

  // Hitstop overrides the base scale with 0 while active.
  private hitstopRemainingSec = 0;
  /**
   * Longest single request honoured by the freeze in progress; 0 while unfrozen. A re-request no
   * longer than this cannot push the end of the freeze further away — see {@link hitstop}.
   */
  private hitstopWindowSec = 0;

  // Every-frame-caller detection (see the warning in `hitstop`).
  private frameIndex = 0;
  private lastHitstopFrame = -1;
  private hitstopFrameStreak = 0;
  private warnedAboutHitstopStreak = false;

  /** The multiplier gameplay dt is scaled by this frame. */
  get scale(): number {
    return this.effectiveScale;
  }

  /**
   * The slow-motion base scale EXCLUDING hitstop. While a hitstop freeze is
   * active {@link scale} is 0 but `baseScale` stays at the blended slow-mo
   * value — use this for state that must not react to micro-freezes (e.g. the
   * audio muffle snapshot), so an 80 ms hitstop never pumps the filter.
   */
  get baseScale(): number {
    return Math.max(0, this.blendedScale);
  }

  /** True while a hitstop freeze is active. */
  get isFrozen(): boolean {
    return this.hitstopRemainingSec > 0;
  }

  /**
   * Freeze the game (scale → 0) for `ms` of real time. Overlapping calls take the LONGEST SINGLE
   * request, so rapid hits don't cut each other short — but a request no longer than the one that
   * started the current freeze cannot postpone its end.
   *
   * That last clause is load-bearing, not a detail. "Longest *pending*" (what this used to do)
   * deadlocks: a script that calls `scene.time.hitstop(50)` every frame from `onUpdate` while an
   * overlap lasts re-arms the freeze faster than it drains, gameplay dt stays 0, so the contact
   * that triggers the call can never separate — the game is frozen for good, and `GameTime` looks
   * innocent in isolation because each individual call is correct. Capping one continuous freeze at
   * the longest request that started it makes the freeze always expire; the misbehaving script then
   * merely slows the game down instead of stopping it, and says so in the console.
   *
   * The trade is deliberate: a second hit of the SAME strength during a freeze no longer extends it.
   * Without a per-hit identity there is no way to tell that apart from the same hit re-arming, and
   * one is a bug while the other is 30 ms of juice.
   */
  hitstop(ms: number): void {
    const seconds = Number.isFinite(ms) ? Math.max(0, ms) / 1000 : 0;
    this.noteHitstopRequest();
    if (seconds <= 0) return;

    if (this.hitstopRemainingSec > 0) {
      // Already frozen: only a strictly stronger hit may extend the window.
      if (seconds > this.hitstopWindowSec) {
        this.hitstopRemainingSec = seconds;
        this.hitstopWindowSec = seconds;
      }
      return;
    }

    this.hitstopRemainingSec = seconds;
    this.hitstopWindowSec = seconds;
  }

  /**
   * Ease into `scale` over `blendMs`, optionally hold for `durationMs` of real
   * time and then ease back to 1. With no duration the slow-mo persists until
   * {@link reset} / {@link setScale}.
   */
  slowMotion(scale: number, options: SlowMotionOptions = {}): void {
    const target = this.sanitizeScale(scale, DEFAULT_SLOW_SCALE);
    const blendSec = this.sanitizeMs(options.blendMs, DEFAULT_BLEND_MS) / 1000;
    this.startBlend(target, blendSec);

    if (options.durationMs != null && Number.isFinite(options.durationMs)) {
      this.autoRelease = true;
      this.holdRemainingSec = Math.max(0, options.durationMs) / 1000;
      this.releaseBlendSec = blendSec;
    } else {
      this.autoRelease = false;
      this.holdRemainingSec = Infinity;
    }
  }

  /** Snap the base scale immediately (no blend), cancelling any auto-release. */
  setScale(scale: number): void {
    const next = this.sanitizeScale(scale, 1);
    this.blendedScale = next;
    this.blendFrom = next;
    this.blendTo = next;
    this.blendDurationSec = 0;
    this.blendElapsedSec = 0;
    this.autoRelease = false;
    this.holdRemainingSec = Infinity;
    this.updateEffective();
  }

  /** Restore normal speed and clear any hitstop / slow-mo. */
  reset(): void {
    this.hitstopRemainingSec = 0;
    this.hitstopWindowSec = 0;
    this.lastHitstopFrame = -1;
    this.hitstopFrameStreak = 0;
    this.setScale(1);
  }

  /**
   * Advance internal timers by the REAL frame delta and recompute {@link scale}.
   * Called once per frame by {@link SceneRunner} before it scales gameplay dt.
   */
  advance(realDtSec: number): void {
    const dt = Number.isFinite(realDtSec) && realDtSec > 0 ? realDtSec : 0;
    this.frameIndex += 1;

    if (this.hitstopRemainingSec > 0) {
      this.hitstopRemainingSec = Math.max(0, this.hitstopRemainingSec - dt);
      if (this.hitstopRemainingSec === 0) {
        this.hitstopWindowSec = 0;
      }
    }

    // Progress the active blend toward blendTo.
    if (this.blendElapsedSec < this.blendDurationSec) {
      this.blendElapsedSec = Math.min(this.blendDurationSec, this.blendElapsedSec + dt);
      const f = this.blendDurationSec > 0 ? this.blendElapsedSec / this.blendDurationSec : 1;
      this.blendedScale = this.blendFrom + (this.blendTo - this.blendFrom) * f;
    } else {
      this.blendedScale = this.blendTo;
    }

    const blendComplete = this.blendElapsedSec >= this.blendDurationSec;

    // Auto-release: once the slow-mo target is reached, hold then return to 1.
    if (this.autoRelease && blendComplete && this.blendTo !== 1) {
      this.holdRemainingSec -= dt;
      if (this.holdRemainingSec <= 0) {
        this.autoRelease = false;
        this.holdRemainingSec = Infinity;
        this.startBlend(1, this.releaseBlendSec);
      }
    }

    this.updateEffective();
  }

  /**
   * Track how many frames in a row asked for a freeze. One warning per instance: the deadlock this
   * guards against used to be invisible (a frozen game and a correct-looking `GameTime`), and the
   * fix belongs in the calling script, which is the only place that knows the contact is the same
   * one as last frame.
   */
  private noteHitstopRequest(): void {
    this.hitstopFrameStreak =
      this.lastHitstopFrame >= this.frameIndex - 1 ? this.hitstopFrameStreak + 1 : 1;
    this.lastHitstopFrame = this.frameIndex;

    if (this.hitstopFrameStreak >= HITSTOP_STREAK_WARN_FRAMES && !this.warnedAboutHitstopStreak) {
      this.warnedAboutHitstopStreak = true;
      console.warn(
        `[GameTime] hitstop() has been called on ${this.hitstopFrameStreak} consecutive frames. ` +
          'Hitstop is edge-triggered juice: call it once when a contact BEGINS (a signal handler, ' +
          'or a "was overlapping last frame" guard), not every frame while an overlap lasts. ' +
          'Requests during a freeze are ignored, so the game runs slowly instead of freezing.'
      );
    }
  }

  private startBlend(target: number, durationSec: number): void {
    this.blendFrom = this.blendedScale;
    this.blendTo = target;
    this.blendDurationSec = Math.max(0, durationSec);
    this.blendElapsedSec = 0;
    if (this.blendDurationSec === 0) {
      this.blendedScale = target;
    }
    this.updateEffective();
  }

  private updateEffective(): void {
    this.effectiveScale = this.hitstopRemainingSec > 0 ? 0 : Math.max(0, this.blendedScale);
  }

  private sanitizeScale(value: number, fallback: number): number {
    if (!Number.isFinite(value) || value < 0) {
      return fallback;
    }
    return value;
  }

  private sanitizeMs(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return fallback;
    }
    return value;
  }
}
