import { NodeBase } from '../nodes/NodeBase';
import { type KeyframeEasing } from '../animation/easing';
import type { SceneService } from './SceneService';
/**
 * Godot-style tweens, reachable from scripts as `this.scene.tween`.
 *
 * A tween is the "move this number to that number over time" primitive the juice
 * API deliberately leaves out: `scene.juice.*` plays fixed, pre-tuned effects,
 * while a tween interpolates whatever the game names.
 *
 * ```ts
 * this.scene.tween.to(this.node, { y: 240, scale: 1.2 }, { durationSec: 0.25, ease: 'backOut' });
 * await this.scene.tween.fadeOut('game-over-panel', 0.4).finished;
 * ```
 *
 * Lifecycle, mirroring the transient juice nodes:
 * - ticked on **scaled** game time (`SceneRunner` → {@link SceneService.updateTweens}),
 *   so a hitstop freezes a tween mid-flight and slow-mo stretches it;
 * - no scene node and nothing to author — a tween is pure bookkeeping;
 * - dropped wholesale when the scene stops or changes
 *   ({@link SceneService.clearTweens}), so a closure can never outlive its graph.
 */
/**
 * What a tween animates: a node, a node query (id / name / path), or any plain
 * object. Property paths are resolved dynamically, so the object side is `object`
 * rather than a shape — the per-path checks in `addChannel` are the real guard.
 */
export type TweenTarget = NodeBase | string | object;
/** How a tween ended. {@link TweenHandle.finished} resolves with this and never rejects. */
export type TweenEndReason = 'completed' | 'cancelled';
/** A two-component end value (`position`, `scale`, …). Missing axes are left alone. */
export interface TweenVectorValue {
    x?: number;
    y?: number;
    z?: number;
}
/**
 * End values keyed by property.
 *
 * For a node the following keys are understood as shorthands, and everything else
 * is a (dotted) property path on the node itself:
 *
 * | key | writes |
 * | --- | --- |
 * | `x` / `y` | `position.x` / `position.y` |
 * | `position` | `{x,y}` → `position.x` / `position.y` |
 * | `scale` | a number scales x and y uniformly; `{x,y}` per axis |
 * | `rotation` | `rotation.z`, in RADIANS |
 * | `opacity` | `Node2D`/`Node3D` `opacity` (the accessor, so materials refresh) |
 * | `width` / `height` | the node's own `width` / `height` (the reactive setter, so it redraws) |
 *
 * For a plain object every key is a (dotted) path on the object, and a `{x,y,z}`
 * value expands into `<path>.x` / `<path>.y` / `<path>.z`.
 */
export type TweenProps = Record<string, number | TweenVectorValue | undefined>;
export interface TweenOptions {
    /** Seconds one iteration takes (default `0.3`). */
    durationSec?: number;
    /** Easing curve name (default `'cubicOut'`). See {@link KeyframeEasing}. */
    ease?: KeyframeEasing;
    /** Seconds to wait before the first iteration; end values are captured after it (default `0`). */
    delaySec?: number;
    /** Alternate direction on every other iteration — needs {@link repeat} (default `false`). */
    yoyo?: boolean;
    /** Extra iterations after the first; `-1` repeats forever (default `0`). */
    repeat?: number;
    /** Called every tick with the current (un-eased, direction-aware) progress 0..1. */
    onUpdate?: (t: number) => void;
    /** Called once when the tween completes on its own. Not called on `cancel()`. */
    onComplete?: () => void;
}
/** Control surface for a running tween. */
export interface TweenHandle {
    /** Stop immediately, leaving the target wherever it is. Resolves `finished` as `'cancelled'`. */
    cancel(): void;
    /** Resolves when the tween ends. Never rejects. */
    readonly finished: Promise<TweenEndReason>;
    /** False once the tween has completed or been cancelled. */
    readonly isRunning: boolean;
}
/** Options for {@link TweenApi.fadeOut}. */
export interface TweenFadeOutOptions {
    /** Set `visible = false` once the fade lands on 0 (default `true`). */
    hide?: boolean;
}
/**
 * `this.scene.tween` — see the module doc for the lifecycle rules.
 */
export declare class TweenApi {
    private readonly scene;
    private readonly active;
    private readonly warned;
    constructor(scene: SceneService);
    /** Tweens currently running (including ones still inside their delay). */
    get activeCount(): number;
    /**
     * Interpolate `props` on `target` over `options.durationSec`.
     *
     * ```ts
     * this.scene.tween.to(ball, { x: 300, opacity: 0 }, { durationSec: 0.5, ease: 'quadInOut' });
     * this.scene.tween.to('hud/score', { scale: 1.3 }, { durationSec: 0.12, yoyo: true, repeat: 1 });
     * ```
     *
     * An unresolvable node query warns once and returns an inert handle — a renamed
     * node must not turn into a silent no-op the way an ignored `null` would.
     */
    to(target: TweenTarget, props: TweenProps, options?: TweenOptions): TweenHandle;
    /** Fade a node in from fully transparent, making it visible first. */
    fadeIn(target: TweenTarget, durationSec?: number): TweenHandle;
    /** Fade a node out; by default it is hidden once it reaches 0 (so it stops eating taps). */
    fadeOut(target: TweenTarget, durationSec?: number, options?: TweenFadeOutOptions): TweenHandle;
    /**
     * Swap one node for another: `from` fades to 0 and hides, `to` becomes visible and
     * fades up from 0. The returned handle ends when BOTH halves do.
     *
     * ```ts
     * await this.scene.tween.crossFade('menu', 'game-hud', 0.25).finished;
     * ```
     */
    crossFade(from: TweenTarget, to: TweenTarget, durationSec?: number): TweenHandle;
    /**
     * Cancel every tween, or only the ones animating `target`. Cancelled tweens leave
     * their target wherever it is and resolve `finished` as `'cancelled'`.
     */
    killAll(target?: TweenTarget): void;
    /**
     * Advance every running tween. Driven by `SceneRunner` with the SCALED delta via
     * {@link SceneService.updateTweens}, which is what makes a hitstop freeze tweens
     * exactly as it freezes the transient juice nodes.
     */
    update(dt: number): void;
    /** Drop every tween without firing `onComplete`. Called on scene stop / change. */
    cancelAll(): void;
    private resolveTarget;
    /** Complain once when a fade helper is handed something with no `opacity` to fade. */
    private warnOpacityless;
    /** Same rationale as `JuiceApi.warnOnce`: tween calls sit in per-frame gameplay code. */
    private warnOnce;
}
