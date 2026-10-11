import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
export interface ShakeOptions {
    /** Peak positional displacement, in the node's local units. */
    amplitude?: number;
    /** Oscillation speed (higher = faster jitter). */
    frequency?: number;
    /** Duration in seconds. `0` shakes until stopped. */
    duration?: number;
    /** Falloff power applied to `(1 - progress)`; `0` = no decay, `1` = linear. */
    decay?: number;
}
/**
 * Smooth-noise positional shake, additive over whatever else drives the node's
 * position (e.g. a FollowBehavior). Because it is ticked through `node.tick`, it
 * automatically respects the global `Time.scale` — a hitstop freezes the shake,
 * slow-mo stretches it. Reusable two ways (P0.3):
 *
 *  - **Preset** (`core:Shake`): attach in the inspector, drive on a node signal
 *    via `triggerEvent`, or auto-start with `playOnStart`.
 *  - **Script API**: `scene.juice.shake(node, { amplitude, frequency, ... })`.
 *
 * The offset is removed and re-applied each frame (never accumulated), so it
 * composes with other position writers and always restores cleanly on stop.
 * When shaking a followed camera, attach this after the follower for the least
 * smoothing coupling.
 */
export declare class ShakeBehavior extends Script {
    private active;
    private elapsed;
    private readonly appliedOffset;
    private readonly onTriggerSignal;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    onStart(): void;
    onDetach(): void;
    /** Configure (partial) and (re)start the shake. Used by the juice API. */
    play(options?: ShakeOptions): void;
    /** (Re)start the shake from the beginning. */
    trigger(): void;
    /** Stop shaking and restore the node's position. */
    stop(): void;
    onUpdate(dt: number): void;
    private restore;
    private bindTrigger;
    private unbindTrigger;
    private getAmplitude;
    private getFrequency;
    private getDuration;
    private getDecay;
    private getTriggerEvent;
    private setTriggerEvent;
    private static num;
}
/**
 * Smooth pseudo-random value in ~[-1, 1] from a sum of incommensurate sines.
 * Deterministic (no Math.random), continuous over time, and decorrelated per
 * axis via the `seed` offset — so shakes look organic and replay identically.
 * Exported so other shake-driven nodes (e.g. {@link ../nodes/2D/Camera2D})
 * reuse the exact same deterministic noise.
 */
export declare function shakeNoise(t: number, seed: number): number;
