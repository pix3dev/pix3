import { NodeBase } from '../nodes/NodeBase';
import { applyEasing, type KeyframeEasing } from '../animation/easing';
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

const DEFAULT_DURATION_SEC = 0.3;
const DEFAULT_EASE: KeyframeEasing = 'cubicOut';

/** Node shorthands whose NUMERIC value maps onto a different path (see {@link TweenProps}). */
const NODE_NUMERIC_ALIASES: Readonly<Record<string, string>> = {
  x: 'position.x',
  y: 'position.y',
  rotation: 'rotation.z',
};

/** Guards the `while` that consumes whole iterations out of one huge `dt`. */
const MAX_ITERATIONS_PER_TICK = 1024;

/**
 * Slack, in seconds, on "has this iteration finished?".
 *
 * A tween is advanced by a sum of float deltas, so a 0.5 s tween fed fifteen
 * 1/60 steps twice lands on 0.49999999999999994 — without the slack it would
 * stop one frame short of its end value, and `await handle.finished` would
 * resolve a frame later than the caller timed it for. A microsecond is far below
 * any frame budget, so nothing else can notice.
 */
const COMPLETION_EPSILON_SEC = 1e-6;

/** One animated number: where to read it, where to write it, and what it ends at. */
interface TweenChannel {
  readonly owner: Record<string, unknown>;
  readonly key: string;
  from: number;
  readonly to: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isVectorValue(value: unknown): value is TweenVectorValue {
  return typeof value === 'object' && value !== null;
}

/**
 * Walk a dotted path to the object that owns its last segment.
 * Returns null when any hop is missing or not an object.
 */
function resolveOwner(
  root: object,
  path: string
): { owner: Record<string, unknown>; key: string } | null {
  const segments = path.split('.').filter(segment => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }
  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    if (typeof current !== 'object' || current === null) {
      return null;
    }
    current = (current as Record<string, unknown>)[segments[i]];
  }
  if (typeof current !== 'object' || current === null) {
    return null;
  }
  return { owner: current as Record<string, unknown>, key: segments[segments.length - 1] };
}

/** A handle that is already over — returned when a target cannot be resolved. */
function inertHandle(reason: TweenEndReason): TweenHandle {
  return {
    cancel: () => undefined,
    finished: Promise.resolve(reason),
    isRunning: false,
  };
}

/**
 * The running tween itself. Created only by {@link TweenApi}; games see it through
 * the {@link TweenHandle} interface.
 */
class TweenInstance implements TweenHandle {
  readonly finished: Promise<TweenEndReason>;

  private resolveFinished!: (reason: TweenEndReason) => void;
  private readonly duration: number;
  private readonly ease: KeyframeEasing;
  private readonly yoyo: boolean;
  /** Total iterations; `Infinity` for `repeat: -1`. */
  private readonly totalIterations: number;
  private readonly onUpdate?: (t: number) => void;
  private readonly onComplete?: () => void;
  private readonly channels: TweenChannel[] = [];
  private delayRemaining: number;
  private elapsed = 0;
  private iteration = 0;
  private captured = false;
  private running = true;

  constructor(
    readonly target: object,
    private readonly props: TweenProps,
    options: TweenOptions,
    private readonly warn: (key: string, message: string) => void
  ) {
    const rawDuration = isFiniteNumber(options.durationSec)
      ? options.durationSec
      : DEFAULT_DURATION_SEC;
    this.duration = Math.max(0, rawDuration);
    this.ease = options.ease ?? DEFAULT_EASE;
    this.yoyo = options.yoyo === true;
    const repeat = isFiniteNumber(options.repeat) ? Math.trunc(options.repeat) : 0;
    this.totalIterations = repeat < 0 ? Number.POSITIVE_INFINITY : Math.max(0, repeat) + 1;
    this.delayRemaining = isFiniteNumber(options.delaySec) ? Math.max(0, options.delaySec) : 0;
    this.onUpdate = options.onUpdate;
    this.onComplete = options.onComplete;
    this.finished = new Promise<TweenEndReason>(resolve => {
      this.resolveFinished = resolve;
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  cancel(): void {
    this.end('cancelled');
  }

  /**
   * Advance by `dt` scaled seconds. Returns false once the tween is over, which is
   * what tells {@link TweenApi} to drop it.
   */
  advance(dt: number): boolean {
    if (!this.running) {
      return false;
    }
    // A tween whose node left the graph would keep writing into a corpse (and keep
    // its closures alive); end it the way `cancel()` would.
    if (this.target instanceof NodeBase && this.target.isDisposed) {
      this.end('cancelled');
      return false;
    }

    let step = Math.max(0, dt);
    if (this.delayRemaining > 0) {
      const used = Math.min(this.delayRemaining, step);
      this.delayRemaining -= used;
      step -= used;
      if (this.delayRemaining > 0) {
        return true;
      }
    }

    if (!this.captured) {
      // Captured when the tween actually STARTS, not when it was created: a delayed
      // tween must animate from wherever the node is by then, not from where it was.
      this.captureChannels();
      this.captured = true;
      if (this.channels.length === 0) {
        this.end('completed');
        return false;
      }
    }

    this.elapsed += step;

    if (this.duration <= 0) {
      this.applyProgress(1);
      this.end('completed');
      return false;
    }

    const iterationEnd = this.duration - COMPLETION_EPSILON_SEC;
    let guard = 0;
    while (
      this.elapsed >= iterationEnd &&
      this.iteration + 1 < this.totalIterations &&
      guard < MAX_ITERATIONS_PER_TICK
    ) {
      this.elapsed -= this.duration;
      this.iteration += 1;
      guard += 1;
    }

    const done = this.elapsed >= iterationEnd && this.iteration + 1 >= this.totalIterations;
    const local = done ? 1 : Math.min(1, Math.max(0, this.elapsed / this.duration));
    const reversed = this.yoyo && this.iteration % 2 === 1;
    const progress = reversed ? 1 - local : local;

    this.applyProgress(progress);
    this.onUpdate?.(progress);

    if (done) {
      this.end('completed');
      return false;
    }
    return true;
  }

  private applyProgress(progress: number): void {
    const eased = applyEasing(this.ease, progress);
    for (const channel of this.channels) {
      // Assigning through the owner's public property is what makes a reactive
      // schema setter (width/height/opacity) redraw — see `installReactiveSchemaProperties`.
      channel.owner[channel.key] = channel.from + (channel.to - channel.from) * eased;
    }
  }

  private end(reason: TweenEndReason): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (reason === 'completed') {
      this.onComplete?.();
    }
    this.resolveFinished(reason);
  }

  /** Expand {@link TweenProps} into concrete numeric channels against the live target. */
  private captureChannels(): void {
    const isNode = this.target instanceof NodeBase;
    for (const [key, value] of Object.entries(this.props)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (isNode && key === 'scale' && isFiniteNumber(value)) {
        this.addChannel('scale.x', value);
        this.addChannel('scale.y', value);
        continue;
      }
      if (isFiniteNumber(value)) {
        this.addChannel(isNode ? (NODE_NUMERIC_ALIASES[key] ?? key) : key, value);
        continue;
      }
      if (isVectorValue(value)) {
        for (const axis of ['x', 'y', 'z'] as const) {
          const component = value[axis];
          if (isFiniteNumber(component)) {
            this.addChannel(`${key}.${axis}`, component);
          }
        }
      }
    }
  }

  private addChannel(path: string, to: number): void {
    const resolved = resolveOwner(this.target, path);
    if (!resolved) {
      this.warn(path, `tween: "${path}" is not a property path on the target — skipped.`);
      return;
    }
    const current = resolved.owner[resolved.key];
    if (!isFiniteNumber(current)) {
      this.warn(
        path,
        `tween: "${path}" is not a finite number on the target (got ${typeof current}) — skipped.`
      );
      return;
    }
    this.channels.push({ owner: resolved.owner, key: resolved.key, from: current, to });
  }
}

/** A handle over several tweens: ends when the last one does (used by {@link TweenApi.crossFade}). */
class TweenGroupHandle implements TweenHandle {
  readonly finished: Promise<TweenEndReason>;

  constructor(private readonly parts: readonly TweenHandle[]) {
    this.finished = Promise.all(parts.map(part => part.finished)).then(reasons =>
      reasons.some(reason => reason === 'cancelled') ? 'cancelled' : 'completed'
    );
  }

  cancel(): void {
    for (const part of this.parts) {
      part.cancel();
    }
  }

  get isRunning(): boolean {
    return this.parts.some(part => part.isRunning);
  }
}

/** A target that carries a fade-able `opacity` (every `Node2D` / `Node3D` does). */
interface OpacityCarrier {
  opacity: number;
  visible: boolean;
}

function hasOpacity(value: object): value is object & OpacityCarrier {
  return isFiniteNumber((value as { opacity?: unknown }).opacity);
}

/**
 * `this.scene.tween` — see the module doc for the lifecycle rules.
 */
export class TweenApi {
  private readonly active = new Set<TweenInstance>();
  private readonly warned = new Set<string>();

  constructor(private readonly scene: SceneService) {}

  /** Tweens currently running (including ones still inside their delay). */
  get activeCount(): number {
    return this.active.size;
  }

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
  to(target: TweenTarget, props: TweenProps, options: TweenOptions = {}): TweenHandle {
    const resolved = this.resolveTarget(target);
    if (!resolved) {
      return inertHandle('cancelled');
    }
    const tween = new TweenInstance(resolved, props, options, (key, message) =>
      this.warnOnce(key, message)
    );
    this.active.add(tween);
    return tween;
  }

  /** Fade a node in from fully transparent, making it visible first. */
  fadeIn(target: TweenTarget, durationSec = DEFAULT_DURATION_SEC): TweenHandle {
    const node = this.resolveTarget(target);
    if (!node || !hasOpacity(node)) {
      this.warnOpacityless(target, 'fadeIn');
      return inertHandle('cancelled');
    }
    const to = node.opacity > 0 ? node.opacity : 1;
    node.visible = true;
    node.opacity = 0;
    return this.to(node, { opacity: to }, { durationSec, ease: 'quadOut' });
  }

  /** Fade a node out; by default it is hidden once it reaches 0 (so it stops eating taps). */
  fadeOut(
    target: TweenTarget,
    durationSec = DEFAULT_DURATION_SEC,
    options: TweenFadeOutOptions = {}
  ): TweenHandle {
    const node = this.resolveTarget(target);
    if (!node || !hasOpacity(node)) {
      this.warnOpacityless(target, 'fadeOut');
      return inertHandle('cancelled');
    }
    const hide = options.hide !== false;
    return this.to(
      node,
      { opacity: 0 },
      {
        durationSec,
        ease: 'quadIn',
        onComplete: hide
          ? () => {
              node.visible = false;
            }
          : undefined,
      }
    );
  }

  /**
   * Swap one node for another: `from` fades to 0 and hides, `to` becomes visible and
   * fades up from 0. The returned handle ends when BOTH halves do.
   *
   * ```ts
   * await this.scene.tween.crossFade('menu', 'game-hud', 0.25).finished;
   * ```
   */
  crossFade(from: TweenTarget, to: TweenTarget, durationSec = DEFAULT_DURATION_SEC): TweenHandle {
    return new TweenGroupHandle([this.fadeOut(from, durationSec), this.fadeIn(to, durationSec)]);
  }

  /**
   * Cancel every tween, or only the ones animating `target`. Cancelled tweens leave
   * their target wherever it is and resolve `finished` as `'cancelled'`.
   */
  killAll(target?: TweenTarget): void {
    if (target === undefined) {
      for (const tween of [...this.active]) {
        tween.cancel();
      }
      this.active.clear();
      return;
    }
    const resolved = this.resolveTarget(target);
    if (!resolved) {
      return;
    }
    for (const tween of [...this.active]) {
      if (tween.target === resolved) {
        tween.cancel();
        this.active.delete(tween);
      }
    }
  }

  /**
   * Advance every running tween. Driven by `SceneRunner` with the SCALED delta via
   * {@link SceneService.updateTweens}, which is what makes a hitstop freeze tweens
   * exactly as it freezes the transient juice nodes.
   */
  update(dt: number): void {
    if (this.active.size === 0) {
      return;
    }
    // Snapshot: an `onComplete` may start or kill tweens while we iterate.
    for (const tween of [...this.active]) {
      if (!tween.advance(dt)) {
        this.active.delete(tween);
      }
    }
  }

  /** Drop every tween without firing `onComplete`. Called on scene stop / change. */
  cancelAll(): void {
    for (const tween of [...this.active]) {
      tween.cancel();
    }
    this.active.clear();
    this.warned.clear();
  }

  private resolveTarget(target: TweenTarget): object | null {
    if (target instanceof NodeBase) {
      return target;
    }
    if (typeof target === 'string') {
      const node = this.scene.findNode(target);
      if (!node) {
        this.warnOnce(target, `tween: no node named "${target}" — the tween did nothing.`);
        return null;
      }
      return node;
    }
    if (typeof target === 'object' && target !== null) {
      return target;
    }
    return null;
  }

  /** Complain once when a fade helper is handed something with no `opacity` to fade. */
  private warnOpacityless(target: TweenTarget, method: string): void {
    if (typeof target !== 'string') {
      // A resolved node without `opacity` is the only remaining case; key it by method.
      this.warnOnce(
        `${method}:no-opacity`,
        `tween.${method}: the target has no \`opacity\` — nothing faded.`
      );
    }
  }

  /** Same rationale as `JuiceApi.warnOnce`: tween calls sit in per-frame gameplay code. */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    console.warn(`[Tween] ${message}`);
  }
}
