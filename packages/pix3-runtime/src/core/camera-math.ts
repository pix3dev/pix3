/**
 * Shared camera framing math, used by both {@link ../nodes/3D/VirtualCamera3D}
 * and {@link ../nodes/2D/Camera2D}. All pure functions — no allocation, no state.
 */

/** Frame-rate-independent damping factor: `1 - e^(-k·dt)`, clamped to [0, 1]. */
export function dampingAlpha(smoothing: number, dt: number): number {
  if (smoothing <= 0 || dt <= 0) {
    return 1;
  }
  const alpha = 1 - Math.exp(-smoothing * dt);
  return alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
}

/**
 * Deadzone goal: keep `current` until the target exits the half-extent, then
 * chase so the target rests at the box edge.
 */
export function deadzoneGoal(current: number, desired: number, halfExtent: number): number {
  const error = desired - current;
  if (Math.abs(error) <= halfExtent) {
    return current;
  }
  return error > 0 ? desired - halfExtent : desired + halfExtent;
}

/** Clamp `value` to `[center - halfExtent, center + halfExtent]`. */
export function clampRange(value: number, center: number, halfExtent: number): number {
  const min = center - halfExtent;
  const max = center + halfExtent;
  return value < min ? min : value > max ? max : value;
}
