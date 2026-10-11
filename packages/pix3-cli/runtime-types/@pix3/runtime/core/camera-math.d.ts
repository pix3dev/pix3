/**
 * Shared camera framing math, used by both {@link ../nodes/3D/VirtualCamera3D}
 * and {@link ../nodes/2D/Camera2D}. All pure functions — no allocation, no state.
 */
/** Frame-rate-independent damping factor: `1 - e^(-k·dt)`, clamped to [0, 1]. */
export declare function dampingAlpha(smoothing: number, dt: number): number;
/**
 * Deadzone goal: keep `current` until the target exits the half-extent, then
 * chase so the target rests at the box edge.
 */
export declare function deadzoneGoal(current: number, desired: number, halfExtent: number): number;
/** Clamp `value` to `[center - halfExtent, center + halfExtent]`. */
export declare function clampRange(value: number, center: number, halfExtent: number): number;
