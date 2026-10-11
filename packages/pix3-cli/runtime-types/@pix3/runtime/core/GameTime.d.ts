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
export declare class GameTime {
    /** Effective multiplier applied to gameplay dt this frame (0..∞). */
    private effectiveScale;
    private blendedScale;
    private blendFrom;
    private blendTo;
    private blendDurationSec;
    private blendElapsedSec;
    private autoRelease;
    private holdRemainingSec;
    private releaseBlendSec;
    private hitstopRemainingSec;
    /**
     * Longest single request honoured by the freeze in progress; 0 while unfrozen. A re-request no
     * longer than this cannot push the end of the freeze further away — see {@link hitstop}.
     */
    private hitstopWindowSec;
    private frameIndex;
    private lastHitstopFrame;
    private hitstopFrameStreak;
    private warnedAboutHitstopStreak;
    /** The multiplier gameplay dt is scaled by this frame. */
    get scale(): number;
    /**
     * The slow-motion base scale EXCLUDING hitstop. While a hitstop freeze is
     * active {@link scale} is 0 but `baseScale` stays at the blended slow-mo
     * value — use this for state that must not react to micro-freezes (e.g. the
     * audio muffle snapshot), so an 80 ms hitstop never pumps the filter.
     */
    get baseScale(): number;
    /** True while a hitstop freeze is active. */
    get isFrozen(): boolean;
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
    hitstop(ms: number): void;
    /**
     * Ease into `scale` over `blendMs`, optionally hold for `durationMs` of real
     * time and then ease back to 1. With no duration the slow-mo persists until
     * {@link reset} / {@link setScale}.
     */
    slowMotion(scale: number, options?: SlowMotionOptions): void;
    /** Snap the base scale immediately (no blend), cancelling any auto-release. */
    setScale(scale: number): void;
    /** Restore normal speed and clear any hitstop / slow-mo. */
    reset(): void;
    /**
     * Advance internal timers by the REAL frame delta and recompute {@link scale}.
     * Called once per frame by {@link SceneRunner} before it scales gameplay dt.
     */
    advance(realDtSec: number): void;
    /**
     * Track how many frames in a row asked for a freeze. One warning per instance: the deadlock this
     * guards against used to be invisible (a frozen game and a correct-looking `GameTime`), and the
     * fix belongs in the calling script, which is the only place that knows the contact is the same
     * one as last frame.
     */
    private noteHitstopRequest;
    private startBlend;
    private updateEffective;
    private sanitizeScale;
    private sanitizeMs;
}
