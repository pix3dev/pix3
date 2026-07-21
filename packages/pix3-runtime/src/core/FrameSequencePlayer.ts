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

const MIN_FRAME_DURATION = 0.001;

export class FrameSequencePlayer {
  private timeAccumulator = 0;
  private direction: 1 | -1 = 1;
  private finished = false;
  private finishedAtIndex: number | null = null;

  /**
   * Advance the play-clock by `dt` and report how far the sequence moved.
   * Ports the catch-up `while` loop and ping-pong bounce from the original
   * `AnimatedSprite2D.tick()` verbatim, so a large `dt` catches up multiple
   * frames in one call (each landed index appears in `framesAdvanced`).
   */
  advance(
    dt: number,
    descriptor: FrameSequenceDescriptor,
    currentIndex: number
  ): FrameSequenceAdvanceResult {
    const framesAdvanced: number[] = [];

    if (this.finished) {
      if (currentIndex === this.finishedAtIndex) {
        // Still sitting at the frame it finished on — stay put until reset().
        return { nextIndex: currentIndex, framesAdvanced, finished: false };
      }
      // The caller moved the frame index externally (e.g. scrubbed back to 0
      // and flipped `isPlaying`/`playing` back on to replay a one-shot clip,
      // without the node explicitly calling reset()). Treat that as an
      // implicit reset so playback resumes without extra node wiring.
      this.finished = false;
      this.finishedAtIndex = null;
      this.timeAccumulator = 0;
      this.direction = 1;
    }

    const { frameCount, fps, loop } = descriptor;
    const playbackMode = descriptor.playbackMode ?? 'linear';
    const durationMultiplier = descriptor.frameDurationMultiplier ?? (() => 1);

    let index = currentIndex;
    let finishedNow = false;

    this.timeAccumulator += dt;

    // Catch-up loop: consume as many whole frame durations as have elapsed.
    for (;;) {
      const frameDuration = Math.max(
        MIN_FRAME_DURATION,
        (1 / fps) * durationMultiplier(index)
      );
      if (this.timeAccumulator < frameDuration) {
        break;
      }
      this.timeAccumulator -= frameDuration;

      const previousIndex = index;
      const step = this.computeNextIndex(index, frameCount, loop, playbackMode);
      index = step.nextIndex;

      if (index !== previousIndex) {
        framesAdvanced.push(index);
      }

      if (step.finished) {
        finishedNow = true;
        this.finished = true;
        this.finishedAtIndex = index;
        this.timeAccumulator = 0;
        break;
      }
    }

    return { nextIndex: index, framesAdvanced, finished: finishedNow };
  }

  /** Reset the play-clock, direction and finished latch (clip-identity change). */
  reset(): void {
    this.timeAccumulator = 0;
    this.direction = 1;
    this.finished = false;
    this.finishedAtIndex = null;
  }

  private computeNextIndex(
    index: number,
    frameCount: number,
    loop: boolean,
    playbackMode: 'linear' | 'ping-pong'
  ): { nextIndex: number; finished: boolean } {
    // Ping-pong bounce — ported verbatim from AnimatedSprite2D.getNextFrameIndex.
    if (playbackMode === 'ping-pong' && frameCount > 1) {
      let nextIndex = index + this.direction;
      if (nextIndex >= frameCount) {
        if (!loop) {
          return { nextIndex: frameCount - 1, finished: true };
        }
        this.direction = -1;
        nextIndex = Math.max(0, frameCount - 2);
      } else if (nextIndex < 0) {
        if (!loop) {
          return { nextIndex: 0, finished: true };
        }
        this.direction = 1;
        nextIndex = Math.min(frameCount - 1, 1);
      }
      return { nextIndex, finished: false };
    }

    // Linear wrap / stop.
    const nextIndex = index + 1;
    if (nextIndex < frameCount) {
      return { nextIndex, finished: false };
    }
    if (loop) {
      return { nextIndex: 0, finished: false };
    }
    return { nextIndex: frameCount - 1, finished: true };
  }
}
