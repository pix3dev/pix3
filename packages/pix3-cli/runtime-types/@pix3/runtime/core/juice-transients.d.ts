import { Node2D, type Node2DProps } from '../nodes/Node2D';
import { Label2D } from '../nodes/2D/UI/Label2D';
/**
 * Transient play-mode visuals behind `scene.juice.burst()` / `scene.juice.floatText()`.
 *
 * These are deliberately NOT authorable node types: no YAML serialization, no
 * editor proxy, no inspector schema. They are spawned into the running 2D tree,
 * live for a fraction of a second, and `queueFree()` themselves — the same
 * lifecycle a one-shot VFX prefab would have, minus the authoring cost.
 *
 * 2D pass rules they must obey (see CLAUDE.md "2D overlay rendering"):
 * - they are `Node2D`s, so `Node2D.add` stamps `LAYER_2D` on their meshes and the
 *   per-frame `assign2DLayers` keeps them in whichever band their host lives in;
 * - materials are `depthTest: false` — paint order comes from the DFS
 *   `renderOrder` walk, so being the LAST child of the host is what puts them on
 *   top (plus `zIndex` when a caller needs more);
 * - canvas textures go through `configure2DTexture` (mipmaps off).
 */
/** A point in 2D world/design space (origin at the design-resolution centre, Y up). */
export interface JuicePoint2D {
    x: number;
    y: number;
}
/** Tuning for {@link ParticleBurst2D} — every field has a "already juicy" default. */
export interface BurstOptions {
    /** Number of particles (1..512, default 14). */
    count?: number;
    /** Initial speed in px/s; each particle gets 55–100% of it (default 260). */
    speed?: number;
    /** Cone width in RADIANS around {@link direction} (default `Math.PI * 2` = all around). */
    spread?: number;
    /** Cone centre in RADIANS (default `Math.PI / 2` = up). Irrelevant at full spread. */
    direction?: number;
    /** Particle lifetime in seconds; each gets 70–130% of it (default 0.5). */
    lifeSec?: number;
    /** Single particle colour (CSS string). Ignored when {@link colors} is set. */
    color?: string;
    /** Palette — each particle picks one at random. */
    colors?: string[];
    /** Particle size in px; each gets 70–130% of it (default 10). */
    sizePx?: number;
    /** Vertical acceleration in px/s² (default -600, i.e. falling sparks; 0 = weightless). */
    gravityY?: number;
    /** Fade particles out over their life (default true). */
    fadeOut?: boolean;
    /** Additive blending — the neon/glow look (default true). False = normal alpha blend. */
    additive?: boolean;
    /** Draw-order override on the spawned node (Godot `z_index`, default 0). */
    zIndex?: number;
}
/** Style/motion tuning for {@link FloatText2D} (the `at` target lives on `JuiceApi`). */
export interface FloatTextStyleOptions {
    /** Text colour (CSS string, default `#ffffff`). */
    color?: string;
    /** Font size in px (default 28). */
    fontSizePx?: number;
    /** Font family (default `Arial`). */
    fontFamily?: string;
    /** Vertical travel in px over the popup's life; negative drifts down (default 60). */
    driftPx?: number;
    /** Total life in seconds (default 0.8). */
    durationSec?: number;
    /** `true` glows in the text colour, a CSS string glows in that colour (default off). */
    glow?: boolean | string;
    /** Glow strength 0..4 when {@link glow} is on (default 1.5). */
    glowStrength?: number;
    /** Draw-order override on the spawned node (Godot `z_index`, default 0). */
    zIndex?: number;
}
/** Hard ceiling on particles per burst — a runaway `count` must not stall a frame. */
export declare const BURST_MAX_PARTICLES = 512;
/**
 * One-shot 2D particle burst: a single quad-batch mesh whose vertices are moved
 * on the CPU each tick (a handful of particles for a fraction of a second, so the
 * per-frame cost is noise), auto-freeing once the last particle dies.
 *
 * Ticked through `node.tick`, so it respects the global `Time.scale` exactly like
 * the other juice effects — a hitstop freezes the sparks mid-air.
 */
export declare class ParticleBurst2D extends Node2D {
    private readonly particles;
    private readonly geometry;
    private readonly positionAttribute;
    private readonly colorAttribute;
    private readonly gravityY;
    private readonly fadeOut;
    private aliveParticles;
    constructor(props: Node2DProps, options?: BurstOptions);
    /** Particles actually allocated (after the {@link BurstOptions.count} clamp). */
    get particleCount(): number;
    /** Particles still moving; 0 means this node has queued itself for freeing. */
    get aliveCount(): number;
    tick(dt: number): void;
    private writeQuad;
    private writeAlpha;
}
/**
 * Floating score/text popup: a transient {@link Label2D} that pops in, rises and
 * fades, then frees itself. Never participates in picking (its hit test is
 * always false), so a popup drifting over a button can't eat the tap.
 */
export declare class FloatText2D extends Label2D {
    private readonly totalDuration;
    private readonly driftPx;
    private elapsed;
    private captured;
    private baseY;
    private baseScaleX;
    private baseScaleY;
    private finished;
    constructor(props: Node2DProps, text: string, options?: FloatTextStyleOptions);
    /** Transient popups are never pickable — see the class doc. */
    isPointInBounds(): boolean;
    tick(dt: number): void;
}
