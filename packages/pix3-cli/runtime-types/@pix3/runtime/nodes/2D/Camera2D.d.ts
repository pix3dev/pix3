import { Vector2 } from 'three';
import { Node2D, type Node2DProps } from '../Node2D';
import { NodeBase } from '../NodeBase';
import type { PropertySchema } from '../../fw/property-schema';
import { type ShakeOptions } from '../../behaviors/ShakeBehavior';
/** Default configuration values for a freshly created 2D camera. */
export declare const CAMERA2D_DEFAULTS: {
    readonly priority: 10;
    readonly zoom: 1;
    readonly followDamping: 8;
    readonly shakeAmplitude: 8;
    readonly shakeFrequency: 24;
    readonly shakeDuration: 0.35;
    readonly shakeDecay: 1.5;
};
/** Framing solved for the current frame by {@link Camera2D.computeView}. */
export interface Camera2DView {
    x: number;
    y: number;
    zoom: number;
}
export interface Camera2DProps extends Omit<Node2DProps, 'type'> {
    priority?: number;
    zoom?: number;
    offset?: {
        x: number;
        y: number;
    };
    followTargetId?: string;
    followDamping?: number;
    followOffset?: {
        x: number;
        y: number;
    };
    deadzone?: {
        x: number;
        y: number;
    };
    limitsEnabled?: boolean;
    limitsCenter?: {
        x: number;
        y: number;
    };
    limitsSize?: {
        x: number;
        y: number;
    };
    shakeAmplitude?: number;
    shakeFrequency?: number;
    shakeDuration?: number;
    shakeDecay?: number;
}
/**
 * A 2D game camera (Godot-style `Camera2D`). Like {@link ../3D/VirtualCamera3D}
 * it does NOT render — it *describes* how the shared 2D orthographic pass should
 * be framed. Each frame {@link SceneRunner} picks the highest-priority visible
 * `Camera2D` (see {@link findActiveCamera2D}) and applies its {@link computeView}
 * (pan / zoom / clamped limits) plus its {@link getShakeOffset} to the ortho
 * camera. With no `Camera2D` in the scene the 2D pass keeps its default identity
 * framing, so existing 2D scenes / playable ads are unaffected.
 *
 * Every knob is a flat property-schema entry, so the keyframe timeline animates
 * `position`, `offset`, `zoom`, `priority`, etc. with no animation code —
 * switching cameras is "raise this one's priority above that one".
 *
 * Solving is driven by the runtime tick (play mode only): {@link tick} calls
 * {@link solve} on the running clone, so the authored graph is never mutated and
 * the editor viewport (which owns its own free-navigation ortho camera) is
 * unaffected. Shake is advanced in the tick too, so it respects the global
 * `Time.scale` — a hitstop freezes it, slow-mo stretches it.
 *
 * NOTE (v1): screen-anchored HUD shares the same ortho camera and therefore pans
 * / zooms with the world. A `CanvasLayer2D` (routed to a separate fixed overlay
 * camera) is the intended way to pin a HUD; this node never touches that camera.
 */
export declare class Camera2D extends Node2D {
    private priorityValue;
    private zoomValue;
    private readonly offset;
    private followTargetId;
    private followDampingValue;
    private readonly followOffset;
    private readonly deadzone;
    private limitsEnabledValue;
    private readonly limitsCenter;
    private readonly limitsSize;
    private shakeAmplitudeValue;
    private shakeFrequencyValue;
    private shakeDurationValue;
    private shakeDecayValue;
    private shakeActive;
    private shakeElapsed;
    private readonly shakeOffset;
    private readonly scratchWorld;
    private readonly scratchTarget;
    private readonly scratchLocal;
    constructor(props: Camera2DProps);
    get priority(): number;
    set priority(value: number);
    get zoom(): number;
    set zoom(value: number);
    get limitsEnabled(): boolean;
    set limitsEnabled(value: boolean);
    tick(dt: number): void;
    /**
     * Advance the camera one frame: damp toward the follow target (if any), then
     * advance the shake envelope. Mutates the node's own transform (so a gizmo
     * tracks the target) but never touches the ortho camera — {@link computeView}
     * / {@link getShakeOffset} apply the result at render time. Runs on the running
     * clone only (via {@link tick}), so play-mode isolation is automatic.
     */
    solve(dt: number): void;
    /**
     * Pure framing solve: the clamped world-space center + zoom for a given
     * visible size (the runner's logical camera size). Does NOT include shake.
     * Side-effect-free apart from refreshing this node's world matrix, so it is
     * safe to unit-test without a runner.
     */
    computeView(viewSize: {
        width: number;
        height: number;
    }): Camera2DView;
    /** Last solved additive shake offset (zero when idle). */
    getShakeOffset(out: Vector2): Vector2;
    /** Start (or restart) a shake. Omitted options fall back to authored knobs. */
    shake(options?: ShakeOptions): void;
    /** Stop shaking immediately and clear the offset. */
    stopShake(): void;
    private advanceShake;
    private solveFollow;
    private setWorldPosition2D;
    private resolveTarget;
    serializeConfig(): Record<string, unknown>;
    static getPropertySchema(): PropertySchema;
}
/**
 * Select the active `Camera2D` from a scene tree: the highest-`priority` visible
 * one, first-in-DFS on ties. Returns null when none exist (identity framing).
 */
export declare function findActiveCamera2D(roots: readonly NodeBase[]): Camera2D | null;
