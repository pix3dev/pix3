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

export class GameTime {
  /** Effective multiplier applied to gameplay dt this frame (0..∞). */
  private effectiveScale = 1;

  // Blended "base" scale (slow-mo), independent of hitstop.
  private baseScale = 1;
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

  /** The multiplier gameplay dt is scaled by this frame. */
  get scale(): number {
    return this.effectiveScale;
  }

  /** True while a hitstop freeze is active. */
  get isFrozen(): boolean {
    return this.hitstopRemainingSec > 0;
  }

  /**
   * Freeze the game (scale → 0) for `ms` of real time. Overlapping calls take
   * the longest pending freeze so rapid hits don't cut each other short.
   */
  hitstop(ms: number): void {
    const seconds = Number.isFinite(ms) ? Math.max(0, ms) / 1000 : 0;
    if (seconds > this.hitstopRemainingSec) {
      this.hitstopRemainingSec = seconds;
    }
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
    this.baseScale = next;
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
    this.setScale(1);
  }

  /**
   * Advance internal timers by the REAL frame delta and recompute {@link scale}.
   * Called once per frame by {@link SceneRunner} before it scales gameplay dt.
   */
  advance(realDtSec: number): void {
    const dt = Number.isFinite(realDtSec) && realDtSec > 0 ? realDtSec : 0;

    if (this.hitstopRemainingSec > 0) {
      this.hitstopRemainingSec = Math.max(0, this.hitstopRemainingSec - dt);
    }

    // Progress the active blend toward blendTo.
    if (this.blendElapsedSec < this.blendDurationSec) {
      this.blendElapsedSec = Math.min(this.blendDurationSec, this.blendElapsedSec + dt);
      const f = this.blendDurationSec > 0 ? this.blendElapsedSec / this.blendDurationSec : 1;
      this.baseScale = this.blendFrom + (this.blendTo - this.blendFrom) * f;
    } else {
      this.baseScale = this.blendTo;
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

  private startBlend(target: number, durationSec: number): void {
    this.blendFrom = this.baseScale;
    this.blendTo = target;
    this.blendDurationSec = Math.max(0, durationSec);
    this.blendElapsedSec = 0;
    if (this.blendDurationSec === 0) {
      this.baseScale = target;
    }
    this.updateEffective();
  }

  private updateEffective(): void {
    this.effectiveScale = this.hitstopRemainingSec > 0 ? 0 : Math.max(0, this.baseScale);
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
