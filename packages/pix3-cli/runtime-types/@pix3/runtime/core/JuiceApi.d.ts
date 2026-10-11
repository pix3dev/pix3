import { NodeBase } from '../nodes/NodeBase';
import { ShakeBehavior, type ShakeOptions } from '../behaviors/ShakeBehavior';
import { PunchScaleBehavior, type PunchScaleOptions } from '../behaviors/PunchScaleBehavior';
import { PopInBehavior, type PopInOptions } from '../behaviors/PopInBehavior';
import { FloatText2D, ParticleBurst2D, type BurstOptions, type FloatTextStyleOptions, type JuicePoint2D } from './juice-transients';
import { Trail2D, type TrailOptions } from './trail-2d';
import type { SceneService } from './SceneService';
import type { FlashOptions } from './SceneService';
/**
 * Target of a juice effect: a node instance, a node query (id / name / path),
 * the literal `'camera'` to hit the active 3D camera (falling back to the active
 * 2D camera in pure-2D scenes), or `'camera2d'` to hit the active 2D camera.
 */
export type JuiceTarget = NodeBase | string;
/** Where a transient 2D effect appears: a node, a node query, or a 2D world point. */
export type JuiceAnchor = JuiceTarget | JuicePoint2D;
/** Options for {@link JuiceApi.floatText} — the style fields plus a spawn anchor. */
export interface FloatTextOptions extends FloatTextStyleOptions {
    /**
     * Node / node query / 2D world point the popup spawns at. Omitted spawns it at
     * the host root's origin (screen centre in a camera-less 2D scene).
     */
    at?: JuiceAnchor;
}
/**
 * Fire-and-forget "juice" primitives, reachable from scripts as
 * `this.scene.juice` (P0.3). Each transform effect is backed by the same
 * `core:*` behavior a designer can attach in the inspector, so calling the API
 * and dropping a preset produce identical results. The effect component is
 * created once per node and reused across calls (no per-call allocation, no
 * pile-up), and — being ticked through `node.tick` — respects the global
 * `Time.scale` (hitstop freezes it, slow-mo stretches it).
 *
 * The classic "juicy hit" is three calls:
 * ```ts
 * this.scene.time.hitstop(80);
 * this.scene.juice.shake('camera', { amplitude: 12 });
 * this.scene.juice.flash();
 * ```
 *
 * {@link burst} and {@link floatText} work differently from the transform
 * effects: instead of a reusable component on an existing node they spawn a
 * short-lived 2D node that frees itself (see `./juice-transients`).
 */
export declare class JuiceApi {
    private readonly scene;
    /** Monotonic id source for spawned transients (burst / floatText). */
    private transientCounter;
    /** Targets already complained about; see {@link warnOnce}. */
    private readonly warned;
    constructor(scene: SceneService);
    /**
     * Smooth positional shake on a node (or the active camera via `'camera'` /
     * `'camera2d'`). The 2D camera has its own built-in additive shake (not a
     * `ShakeBehavior` component), so those targets fire-and-forget and return null.
     *
     * **`null` is not a failure signal for the camera targets** — they return it on success too. A
     * shake that found no camera used to be indistinguishable from one that worked, so a scene
     * missing its Camera2D just quietly had no juice and nothing ever said so. It now warns instead
     * (once per target, so a per-frame call cannot flood the log).
     */
    shake(target: JuiceTarget, options?: ShakeOptions): ShakeBehavior | null;
    /** Squash-and-stretch scale punch on a node. */
    punchScale(target: JuiceTarget, options?: PunchScaleOptions): PunchScaleBehavior | null;
    /** Spawn pop-in: scale a node from `from`× up to its authored scale. */
    popIn(target: JuiceTarget, options?: PopInOptions): PopInBehavior | null;
    /** Full-screen impact flash (see {@link SceneService.flash}). */
    flash(options?: FlashOptions): void;
    /**
     * One-shot 2D particle burst at a node (or a 2D world point). A transient
     * play-mode visual: it spawns into the 2D tree, animates through `node.tick`
     * (so a hitstop freezes it), and frees itself when the last particle dies —
     * nothing to author, nothing to clean up.
     *
     * ```ts
     * this.scene.juice.burst('bumper-a');                                  // already juicy
     * this.scene.juice.burst(ball, { colors: ['#ffcf33', '#ff4d6d'], count: 24 });
     * this.scene.juice.burst({ x: 0, y: -220 }, { spread: Math.PI / 3, speed: 500 });
     * ```
     *
     * Returns null when the target cannot be resolved or the scene has no 2D node
     * to host the effect.
     */
    burst(target: JuiceAnchor, options?: BurstOptions): ParticleBurst2D | null;
    /**
     * Floating text popup ("+100", "MISS!", a combo counter). Same transient
     * lifecycle as {@link burst}: pops in, rises, fades, frees itself — and never
     * takes part in picking, so a popup drifting over a button can't eat the tap.
     *
     * ```ts
     * this.scene.juice.floatText('+100', { at: 'bumper-a', color: '#ffcf33', glow: true });
     * ```
     */
    floatText(text: string, options?: FloatTextOptions): FloatText2D | null;
    /**
     * A fading motion ribbon that follows a node — the "this thing is fast" read a
     * ball, a dash or a projectile gets for one line of script.
     *
     * Same transient lifecycle as {@link burst}: a runtime-only 2D node spawned into
     * the target's 2D root, ticked through `node.tick` (so a hitstop freezes it) and
     * never pickable. It keeps following until `trail.stop()`, then fades out over
     * `lifeSec` and frees itself; freeing the target does the same.
     *
     * ```ts
     * this.trail = this.scene.juice.trail(this.node, { colors: ['#ffcf33', '#ff4d6d'], widthPx: 18 });
     * // ... later, when the ball is gone:
     * this.trail?.stop();
     * ```
     *
     * Returns null when the target cannot be resolved or the scene has no 2D node to
     * host the ribbon.
     */
    trail(target: JuiceTarget, options?: TrailOptions): Trail2D | null;
    /**
     * The node a transient effect is anchored to: the resolved node, `null` for a
     * literal point (no node involved), or `undefined` when a query missed — which
     * the callers turn into a null return.
     */
    private resolveAnchorNode;
    /**
     * The 2D node a transient effect is parented to. Anchored effects go to the
     * TOP-MOST `Node2D` ancestor of their anchor: that keeps them in the anchor's
     * band (a HUD anchor keeps its popup in the un-bloomed `CanvasLayer2D` overlay)
     * and, being the last child of a root, they paint above that root's content
     * without touching anyone's `zIndex`. It also decouples their lifetime from the
     * anchor — a burst outlives the brick it was spawned on.
     *
     * Unanchored effects fall back to the last 2D root that is NOT a CanvasLayer2D
     * (game content, so they bloom), or any 2D root when the scene is HUD-only.
     */
    private resolve2DHost;
    /** Anchor position expressed in the host's local space (the spawn position). */
    private resolveHostLocalPoint;
    private nextTransientId;
    private resolveNode;
    /**
     * Log a given complaint once per key.
     *
     * Juice calls sit in gameplay code and run every frame; an un-deduplicated warning would bury the
     * console (and the agent-facing log channel) under thousands of identical lines, which is the
     * same "noise trains you to ignore it" failure as staying silent, only louder.
     */
    private warnOnce;
}
