import { Node2D, type Node2DProps } from '../nodes/Node2D';
import { NodeBase } from '../nodes/NodeBase';
/**
 * The motion ribbon behind `scene.juice.trail()`.
 *
 * Same species as `ParticleBurst2D` / `FloatText2D` (see `./juice-transients`): a
 * runtime-only 2D node with no YAML serialization, no editor proxy and no
 * inspector schema. It is spawned into the running 2D tree, animates through
 * `node.tick` (so a hitstop freezes it), and frees itself once it has faded.
 *
 * It differs from the other two in that it FOLLOWS something: every tick it
 * samples the target's world position into a short history and rebuilds a
 * triangle strip through those points, tapering the width and the alpha towards
 * the tail. Points are stored in this node's own local space, so a moving host
 * does not drag the ribbon along with it.
 *
 * 2D pass rules it obeys (CLAUDE.md "2D overlay rendering"): `depthTest: false`
 * with paint order from the DFS `renderOrder` walk, `OVERLAY_2D_FLAG` so it floats
 * above the host's own children, and `frustumCulled = false` because the baked
 * vertex positions leave the bounding sphere stale every frame.
 */
/** Tuning for {@link Trail2D} — every field has a working default. */
export interface TrailOptions {
    /** How long a sampled point survives, in seconds (default 0.35). */
    lifeSec?: number;
    /** Ribbon width at the head, in px; it tapers to 0 at the tail (default 14). */
    widthPx?: number;
    /** Ribbon colour (CSS string), or a palette lerped head→tail. Default `#ffffff`. */
    color?: string | readonly string[];
    /** Palette head→tail. Takes precedence over {@link color} (same shape as `BurstOptions`). */
    colors?: readonly string[];
    /** Additive blending — the neon/glow look (default true). False = normal alpha blend. */
    additive?: boolean;
    /** Draw-order override on the spawned node (Godot `z_index`, default 0). */
    zIndex?: number;
    /** Maximum sampled points; the history is also bounded by {@link lifeSec} (default 48). */
    maxPoints?: number;
}
/** Hard ceiling on sampled points — a runaway `maxPoints` must not stall a frame. */
export declare const TRAIL_MAX_POINTS = 256;
/**
 * A fading ribbon that follows a node. Created by `scene.juice.trail()`; call
 * {@link stop} to let it fade out and free itself.
 */
export declare class Trail2D extends Node2D {
    private readonly points;
    private readonly geometry;
    private readonly positionAttribute;
    private readonly colorAttribute;
    private readonly palette;
    private readonly lifeSec;
    private readonly halfWidth;
    private readonly maxPoints;
    private readonly scratchWorld;
    private readonly scratchColor;
    private target;
    private following;
    private freed;
    constructor(props: Node2DProps, target: NodeBase, options?: TrailOptions);
    /** Points currently in the ribbon; 0 after it has fully faded. */
    get pointCount(): number;
    /** False once {@link stop} was called (or the target went away). */
    get isFollowing(): boolean;
    /**
     * Stop sampling. The ribbon keeps fading for `lifeSec` and then frees itself —
     * a trail on a ball that just despawned should not vanish mid-air.
     */
    stop(): void;
    tick(dt: number): void;
    /** Append the target's current position, in this node's local space, as the new head. */
    private sample;
    /** Rewrite the strip: two vertices per point, width and alpha tapering to the tail. */
    private rebuild;
    /** Palette lookup at `ramp` (0 = head, 1 = tail), written into {@link scratchColor}. */
    private sampleRamp;
}
