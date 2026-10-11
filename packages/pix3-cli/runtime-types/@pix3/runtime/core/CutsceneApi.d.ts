import type { KeyframeEasing } from '../animation/easing';
import type { SceneService } from './SceneService';
/** Options for {@link CutsceneApi.playCinematic}. */
export interface PlayCinematicOptions {
    /** Clip name on the resolved AnimationPlayer (default: the player's own `play()` default). */
    clip?: string;
    /** Seconds of REAL time before the skip gesture arms. Omit ⇒ never skippable; `0` ⇒ armed immediately. */
    skippableAfter?: number;
    /** Seconds; one-shot CameraBrain blend override applied at entry and exit. */
    blendDuration?: number;
    /** Optional easing for the blend override (default: the target vcam's own easing). */
    blendEasing?: KeyframeEasing;
    /** Draw the letterbox bars (default `true`). */
    letterbox?: boolean;
    /** Fraction of viewport height per bar, clamped 0..0.45 (default `0.1`). */
    letterboxSize?: number;
    /** Bar slide-in / slide-out duration in REAL seconds (default `0.4`). */
    letterboxEnterSec?: number;
    /** Lock gameplay input for the duration (default `true`). */
    lockInput?: boolean;
    /** On skip, fire the event/audio keys between the skip point and the clip end (default `true`, see D8). */
    fireSkippedEvents?: boolean;
    /** `KeyboardEvent.code` values that trigger the skip gesture (default `['Escape','Space','Enter']`). */
    skipKeys?: string[];
}
export type CutsceneOutcome = 'finished' | 'skipped' | 'stopped';
/** Handle returned by {@link CutsceneApi.playCinematic}. */
export interface CutsceneHandle {
    /** Resolves with the outcome. Never rejects; resolves `'stopped'` on failure-to-start. */
    readonly done: Promise<CutsceneOutcome>;
    /** True until the cutscene settles. */
    readonly isActive: boolean;
    /** Programmatic skip — ignores `skippableAfter` gating. Fast-forwards the clip (D8). */
    skip(): void;
    /** Hard abort: `player.stop()` (pose kept), instant bar removal, unlock. */
    stop(): void;
}
/**
 * Cutscene Director — scripts-facing runtime API (like `scene.time` /
 * `scene.juice`), reachable as `this.scene.cutscene`. Plays a keyframe clip
 * authored on a node's `core:AnimationPlayer` as a cinematic: letterbox bars,
 * input lock, a skip gesture, and an optional one-shot CameraBrain blend
 * override into and out of the cinematic camera. Camera moves, VFX, and gameplay
 * beats are authored as keyframe + event tracks on the clip.
 *
 * ```ts
 * const { done } = this.scene!.cutscene.playCinematic('IntroCutscene', {
 *   skippableAfter: 2, blendDuration: 0.8,
 * });
 * await done; // 'finished' | 'skipped' | 'stopped'
 * ```
 */
export declare class CutsceneApi {
    private readonly scene;
    private active;
    constructor(scene: SceneService);
    /**
     * Play the cinematic hosted on the node addressed by `id` (id / name / path).
     * The clip is `options.clip` or the player's own default. Returns a
     * {@link CutsceneHandle}; `await handle.done` for the outcome. Starting a new
     * cutscene while one is active hard-stops the current one first (D10).
     */
    playCinematic(id: string, options?: PlayCinematicOptions): CutsceneHandle;
    /** Hard-stop the active cutscene (called by `SceneRunner.stop()` via SceneService). */
    stopAll(outcome?: CutsceneOutcome): void;
    dispose(): void;
}
