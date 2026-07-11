import type { KeyframeEasing } from '../animation/easing';
import { AnimationPlayerBehavior } from '../animation/AnimationPlayerBehavior';
import { findKeyframeClip, type KeyframeClip } from '../animation/keyframe-types';
import { CameraBrainBehavior } from '../behaviors/CameraBrainBehavior';
import { NodeBase } from '../nodes/NodeBase';
import type { InputService } from './InputService';
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

const DEFAULT_SKIP_KEYS: readonly string[] = ['Escape', 'Space', 'Enter'];
const DEFAULT_LETTERBOX_SIZE = 0.1;
const DEFAULT_LETTERBOX_ENTER_SEC = 0.4;
const MAX_LETTERBOX_SIZE = 0.45;

interface NormalizedOptions {
  skippableAfter: number | null;
  blendDuration: number | null;
  blendEasing?: KeyframeEasing;
  letterbox: boolean;
  letterboxSize: number;
  letterboxEnterSec: number;
  lockInput: boolean;
  fireSkippedEvents: boolean;
  skipKeys: readonly string[];
}

function normalizeOptions(options: PlayCinematicOptions): NormalizedOptions {
  const size =
    typeof options.letterboxSize === 'number' && Number.isFinite(options.letterboxSize)
      ? Math.max(0, Math.min(MAX_LETTERBOX_SIZE, options.letterboxSize))
      : DEFAULT_LETTERBOX_SIZE;
  const enterSec =
    typeof options.letterboxEnterSec === 'number' && Number.isFinite(options.letterboxEnterSec)
      ? Math.max(0, options.letterboxEnterSec)
      : DEFAULT_LETTERBOX_ENTER_SEC;
  return {
    skippableAfter:
      typeof options.skippableAfter === 'number' && Number.isFinite(options.skippableAfter)
        ? Math.max(0, options.skippableAfter)
        : null,
    blendDuration:
      typeof options.blendDuration === 'number' && Number.isFinite(options.blendDuration)
        ? Math.max(0, options.blendDuration)
        : null,
    blendEasing: options.blendEasing,
    letterbox: options.letterbox !== false,
    letterboxSize: size,
    letterboxEnterSec: enterSec,
    lockInput: options.lockInput !== false,
    fireSkippedEvents: options.fireSkippedEvents !== false,
    skipKeys:
      Array.isArray(options.skipKeys) && options.skipKeys.length > 0
        ? options.skipKeys.slice()
        : DEFAULT_SKIP_KEYS,
  };
}

/** DFS for the first {@link AnimationPlayerBehavior} on `node` or its descendants. */
function findPlayerOn(node: NodeBase): AnimationPlayerBehavior | null {
  const direct = node.getComponent(AnimationPlayerBehavior);
  if (direct) {
    return direct;
  }
  const stack: NodeBase[] = childNodesOf(node);
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const found = current.getComponent(AnimationPlayerBehavior);
    if (found) {
      return found;
    }
    stack.push(...childNodesOf(current));
  }
  return null;
}

function childNodesOf(node: NodeBase): NodeBase[] {
  return node.children.filter((child): child is NodeBase => child instanceof NodeBase);
}

/**
 * Resolve the clip a `playCinematic` will run, mirroring
 * {@link AnimationPlayerBehavior.play}'s resolution (explicit name → autoplay
 * clip → first clip) but without starting it — so we can validate + inspect
 * `loop` before touching input/letterbox.
 */
function resolveClip(player: AnimationPlayerBehavior, clipName?: string): KeyframeClip | null {
  const set = player.getAnimationSet();
  if (clipName) {
    return findKeyframeClip(set, clipName);
  }
  const autoplay = typeof player.config.autoplay === 'string' ? player.config.autoplay.trim() : '';
  return (autoplay ? findKeyframeClip(set, autoplay) : null) ?? set.clips[0] ?? null;
}

/**
 * A single running cinematic. Owns its letterbox DOM, skip listeners, input
 * lock, and the completion signal connection, and tears all of them down on
 * settle/stop. One at a time (see {@link CutsceneApi.playCinematic} D10).
 */
class CutsceneRun implements CutsceneHandle {
  readonly done: Promise<CutsceneOutcome>;
  private resolveDone!: (outcome: CutsceneOutcome) => void;
  private settled = false;

  private input: InputService | null = null;
  private holdsLock = false;

  private topBar: HTMLDivElement | null = null;
  private bottomBar: HTMLDivElement | null = null;
  private barAnimId: number | null = null;
  /** Current bar extension fraction 0..1 (of `letterboxSize`), so retraction starts from where we are. */
  private barT = 0;

  private startedAtMs = 0;
  private finishConnected = false;

  constructor(
    private readonly scene: SceneService,
    private readonly hostNode: NodeBase,
    private readonly player: AnimationPlayerBehavior,
    private readonly clip: KeyframeClip,
    private readonly opts: NormalizedOptions
  ) {
    this.done = new Promise<CutsceneOutcome>(resolve => {
      this.resolveDone = resolve;
    });
  }

  get isActive(): boolean {
    return !this.settled;
  }

  /** Kick off the cinematic: lock, letterbox, skip listeners, entry blend, play. */
  start(): void {
    if (this.opts.lockInput) {
      const input = this.scene.getInputService();
      if (input) {
        input.lock();
        this.input = input;
        this.holdsLock = true;
      }
    }

    if (this.opts.letterbox) {
      this.ensureBars();
      this.animateBars(0, 1, this.opts.letterboxEnterSec);
    }

    this.startedAtMs = performance.now();
    this.attachSkipListeners();

    // Entry blend override: catches the cut *into* the cinematic vcam when the
    // clip raises its priority.
    this.armBlendOverride();

    if (this.clip.loop) {
      console.warn(
        `[Cutscene] clip "${this.clip.name}" loops — cutscene will only end via skip()/stop().`
      );
    } else {
      // clipName-checked in onFinished so another clip starting on the same
      // player cannot complete this cutscene.
      this.hostNode.connect('animation_finished', this, this.onFinished);
      this.finishConnected = true;
    }

    if (!this.player.play(this.clip.name)) {
      // We already resolved the clip, so this is near-impossible — but never
      // leave a lock/letterbox dangling if play() somehow refuses.
      this.hardSettle('stopped');
    }
  }

  skip(): void {
    if (this.settled) {
      return;
    }
    // Detach the completion signal BEFORE finish(): finish() emits
    // `animation_finished` synchronously, and without this the emit would race
    // us to settle('finished') — a skip must resolve 'skipped'. The exit blend
    // is armed in settleSoft (shared with the natural-finish path).
    this.detachFinishSignal();
    this.player.finish(this.opts.fireSkippedEvents);
    this.settleSoft('skipped');
  }

  stop(): void {
    this.hardSettle('stopped');
  }

  /** Hard-abort resolving with an explicit outcome (used by {@link CutsceneApi.stopAll}). */
  forceStop(outcome: CutsceneOutcome): void {
    this.hardSettle(outcome);
  }

  // ── Skip gesture ────────────────────────────────────────────────────────────

  private readonly onSkipPointer = (): void => {
    this.onSkipGesture();
  };

  private readonly onSkipKey = (event: KeyboardEvent): void => {
    if (this.opts.skipKeys.includes(event.code)) {
      this.onSkipGesture();
    }
  };

  private onSkipGesture(): void {
    if (this.opts.skippableAfter === null) {
      return; // unskippable
    }
    if (performance.now() - this.startedAtMs < this.opts.skippableAfter * 1000) {
      return; // still gated
    }
    this.skip();
  }

  private attachSkipListeners(): void {
    // Pointer skip is bound to the canvas in the BUBBLE phase (no capture), so
    // InputService's own canvas pointerdown handler — attached first, in
    // startScene() — runs first, sees the lock, and drops the tap before our
    // handler runs. That keeps the skipping tap from leaking into gameplay as an
    // Action_Primary press. Do not switch this to capture phase.
    const canvas = this.scene.getCanvas();
    canvas?.addEventListener('pointerdown', this.onSkipPointer);
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onSkipKey);
    }
  }

  private detachSkipListeners(): void {
    const canvas = this.scene.getCanvas();
    canvas?.removeEventListener('pointerdown', this.onSkipPointer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onSkipKey);
    }
  }

  // ── Completion signal ─────────────────────────────────────────────────────

  private readonly onFinished = (...args: unknown[]): void => {
    if (args[0] === this.clip.name) {
      this.settleSoft('finished');
    }
  };

  private detachFinishSignal(): void {
    if (this.finishConnected) {
      this.hostNode.disconnect('animation_finished', this, this.onFinished);
      this.finishConnected = false;
    }
  }

  // ── Camera blend ──────────────────────────────────────────────────────────

  private armBlendOverride(): void {
    if (this.opts.blendDuration === null) {
      return;
    }
    // By design (spec D7) the override targets the *next* camera activation, not
    // a specific vcam — the director can't know the "gameplay camera". If the
    // clip performs no camera cut, the armed override lingers until some later
    // switch consumes it; that is an accepted characteristic of this API.
    const brain = this.scene.getActiveCamera()?.getComponent(CameraBrainBehavior) ?? null;
    brain?.overrideNextBlend(this.opts.blendDuration, this.opts.blendEasing);
  }

  // ── Letterbox bars ────────────────────────────────────────────────────────

  private ensureBars(): void {
    const parent = this.scene.getCanvas()?.parentElement;
    if (!parent) {
      console.warn('[Cutscene] Cannot create letterbox bars: canvas has no parent element.');
      return;
    }

    const parentStyle = getComputedStyle(parent);
    if (parentStyle.position === 'static') {
      parent.style.position = 'relative';
    }

    // Below the fade overlay (9999) and flash (10000) so `fadeToBlack` still
    // covers the whole viewport, bars included.
    const baseCss = [
      'position: absolute',
      'left: 0',
      'right: 0',
      'height: 0%',
      'background: #000',
      'pointer-events: none',
      'z-index: 9998',
    ];
    this.topBar = document.createElement('div');
    this.topBar.style.cssText = [...baseCss, 'top: 0'].join('; ');
    this.bottomBar = document.createElement('div');
    this.bottomBar.style.cssText = [...baseCss, 'bottom: 0'].join('; ');
    parent.appendChild(this.topBar);
    parent.appendChild(this.bottomBar);
  }

  /**
   * Animate the bars from `fromT` to `toT` (0..1 fraction of `letterboxSize`) over
   * `durationSec` of REAL time. The chrome runs on `performance.now()` +
   * `requestAnimationFrame` (not scaled gameplay dt), so hitstop / slow-mo never
   * freezes or stretches the bars. Height is a CSS percentage so viewport resizes
   * are free.
   */
  private animateBars(fromT: number, toT: number, durationSec: number, onDone?: () => void): void {
    this.cancelBarAnim();
    if (!this.topBar || !this.bottomBar) {
      this.barT = toT;
      onDone?.();
      return;
    }
    const durationMs = Math.max(0, durationSec * 1000);
    if (durationMs === 0) {
      this.setBarHeight(toT);
      onDone?.();
      return;
    }
    const startTime = performance.now();
    const step = (now: number): void => {
      const t = Math.min((now - startTime) / durationMs, 1);
      this.setBarHeight(fromT + (toT - fromT) * t);
      if (t < 1) {
        this.barAnimId = requestAnimationFrame(step);
      } else {
        this.barAnimId = null;
        onDone?.();
      }
    };
    this.barAnimId = requestAnimationFrame(step);
  }

  private setBarHeight(t: number): void {
    this.barT = t;
    const pct = `${(this.opts.letterboxSize * t * 100).toFixed(4)}%`;
    if (this.topBar) {
      this.topBar.style.height = pct;
    }
    if (this.bottomBar) {
      this.bottomBar.style.height = pct;
    }
  }

  private cancelBarAnim(): void {
    if (this.barAnimId !== null) {
      cancelAnimationFrame(this.barAnimId);
      this.barAnimId = null;
    }
  }

  private removeBars(): void {
    this.cancelBarAnim();
    this.topBar?.remove();
    this.bottomBar?.remove();
    this.topBar = null;
    this.bottomBar = null;
  }

  // ── Settling ──────────────────────────────────────────────────────────────

  /** Graceful end (finished / skipped): unlock, retract the bars, then resolve. */
  private settleSoft(outcome: CutsceneOutcome): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    // Exit blend override (both finished and skipped): smooth the cut back to the
    // gameplay vcam once the clip's end pose restores camera priorities. The
    // consuming beginBlend runs on the next CameraBrain.onUpdate — after this
    // returns — so arming here (rather than before finish()) is equivalent.
    this.armBlendOverride();
    this.detachSkipListeners();
    this.detachFinishSignal();
    this.releaseLock();
    // Retract the bars asynchronously — control is already back to the caller.
    this.animateBars(this.barT, 0, this.opts.letterboxEnterSec, () => this.removeBars());
    this.resolveDone(outcome);
  }

  /**
   * Hard abort (SceneRunner.stop / dispose / D10 preemption): rip everything down
   * now, with no exit animation. Idempotent — even when the run has already
   * soft-settled but is still mid bar-retract, this force-cancels that rAF and
   * removes the letterbox DOM immediately (D9).
   */
  private hardSettle(outcome: CutsceneOutcome): void {
    if (!this.settled) {
      this.settled = true;
      // player.stop() keeps the current pose and fires no events / signal.
      this.player.stop();
      this.resolveDone(outcome);
    }
    this.teardownResources();
  }

  /** Idempotent hard teardown: cancel the bar rAF, remove the bars, detach the
   * skip listeners and completion signal, and release the lock. */
  private teardownResources(): void {
    this.removeBars(); // also cancels the in-flight bar rAF
    this.detachSkipListeners();
    this.detachFinishSignal();
    this.releaseLock();
  }

  private releaseLock(): void {
    if (this.holdsLock) {
      this.input?.unlock();
      this.holdsLock = false;
    }
  }
}

/** Inert handle for failure-to-start: already-resolved, no side effects. */
function inertHandle(): CutsceneHandle {
  return {
    done: Promise.resolve<CutsceneOutcome>('stopped'),
    isActive: false,
    skip: () => undefined,
    stop: () => undefined,
  };
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
export class CutsceneApi {
  private active: CutsceneRun | null = null;

  constructor(private readonly scene: SceneService) {}

  /**
   * Play the cinematic hosted on the node addressed by `id` (id / name / path).
   * The clip is `options.clip` or the player's own default. Returns a
   * {@link CutsceneHandle}; `await handle.done` for the outcome. Starting a new
   * cutscene while one is active hard-stops the current one first (D10).
   */
  playCinematic(id: string, options: PlayCinematicOptions = {}): CutsceneHandle {
    // D10: at most one cutscene at a time. stop() is idempotent and also reaps a
    // just-settled run whose letterbox bars are still mid-retract, so the new
    // cutscene's bars never overlap stale ones.
    this.active?.stop();
    this.active = null;

    const node = this.scene.findNode(id);
    const player = node ? findPlayerOn(node) : null;
    const hostNode = player?.node ?? null;
    if (!node || !player || !hostNode) {
      console.warn(`[Cutscene] playCinematic: no AnimationPlayer found for "${id}".`);
      return inertHandle();
    }

    const clip = resolveClip(player, options.clip);
    if (!clip) {
      console.warn(
        `[Cutscene] playCinematic: clip "${options.clip ?? '(default)'}" not found on "${id}".`
      );
      return inertHandle();
    }

    const run = new CutsceneRun(this.scene, hostNode, player, clip, normalizeOptions(options));
    this.active = run;
    run.start();
    return run;
  }

  /** Hard-stop the active cutscene (called by `SceneRunner.stop()` via SceneService). */
  stopAll(outcome: CutsceneOutcome = 'stopped'): void {
    // forceStop is idempotent: it resolves an unsettled run and, in every case,
    // rips down any lingering bar-retract rAF + letterbox DOM (D9).
    this.active?.forceStop(outcome);
    this.active = null;
  }

  dispose(): void {
    this.stopAll('stopped');
    this.active = null;
  }
}
