/**
 * `core:ReplicatedTransform` — moves one bound entity's transform across the wire.
 *
 * **Owner side.** Every send tick it quantizes the node's transform through the room's
 * `WorldQuantizer`, publishes it, and then **writes the dequantized values back onto the node**. The
 * spec is explicit about that last step: "an owning client publishes quantized values and renders
 * its own entity from the same dequantized values, so nobody chases divergence pops". The round trip
 * is a fixed point (requantizing a dequantized value lands on the same integer), so the write-back
 * costs at most one quantum — 1/16 unit in the default 4096 world — and buys exact agreement with
 * what every peer sees.
 *
 * **Remote side.** Records go into a snapshot buffer stamped with their arrival time, and the node
 * renders at `now − delay` by interpolating between the two bracketing samples. This is *timed*
 * interpolation, not a per-frame `lerp(current, target, k)`: advancing the clock is what moves the
 * node, so the motion is identical at 30, 60 and 144 fps, and a frame-rate-dependent lerp's
 * "smoothing that is also a variable lag" is gone.
 *
 * The delay is adaptive — roughly **two tick intervals plus measured jitter** (Valve's
 * `cl_interp_ratio 2` rule), with the tick interval read from `WelcomeEvent.TickHz`. Two intervals
 * is the smallest window that still has a *next* sample to interpolate towards after one late
 * arrival; the jitter term buys the rest.
 *
 * The `Teleport` mask bit means **snap**: a respawn or a warp is a discontinuity, and interpolating
 * across it would slide the node through the world instead of putting it where it belongs.
 */
import { Script } from '../core/ScriptComponent';
import type { PropertySchema } from '../fw/property-schema';
/** Which two world axes the wire's X/Y drive. */
export type ReplicatedPlane = 'xy' | 'xz';
export declare class ReplicatedTransformBehavior extends Script {
    /** Clock for arrival stamps and the render cursor. Overridable so a test can drive it. */
    timeSource: () => number;
    private boundNetId;
    private listener;
    private sendAccumulatorMs;
    private readonly buffer;
    private lastArrivalMs;
    private jitterMs;
    /** Set by a `Teleport` record; consumed by the next render. */
    private snapPending;
    private readonly scratchSnap;
    constructor(id: string, type: string);
    static getPropertySchema(): PropertySchema;
    /** The bound entity, or `0`. */
    get netId(): number;
    /** True when this client publishes this transform rather than interpolating it. */
    get isOwner(): boolean;
    /** The interpolation delay in effect, in ms — the configured one, or the adaptive estimate. */
    get interpolationDelayMs(): number;
    /** How many samples the receive buffer is holding. */
    get bufferedSampleCount(): number;
    /**
     * Moves an owned entity discontinuously — a respawn, a warp. Sets the node, publishes with the
     * `Teleport` bit, and renders the dequantized result, so every peer snaps instead of sliding.
     */
    teleportTo(x: number, y: number, rotation?: number): void;
    onStart(): void;
    onUpdate(dt: number): void;
    onDetach(): void;
    private tickOwner;
    private publishFromNode;
    private tickRemote;
    /** Keeps one sample older than the render cursor — it is the `from` end of the interpolation. */
    private trimBuffer;
    private handleChange;
    private rebind;
    private get plane();
    private readNodePosition;
    private readNodeRotation;
    private writeNodeTransform;
    private get tickIntervalMs();
    private get network();
    private get binder();
}
