/**
 * Runtime time contract (§5.1 of `.plans/agent-gameplay-testing.md`).
 *
 * Describes *how the frame driver produces ticks* — wall-clock, a fixed virtual
 * step, or nothing at all until someone asks. It is deliberately separate from
 * {@link GameTime}, which scales gameplay dt (hitstop / slow-mo) on top of
 * whatever the driver handed out: a game may be in slow motion while the driver
 * runs eight fixed ticks per animation frame, and the two compose.
 *
 * The owner of the config is {@link SceneRunner} (it owns the loop); hosts only
 * forward values into it. Exported builds carry the API too — the default mode
 * is `'realtime'`, so a shipped game behaves exactly as it did before.
 */

/**
 * - `realtime` — one tick per animation frame, dt from the wall clock. Default.
 * - `fixed` — `ticksPerFrame` ticks of exactly `fixedDeltaSec` per animation
 *   frame. Deterministic and, with `ticksPerFrame > 1`, faster than wall clock.
 * - `manual` — no animation frame is ever scheduled; ticks come only from
 *   `SceneRunner.stepFrames()`. Frame-by-frame debugging, and the only mode that
 *   keeps running at full speed in a background tab (no rAF throttling).
 */
export type RuntimeTimeMode = 'realtime' | 'fixed' | 'manual';

export interface RuntimeTimeConfig {
  mode: RuntimeTimeMode;
  /** Tick duration in `'fixed'` / `'manual'`. Defaults to 1/60. */
  fixedDeltaSec?: number;
  /** Ticks per animation frame in `'fixed'` (the speed-up). Defaults to 1. */
  ticksPerFrame?: number;
  /**
   * Render once every N ticks. Omitted, it resolves to `ticksPerFrame` in
   * `'fixed'` (one paint per batch — the point of a speed-up is to skip paints)
   * and to 1 everywhere else.
   */
  renderEveryNTicks?: number;
  /** Silence the master bus outside `'realtime'`. Defaults to true. */
  muteAudio?: boolean;
}

/** A {@link RuntimeTimeConfig} with every field resolved and validated. */
export type ResolvedRuntimeTimeConfig = Required<RuntimeTimeConfig>;

/** Tick duration used when a config omits `fixedDeltaSec`. */
export const DEFAULT_FIXED_DELTA_SEC = 1 / 60;

/**
 * Upper clamp for `ticksPerFrame`. 240 ticks of 1/60 s is four seconds of game
 * time per animation frame — past that a single frame blocks the main thread
 * long enough that the host looks hung, which is worse than a slower test.
 */
export const MAX_TICKS_PER_FRAME = 240;

/** The mode every runner starts in: indistinguishable from the pre-contract loop. */
export const DEFAULT_RUNTIME_TIME_CONFIG: ResolvedRuntimeTimeConfig = Object.freeze({
  mode: 'realtime',
  fixedDeltaSec: DEFAULT_FIXED_DELTA_SEC,
  ticksPerFrame: 1,
  renderEveryNTicks: 1,
  muteAudio: true,
});

function isRuntimeTimeMode(value: unknown): value is RuntimeTimeMode {
  return value === 'realtime' || value === 'fixed' || value === 'manual';
}

/**
 * Validate + fill in a caller-supplied config.
 *
 * Hard failures (throw, so the caller's state is left untouched): an unknown
 * `mode`, and a `fixedDeltaSec` that is not a finite positive number — a zero or
 * negative step is not a slower game, it is a frozen or time-reversed one, and
 * silently clamping it would hide the caller's bug behind a plausible run.
 *
 * Soft failures (clamped, because every value in range is a legitimate run):
 * `ticksPerFrame` to 1..{@link MAX_TICKS_PER_FRAME}, `renderEveryNTicks` to >= 1.
 *
 * Omitted fields fall back to {@link DEFAULT_RUNTIME_TIME_CONFIG}, not to the
 * currently active config — a `setTimeMode` call replaces the contract whole, so
 * `{ mode: 'realtime' }` always means plain realtime and never inherits a stale
 * `ticksPerFrame` from a previous fixed-mode run.
 */
export function resolveRuntimeTimeConfig(config: RuntimeTimeConfig): ResolvedRuntimeTimeConfig {
  if (!config || !isRuntimeTimeMode(config.mode)) {
    throw new TypeError(
      `[RuntimeTime] mode must be one of 'realtime' | 'fixed' | 'manual' (got ${String(config?.mode)}).`
    );
  }

  const rawDelta = config.fixedDeltaSec;
  let fixedDeltaSec = DEFAULT_FIXED_DELTA_SEC;
  if (rawDelta !== undefined) {
    if (typeof rawDelta !== 'number' || !Number.isFinite(rawDelta) || rawDelta <= 0) {
      throw new RangeError(
        `[RuntimeTime] fixedDeltaSec must be a finite number > 0 (got ${String(rawDelta)}).`
      );
    }
    fixedDeltaSec = rawDelta;
  }

  const ticksPerFrame = clampInteger(config.ticksPerFrame, 1, 1, MAX_TICKS_PER_FRAME);
  const renderDefault = config.mode === 'fixed' ? ticksPerFrame : 1;
  const renderEveryNTicks = clampInteger(
    config.renderEveryNTicks,
    renderDefault,
    1,
    Number.MAX_SAFE_INTEGER
  );

  return {
    mode: config.mode,
    fixedDeltaSec,
    ticksPerFrame,
    renderEveryNTicks,
    muteAudio: config.muteAudio ?? true,
  };
}

/** Round + clamp, treating `undefined` and non-finite input as `fallback`. */
function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
