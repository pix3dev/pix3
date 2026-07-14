import { Vector3 } from 'three';
import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { errors as capturedErrors } from '@/core/agent-introspection';
import { GamePlaySessionService } from '@/services/GamePlaySessionService';
import { NodeBase, type SceneRunner } from '@pix3/runtime';

/**
 * One scripted input step for {@link GameInputService.run}. Coordinates are in
 * the 2D world/design space — the same values node `position` properties show —
 * so a model can aim at what it reads from `scene_tree`/`node_inspect`.
 */
export interface GameInputStep {
  type: 'tap' | 'key' | 'keys' | 'drag' | 'wait';
  /** tap/drag: node name or nodeId to aim at (projected to its live position). */
  target?: string;
  /** tap/drag: explicit 2D world coordinates (used when no target given). */
  x?: number;
  y?: number;
  /** drag: destination (world coords or another node). */
  to?: { x?: number; y?: number; target?: string };
  /** key: a KeyboardEvent.code, e.g. 'KeyW', 'ArrowLeft', 'Space'. */
  code?: string;
  /** keys: several codes held together (chord). */
  codes?: string[];
  /** Duration in ms: key/keys hold time, drag movement time, or wait time. */
  ms?: number;
  /** tap: how long the pointer stays down (default 700 — Button2D needs a real press). */
  holdMs?: number;
}

/** Compact live-node transform snapshot (JSON-safe). */
export interface LiveNodeSnapshot {
  nodeId: string;
  name: string;
  type: string;
  visible: boolean;
  /** Local position — the value `set_property position` writes. */
  position: { x: number; y: number; z: number };
  /** World position — what actually moved on screen. */
  worldPosition: { x: number; y: number; z: number };
  rotationZ: number;
}

/**
 * What a node is expected to do over an input run, checked against its ACTUAL
 * motion relative to its own facing (so "car drives forward when I press W" is a
 * verifiable claim, not an eyeball call). 'sideways' is the classic controller
 * bug — moving across the body instead of along the nose.
 */
export type GameInputExpectation = 'forward' | 'backward' | 'sideways' | 'moving' | 'still';

export interface ObservedNodeDelta {
  before: LiveNodeSnapshot | null;
  after: LiveNodeSnapshot | null;
  /** World-position delta (after − before); absent when either snapshot is missing. */
  delta?: { x: number; y: number; z: number; distance: number };
  /** True when the node's world position changed by more than ~half a unit. */
  moved?: boolean;
  /**
   * Travel direction vs. the node's local +Y ("nose") world axis: +1 = moving
   * straight forward, −1 = backward, ~0 = sliding sideways. Present only when the
   * node moved. This is the signal that catches "moved but in the wrong direction"
   * — `moved` alone is true even when a car drives sideways.
   */
  alignForward?: number;
  /** Travel direction vs. the local +X ("right") world axis: large |value| = sliding sideways. */
  alignRight?: number;
  /** Travel direction in degrees (atan2(dy, dx)); present only when the node moved. */
  moveDirDeg?: number;
  /** Verdict for this node's `expect` entry (present only when `expect` was given). */
  directionOk?: boolean;
  /** Human-readable reason behind `directionOk`. */
  directionNote?: string;
}

export interface GameInputResult {
  ok: boolean;
  error?: string;
  stepsRun: number;
  /** True when the runner was frozen by the focus-pause rule and we force-resumed it. */
  resumedFromFocusPause: boolean;
  observed?: Record<string, ObservedNodeDelta>;
  /** Runtime errors captured while the input script ran. */
  newErrors: Array<{ source: string; message: string }>;
}

export interface GameObserveResult {
  ok: boolean;
  error?: string;
  nodes?: Record<string, LiveNodeSnapshot | null>;
  /** Present when sampleMs > 0: per-node movement over the sample window. */
  movement?: Record<string, ObservedNodeDelta>;
  sampleMs?: number;
  /**
   * Explains any `null` snapshot: whether play mode is still warming up (retry) or the
   * name/id was wrong (a bare null left the model unable to tell those apart).
   */
  hint?: string;
}

const MAX_TOTAL_MS = 15_000;
const MAX_SAMPLE_MS = 5_000;
const DEFAULT_TAP_HOLD_MS = 700;
const DEFAULT_KEY_HOLD_MS = 500;
const DEFAULT_DRAG_MS = 300;
const DEFAULT_SETTLE_MS = 300;
const MOVED_THRESHOLD = 0.5;
/** Dot-product floor for an `expect` verdict to pass (≈ within 45° of the axis). */
const DIRECTION_ALIGN_MIN = 0.7;
/** Distinctive id so synthetic gestures never collide with a real pointer. */
const SYNTHETIC_POINTER_ID = 31337;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Best-effort `key` value for a `code` (InputService latches both, scripts poll `code`). */
const keyForCode = (code: string): string => {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
  if (code === 'Space') return ' ';
  return code;
};

/**
 * Drives the *running* game with synthetic input and reads back live node
 * transforms, so the agent can verify gameplay itself ("does the car actually
 * move?") instead of asking the user. Events go through the real input path —
 * PointerEvents on the runner's canvas, KeyboardEvents on the window the
 * runtime's `InputService` listens on — so what passes here is what a player
 * gets. While a script runs, the focus-pause rule is suppressed (a background
 * editor window would otherwise freeze the loop and eat the input); a fully
 * hidden tab still cannot tick (rAF stops) — keep the tab visible during runs.
 */
@injectable()
export class GameInputService {
  @inject(GamePlaySessionService)
  private readonly playSession!: GamePlaySessionService;

  /** Run a scripted input sequence against the running game. */
  async run(
    steps: GameInputStep[],
    options?: {
      observe?: string[];
      settleMs?: number;
      /** Per-node motion assertion → each observed node gets a `directionOk` verdict. */
      expect?: Record<string, GameInputExpectation>;
    }
  ): Promise<GameInputResult> {
    const failure = (error: string): GameInputResult => ({
      ok: false,
      error,
      stepsRun: 0,
      resumedFromFocusPause: false,
      newErrors: [],
    });

    if (!appState.ui.isPlaying) {
      return failure('The game is not running. Call play_start first, then send input.');
    }
    const runtime = this.playSession.getActiveRuntime();
    if (!runtime) {
      return failure(
        'Play mode is starting but the runtime is not attached yet; retry in a moment.'
      );
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return failure('Provide at least one input step.');
    }
    const totalMs = steps.reduce(
      (sum, step) => sum + this.stepDurationMs(step),
      options?.settleMs ?? DEFAULT_SETTLE_MS
    );
    if (totalMs > MAX_TOTAL_MS) {
      return failure(
        `Input script too long: ~${Math.round(totalMs)}ms requested, the cap is ${MAX_TOTAL_MS}ms. Split it into several game_input calls.`
      );
    }

    const { runner } = runtime;
    const errorsBefore = capturedErrors().length;
    const wasPaused = runner.paused;
    this.playSession.setFocusPauseSuppressed(true);
    // Any node named in `expect` is implicitly observed, so a model can just state its assertion.
    const observeQueries = Array.from(
      new Set([...(options?.observe ?? []), ...Object.keys(options?.expect ?? {})])
    );
    let stepsRun = 0;
    try {
      const before = this.snapshotMany(runner, observeQueries);

      for (const step of steps) {
        const stepError = await this.runStep(runtime, step);
        if (stepError) {
          return {
            ...failure(stepError),
            stepsRun,
            resumedFromFocusPause: wasPaused,
            newErrors: this.newErrorsSince(errorsBefore),
          };
        }
        stepsRun += 1;
      }

      await sleep(Math.max(0, options?.settleMs ?? DEFAULT_SETTLE_MS));

      const observed: Record<string, ObservedNodeDelta> = {};
      for (const [query, beforeSnap] of before) {
        const afterSnap = this.snapshotOne(runner, query);
        observed[query] = this.describeDelta(beforeSnap, afterSnap);
      }
      if (options?.expect) {
        for (const [query, expectation] of Object.entries(options.expect)) {
          const delta = observed[query];
          if (delta) {
            const verdict = this.evaluateExpectation(expectation, delta);
            delta.directionOk = verdict.ok;
            delta.directionNote = verdict.note;
          }
        }
      }

      return {
        ok: true,
        stepsRun,
        resumedFromFocusPause: wasPaused,
        ...(observeQueries.length ? { observed } : {}),
        newErrors: this.newErrorsSince(errorsBefore),
      };
    } finally {
      this.playSession.setFocusPauseSuppressed(false);
    }
  }

  /** Snapshot live nodes now; with sampleMs > 0, sample again and report movement. */
  async observe(queries: string[], sampleMs = 0): Promise<GameObserveResult> {
    if (!appState.ui.isPlaying) {
      return {
        ok: false,
        error:
          'The game is not running — game_observe reads the LIVE runtime. Call play_start first (edit-mode state is available via node_inspect).',
      };
    }
    const runtime = this.playSession.getActiveRuntime();
    if (!runtime) {
      return {
        ok: false,
        error: 'Play mode is starting but the runtime is not attached yet; retry in a moment.',
      };
    }
    const targets = queries.length > 0 ? queries : this.defaultObserveTargets(runtime.runner);
    if (targets.length === 0) {
      return { ok: false, error: 'No live nodes found in the running scene.' };
    }

    const first = this.snapshotMany(runtime.runner, targets);
    // A `null` snapshot has two very different causes; tell them apart so the model doesn't read
    // "warming up" as "no such node" and rename things that were fine (or vice-versa).
    const hasLiveNodes = runtime.runner.getLiveRootNodes().length > 0;
    const hintFor = (unresolved: string[]): string | undefined => {
      if (unresolved.length === 0) return undefined;
      return hasLiveNodes
        ? `Not resolved by name/id: ${unresolved.join(', ')}. Check exact names with scene_tree.`
        : 'Play mode is still warming up (no live nodes yet) — wait ~300ms and retry.';
    };
    if (!(sampleMs > 0)) {
      const hint = hintFor(first.filter(([, snap]) => snap === null).map(([query]) => query));
      return { ok: true, nodes: Object.fromEntries(first), ...(hint ? { hint } : {}) };
    }

    const clampedMs = Math.min(sampleMs, MAX_SAMPLE_MS);
    this.playSession.setFocusPauseSuppressed(true);
    try {
      await sleep(clampedMs);
      const movement: Record<string, ObservedNodeDelta> = {};
      for (const [query, beforeSnap] of first) {
        movement[query] = this.describeDelta(beforeSnap, this.snapshotOne(runtime.runner, query));
      }
      const hint = hintFor(
        Object.entries(movement)
          .filter(([, delta]) => delta.after === null)
          .map(([query]) => query)
      );
      return {
        ok: true,
        nodes: Object.fromEntries(first),
        movement,
        sampleMs: clampedMs,
        ...(hint ? { hint } : {}),
      };
    } finally {
      this.playSession.setFocusPauseSuppressed(false);
    }
  }

  // -- steps -------------------------------------------------------------------

  private stepDurationMs(step: GameInputStep): number {
    switch (step.type) {
      case 'tap':
        return Math.max(0, step.holdMs ?? DEFAULT_TAP_HOLD_MS);
      case 'key':
      case 'keys':
        return Math.max(0, step.ms ?? DEFAULT_KEY_HOLD_MS);
      case 'drag':
        return Math.max(0, step.ms ?? DEFAULT_DRAG_MS);
      case 'wait':
        return Math.max(0, step.ms ?? 0);
      default:
        return 0;
    }
  }

  /** Execute one step; returns an error string (null = success). */
  private async runStep(
    runtime: { runner: SceneRunner; canvas: HTMLCanvasElement; windowRef: Window },
    step: GameInputStep
  ): Promise<string | null> {
    switch (step.type) {
      case 'wait':
        await sleep(this.stepDurationMs(step));
        return null;
      case 'key':
        if (!step.code) return "A 'key' step needs a `code` (KeyboardEvent.code, e.g. 'KeyW').";
        return this.holdKeys([step.code], this.stepDurationMs(step));
      case 'keys':
        if (!step.codes?.length) return "A 'keys' step needs `codes`: ['KeyW', 'KeyA', ...].";
        return this.holdKeys(step.codes, this.stepDurationMs(step));
      case 'tap': {
        const point = this.resolveClientPoint(runtime, step.target, step.x, step.y);
        if (typeof point === 'string') return point;
        this.dispatchPointer(runtime.canvas, 'pointerdown', point);
        await sleep(this.stepDurationMs(step));
        this.dispatchPointer(runtime.canvas, 'pointerup', point);
        return null;
      }
      case 'drag': {
        const from = this.resolveClientPoint(runtime, step.target, step.x, step.y);
        if (typeof from === 'string') return from;
        const to = this.resolveClientPoint(runtime, step.to?.target, step.to?.x, step.to?.y);
        if (typeof to === 'string') return `drag \`to\`: ${to}`;
        const durationMs = this.stepDurationMs(step);
        const moves = Math.max(2, Math.min(20, Math.round(durationMs / 30)));
        this.dispatchPointer(runtime.canvas, 'pointerdown', from);
        for (let i = 1; i <= moves; i++) {
          await sleep(durationMs / moves);
          this.dispatchPointer(runtime.canvas, 'pointermove', {
            x: from.x + ((to.x - from.x) * i) / moves,
            y: from.y + ((to.y - from.y) * i) / moves,
          });
        }
        this.dispatchPointer(runtime.canvas, 'pointerup', to);
        return null;
      }
      default:
        return `Unknown step type "${String(step.type)}". Use tap | key | keys | drag | wait.`;
    }
  }

  private async holdKeys(codes: string[], ms: number): Promise<null> {
    for (const code of codes) {
      this.dispatchKey('keydown', code);
    }
    await sleep(ms);
    for (const code of codes) {
      this.dispatchKey('keyup', code);
    }
    return null;
  }

  // -- event dispatch ------------------------------------------------------------

  /**
   * Keyboard events go to the main editor window: the runtime's `InputService`
   * registers its key listeners on its module-global `window`, which is the
   * editor window even when the game renders in the popout. Synthetic
   * dispatchEvent reaches listeners regardless of OS focus.
   */
  private dispatchKey(type: 'keydown' | 'keyup', code: string): void {
    window.dispatchEvent(
      new KeyboardEvent(type, { code, key: keyForCode(code), bubbles: true, cancelable: true })
    );
  }

  private dispatchPointer(
    canvas: HTMLCanvasElement,
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    client: { x: number; y: number }
  ): void {
    const init = {
      pointerId: SYNTHETIC_POINTER_ID,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: client.x,
      clientY: client.y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      bubbles: true,
      cancelable: true,
    };
    // happy-dom (specs) has no PointerEvent constructor with pointer fields —
    // fall back to a plain Event carrying the same properties.
    if (typeof PointerEvent === 'function') {
      canvas.dispatchEvent(new PointerEvent(type, init));
      return;
    }
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [prop, value] of Object.entries(init)) {
      Object.defineProperty(event, prop, { value });
    }
    canvas.dispatchEvent(event);
  }

  /**
   * Resolve a step's aim to CLIENT coordinates on the canvas: live node (by
   * name/id) or explicit world point → canvas backing pixels (via the runner's
   * camera-correct projection) → client space through the canvas rect (backing
   * store ≠ CSS size). Returns an error string when unresolvable.
   */
  private resolveClientPoint(
    runtime: { runner: SceneRunner; canvas: HTMLCanvasElement },
    target: string | undefined,
    x: number | undefined,
    y: number | undefined
  ): { x: number; y: number } | string {
    let backing: { x: number; y: number } | null;
    if (target) {
      const node = this.findLiveNode(runtime.runner, target);
      if (!node) {
        return `No live node named or with id "${target}" in the running scene. Check game_observe / scene_tree for names.`;
      }
      backing = runtime.runner.projectNodeToCanvas(node);
      if (!backing) {
        return `Node "${target}" could not be projected to the canvas (no camera or zero-sized canvas).`;
      }
    } else if (typeof x === 'number' && typeof y === 'number') {
      backing = runtime.runner.projectWorldPointToCanvas(x, y);
      if (!backing) {
        return 'The point could not be projected to the canvas (zero-sized canvas?).';
      }
    } else {
      return 'A tap/drag step needs either `target` (node name/id) or numeric `x` and `y`.';
    }

    const rect = runtime.canvas.getBoundingClientRect();
    const backingWidth = runtime.canvas.width > 0 ? runtime.canvas.width : rect.width;
    const backingHeight = runtime.canvas.height > 0 ? runtime.canvas.height : rect.height;
    if (!(backingWidth > 0) || !(backingHeight > 0)) {
      return 'The game canvas has no size yet; retry in a moment.';
    }
    return {
      x: rect.left + (backing.x / backingWidth) * rect.width,
      y: rect.top + (backing.y / backingHeight) * rect.height,
    };
  }

  // -- live-node snapshots ---------------------------------------------------------

  private findLiveNode(runner: SceneRunner, query: string): NodeBase | null {
    return runner.getLiveNodeById(query) ?? runner.findLiveNodeByName(query);
  }

  private snapshotMany(
    runner: SceneRunner,
    queries: string[]
  ): Array<[string, LiveNodeSnapshot | null]> {
    return queries.map(query => [query, this.snapshotOne(runner, query)]);
  }

  private snapshotOne(runner: SceneRunner, query: string): LiveNodeSnapshot | null {
    const node = this.findLiveNode(runner, query);
    if (!node) {
      return null;
    }
    const world = node.getWorldPosition(GameInputService.scratchWorld);
    return {
      nodeId: node.nodeId,
      name: node.name,
      type: node.type,
      visible: node.visible,
      position: { x: node.position.x, y: node.position.y, z: node.position.z },
      worldPosition: { x: world.x, y: world.y, z: world.z },
      rotationZ: node.rotation.z,
    };
  }

  private static readonly scratchWorld = new Vector3();

  /** Errors captured after index `count` in the ring buffer (compact form). */
  private newErrorsSince(count: number): Array<{ source: string; message: string }> {
    return capturedErrors()
      .slice(count)
      .map(entry => ({ source: entry.source, message: entry.message }));
  }

  private describeDelta(
    before: LiveNodeSnapshot | null,
    after: LiveNodeSnapshot | null
  ): ObservedNodeDelta {
    if (!before || !after) {
      return { before, after };
    }
    const dx = after.worldPosition.x - before.worldPosition.x;
    const dy = after.worldPosition.y - before.worldPosition.y;
    const dz = after.worldPosition.z - before.worldPosition.z;
    const distance = Math.hypot(dx, dy, dz);
    const base: ObservedNodeDelta = {
      before,
      after,
      delta: { x: dx, y: dy, z: dz, distance },
      moved: distance > MOVED_THRESHOLD,
    };
    // Direction-of-travel relative to the node's facing. three.js rotates the
    // local +Y ("nose") axis by rotation.z to world (-sin, cos) and +X ("right")
    // to (cos, sin); dotting the unit travel vector with those tells forward vs
    // sideways. Only meaningful once the node actually moved in the XY plane.
    const planar = Math.hypot(dx, dy);
    if (planar > 1e-6) {
      const th = after.rotationZ;
      const ndx = dx / planar;
      const ndy = dy / planar;
      base.alignForward = round3(ndx * -Math.sin(th) + ndy * Math.cos(th));
      base.alignRight = round3(ndx * Math.cos(th) + ndy * Math.sin(th));
      base.moveDirDeg = round1((Math.atan2(dy, dx) * 180) / Math.PI);
    }
    return base;
  }

  /** Judge an actual delta against an expected motion, relative to the node's facing. */
  private evaluateExpectation(
    expectation: GameInputExpectation,
    d: ObservedNodeDelta
  ): { ok: boolean; note: string } {
    const moved = d.moved === true;
    const dist = d.delta ? Math.round(d.delta.distance) : 0;
    const fwd = d.alignForward;
    const right = d.alignRight;
    const facing =
      fwd === undefined ? '' : ` (alignForward=${fwd}, alignRight=${right}, moved ${dist}u)`;
    switch (expectation) {
      case 'moving':
        return { ok: moved, note: moved ? `moved ${dist}u` : 'did not move' };
      case 'still':
        return moved
          ? { ok: false, note: `expected still but moved ${dist}u` }
          : { ok: true, note: 'stayed put' };
      case 'forward':
        return {
          ok: moved && fwd !== undefined && fwd >= DIRECTION_ALIGN_MIN,
          note: !moved ? 'did not move' : `forward alignment ${fwd}${facing}`,
        };
      case 'backward':
        return {
          ok: moved && fwd !== undefined && fwd <= -DIRECTION_ALIGN_MIN,
          note: !moved ? 'did not move' : `backward alignment ${fwd}${facing}`,
        };
      case 'sideways':
        return {
          ok: moved && right !== undefined && Math.abs(right) >= DIRECTION_ALIGN_MIN,
          note: !moved ? 'did not move' : `sideways alignment ${right}${facing}`,
        };
      default:
        return { ok: false, note: `unknown expectation "${String(expectation)}"` };
    }
  }

  /** Roots + their direct children (by nodeId) — the default when no names are given. */
  private defaultObserveTargets(runner: SceneRunner): string[] {
    const targets: string[] = [];
    for (const root of runner.getLiveRootNodes()) {
      targets.push(root.nodeId);
      for (const child of root.children) {
        if (child instanceof NodeBase && targets.length < 40) {
          targets.push(child.nodeId);
        }
      }
      if (targets.length >= 40) break;
    }
    return targets;
  }
}
