/**
 * Pure, framework-agnostic frame-advance kernel shared by `AnimatedSprite2D`
 * and `AnimatedSprite3D`. It owns only the play-clock bookkeeping
 * (`timeAccumulator`, ping-pong `direction`, and a one-shot `finished` latch)
 * — it never touches three.js, textures, or the owning node's public fields.
 *
 * The node keeps its own `isPlaying`/`playing` flag and reacts to the
 * {@link FrameSequenceAdvanceResult} this returns (repaint each advanced frame,
 * fire per-frame events, handle the non-loop end). By composition (not a base
 * class or mixin) the two sprite nodes can keep extending different bases
 * (`Node2D`/`Node3D`) and consumer `instanceof` checks keep working.
 *
 * IMPORTANT: no `three` import here — this file is part of the runtime's
 * framework-agnostic core.
 */
export interface FrameSequenceDescriptor {
    /** Total number of frames in the active sequence. */
    frameCount: number;
    /** Frames per second; the base duration of each frame is `1 / fps`. */
    fps: number;
    /** Whether the sequence loops (wraps / bounces) or stops at the end. */
    loop: boolean;
    /** Playback direction model. Defaults to `'linear'`. */
    playbackMode?: 'linear' | 'ping-pong';
    /**
     * Optional per-frame duration scale. The dwell time of frame `i` is
     * `(1 / fps) * frameDurationMultiplier(i)`. Defaults to `() => 1`.
     */
    frameDurationMultiplier?: (frameIndex: number) => number;
}
export interface FrameSequenceAdvanceResult {
    /** The frame index after this advance (unchanged if nothing advanced). */
    nextIndex: number;
    /**
     * Every index the sequence landed on during this call, in order (empty if
     * the accumulated time did not cross a frame boundary). Lets the caller fire
     * per-frame events for each passed frame on a catch-up (large-`dt`) step.
     */
    framesAdvanced: number[];
    /**
     * `true` exactly once — on the call where a non-looping sequence reaches its
     * end. Subsequent calls return `false` (the player latches) until `reset()`
     * — or until the caller passes a `currentIndex` different from the index it
     * finished at, which is treated as an implicit reset (see `advance`).
     */
    finished: boolean;
}
export declare class FrameSequencePlayer {
    private timeAccumulator;
    private direction;
    private finished;
    private finishedAtIndex;
    /**
     * Advance the play-clock by `dt` and report how far the sequence moved.
     * Ports the catch-up `while` loop and ping-pong bounce from the original
     * `AnimatedSprite2D.tick()` verbatim, so a large `dt` catches up multiple
     * frames in one call (each landed index appears in `framesAdvanced`).
     */
    advance(dt: number, descriptor: FrameSequenceDescriptor, currentIndex: number): FrameSequenceAdvanceResult;
    /** Reset the play-clock, direction and finished latch (clip-identity change). */
    reset(): void;
    private computeNextIndex;
}
