import { Vector3 } from 'three';
import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { errors as capturedErrors, safeSerialize, type Json } from '@/core/agent-introspection';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import {
  NodeBase,
  getGameDebug,
  isInteractive,
  type InteractionDescriptor,
  type Interactive,
  type ObservedPollsSnapshot,
  type SceneRunner,
} from '@pix3/runtime';
import {
  NodeWatchRecorder,
  type NodeActivity,
  type WatchFrameSource,
  type WatchNodeLike,
} from '@/services/agent/NodeWatchRecorder';
import {
  compareReachContext,
  contextHash,
  normalizeContext,
  parseJournal,
  proofKey,
  ProjectFileReachabilityStore,
  REACHABILITY_JOURNAL_PATH,
  serializeJournal,
  type ReachContext,
  type ReachFrame,
  type ReachProof,
  type ReachabilityStore,
} from '@/services/agent/reachability-journal';

/**
 * The slice of the runtime `InputService` this service drives. Structural, so a
 * host/spec fake that only implements the harness surface still works, and so
 * a missing implementation degrades to "no observation" instead of throwing.
 */
interface PollRecordingInput {
  startPollRecording(): void;
  stopPollRecording(): void;
  takeObservedPolls(): ObservedPollsSnapshot;
}

export type { NodeActivity, WatchLogEntry } from '@/services/agent/NodeWatchRecorder';

/**
 * One scripted input step for {@link GameInputService.run}. Coordinates are in
 * the 2D world/design space — the same values node `position` properties show —
 * so a model can aim at what it reads from `scene_tree`/`node_inspect`.
 */
export interface GameInputStep {
  type: 'tap' | 'key' | 'keys' | 'drag' | 'wait' | 'hover' | 'invoke';
  /** tap/drag/hover/invoke: node name or nodeId to aim at (projected to its live position). */
  target?: string;
  /** invoke: interaction name from `game_controls`, e.g. 'click', 'setValue', 'scrollBy'. */
  interaction?: string;
  /** invoke: arguments for the interaction, keyed by the argument names the listing gives. */
  args?: Record<string, unknown>;
  /** tap/drag/hover: explicit 2D world coordinates (used when no target given). */
  x?: number;
  y?: number;
  /** drag: destination (world coords or another node). */
  to?: { x?: number; y?: number; target?: string };
  /** key: a KeyboardEvent.code, e.g. 'KeyW', 'ArrowLeft', 'Space'. */
  code?: string;
  /** keys: several codes held together (chord). */
  codes?: string[];
  /** Duration in ms: key/keys hold time, drag movement time, hover hold time, or wait time. */
  ms?: number;
  /**
   * Duration in **logic ticks**, the denomination gameplay is actually written
   * in — takes priority over `ms`/`holdMs` on every step type that has a
   * duration. Prefer it: a game reads input per tick, so "hold left for 8
   * frames" is a statement about the game, while the equivalent in milliseconds
   * is a guess about the frame rate (a live run had a long `ms` steer nothing
   * while a ~120 ms tap did). Converted with the runner's own tick length when
   * it exposes one, else 1/60 s.
   */
  frames?: number;
  /** tap: how long the pointer stays down (default 700 — Button2D needs a real press). */
  holdMs?: number;
}

/** Compact live-node transform snapshot (JSON-safe). */
export interface LiveNodeSnapshot {
  nodeId: string;
  name: string;
  type: string;
  /** The node's OWN visible flag — not whether it is on screen (see `hiddenByAncestor`). */
  visible: boolean;
  /**
   * Name of the nearest ancestor whose `visible` is false, when this node's own flag is true.
   * Present ONLY in that mismatch case, which is almost always a bug in the game: three.js skips
   * an invisible subtree, so the node renders nothing and cannot be tapped even though every
   * property reads "shown".
   *
   * This is the exact shape that fooled an agent (and me) for two turns: a script made a result
   * label and a retry button `visible = true` and left their parent overlay hidden, so `visible`
   * and `text` both reported a win screen that was never on screen and whose button was untappable.
   */
  hiddenByAncestor?: string;
  /** Local position — the value `set_property position` writes. */
  position: { x: number; y: number; z: number };
  /** World position — what actually moved on screen. */
  worldPosition: { x: number; y: number; z: number };
  rotationZ: number;
  /** Local scale — what PunchScale/PopIn/hover-scale animate (round3). */
  scale: { x: number; y: number; z: number };
  /**
   * Local opacity (0..1, round3). Present only for nodes that expose it
   * (Node2D/Node3D subclasses); the value is LOCAL — a parent fade does not
   * show here, observe the node that fades.
   */
  opacity?: number;
  /**
   * The text the node actually RENDERS right now, for nodes that show one
   * (Label2D/Button2D and every other UIControl2D subclass — the resolved
   * value, so a localized `labelKey` reads as the translation). Absent for
   * nodes with no text. Score/HUD verification was impossible without it: the
   * agent could see a label existed but not the number on it.
   */
  text?: string;
  /**
   * Direct child count. A spawner/pool container never MOVES — this (and
   * `visibleChildCount`) is how you tell it "did something".
   */
  childCount: number;
  /**
   * Direct children currently visible. Object pools recycle by toggling
   * `visible`, not by adding/removing — so ammo in flight shows up here, not in
   * `childCount`.
   */
  visibleChildCount: number;
  /**
   * Interaction state of a UI control (`Button2D`, `Checkbox2D`, `Slider2D`, … — any
   * `UIControl2D`). Absent for everything else.
   *
   * This is what tells "the input never reached the button" apart from "the button fired and the
   * handler did nothing" — the two have identical symptoms otherwise, and without it a dead RETRY
   * button cost three turns of guessing. `enabled: false` is the single most common cause; `hovering`
   * proves the pointer landed on the control's bounds at all.
   */
  control?: { enabled: boolean; hovering: boolean; pressed: boolean };
}

/**
 * What a node is expected to do over an input run, checked against its ACTUAL
 * motion relative to its own facing (so "car drives forward when I press W" is a
 * verifiable claim, not an eyeball call). 'sideways' is the classic controller
 * bug — moving across the body instead of along the nose.
 */
export type GameInputExpectation =
  | 'forward'
  | 'backward'
  | 'sideways'
  | 'moving'
  | 'still'
  | 'activity';

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
  /** True when childCount or visibleChildCount differs between endpoints. */
  childrenChanged?: boolean;
  /**
   * Endpoint scale change (after − before per axis) plus `ratio` — the axis
   * ratio farthest from 1 (a 1.08 hover-scale reads as ratio≈1.08). `ratio` is
   * omitted when the before-scale on that axis is ~0 (PopIn from 0). Present
   * whenever both endpoints resolved.
   */
  scaleDelta?: { x: number; y: number; z: number; ratio?: number };
  /** True when any scale axis changed by more than 1% between endpoints. */
  scaled?: boolean;
  /** Opacity change (after − before, round3); present only when both endpoints expose opacity. */
  opacityDelta?: number;
  /**
   * What the node did DURING the window — spawns, visible-child bursts, child
   * motion, state changes — captured by sampling, not just the endpoints. This
   * is what proves a spawner/shooter/pool worked even when its own transform
   * never moved. Present whenever a watch window ran.
   */
  activity?: NodeActivity;
}

/**
 * The running game's own debug snapshot (from a registered `GameDebugProvider`),
 * auto-included when one exists. This is the richest gameplay signal — a game
 * can expose ammo/score/wave/health directly — so verifying "shooting works"
 * can be a state diff (`game.changed['gun.ammo']`) instead of an eyeball call.
 */
export interface GameStateDelta {
  /** Provider name, e.g. 'skydefender'. */
  provider: string;
  /** The snapshot taken AFTER the window (or before, for single-shot observe). */
  snapshot: Json;
  /** Scalar fields that changed over the window: 'gun.ammo.mag' -> [3, 0]. */
  changed?: Record<string, [Json, Json]>;
  /** Set instead of a diff when the provider's snapshot() threw. */
  error?: string;
}

/**
 * What the input layer saw during the window. `observedPolls` is the field that
 * separates "the key never got pressed" from "the game never asks about that
 * key" — the two have identical symptoms (nothing happens) and opposite fixes.
 *
 * It is an OBSERVATION, NOT PROOF that input was handled: it says only that the
 * game called `getAxis`/`getButton` with those names. Proof is an assert on the
 * effect (a node moved, a counter changed).
 */
export interface GameInputObservation {
  /** Action/axis names the running game polled during the window. */
  observedPolls: string[];
  /** True when the input lock was held at any point — nothing reached gameplay. */
  inputLocked?: boolean;
  /** Set when the polled-name cap was hit and later distinct names were dropped. */
  truncated?: boolean;
  /** The observation-not-proof rule, restated where the data is read. */
  note: string;
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
  /** The running game's own debug snapshot + diff, when a GameDebugProvider is registered. */
  game?: GameStateDelta;
  /** What the game asked the input layer for while the script ran (see {@link GameInputObservation}). */
  input?: GameInputObservation;
  /**
   * One-line fused summary of every channel. READ THIS FIRST: `moved:false` does
   * NOT mean the game is dead — a spawner/pool/HUD reacts without moving.
   */
  verdict?: string;
  /**
   * Names that matched more than one live node. The call still ran (against the first match in
   * tree order), but the target it hit is not the one the name uniquely identifies — say so
   * rather than let a duplicate name quietly redirect taps to a stray node.
   */
  ambiguousTargets?: string[];
  /** Set when the input swapped the running scene — see {@link SceneSwap}. */
  sceneChanged?: SceneSwap;
}

/**
 * The running scene was replaced during the window (`scene.changeScene`, a menu button, a restart).
 * Worth its own channel because every other signal reads as absence: the watched nodes vanish with
 * the old scene, so their deltas degrade to "gone" and the fused verdict said NO ACTIVITY for what
 * was in fact the loudest possible reaction. Observed in a dogfooding run and mis-diagnosed as dead
 * input.
 */
export interface SceneSwap {
  /** Root node names of the scene that was running before. */
  fromRoots: string[];
  /** Root node names of the scene running now. */
  toRoots: string[];
}

/**
 * How reachable a listed control is — i.e. whether a finger could land on it right now.
 *
 * Only states we can actually decide are here. In particular there is **no "covered by another
 * control"**: the engine has no global picking pass, every control polls the shared pointer
 * independently, and nothing detects overlap — a tap where two controls overlap fires BOTH. A
 * status promising otherwise would be a lie to whoever reads this listing.
 */
export type ControlReach =
  /**
   * In frame AND a real pointer landed on it — in this session, or in an earlier one whose proof
   * the project journal still vouches for (the context it was earned in has not changed).
   */
  | 'reachable'
  /**
   * Projects inside the canvas, but no physical interaction proves it: either none ever happened,
   * or the journal holds one that has since burned — `reachNote` says which, and why.
   */
  | 'in-frame-unproven'
  /** Projects outside the canvas bounds — off screen, no finger can reach it. */
  | 'off-screen'
  /** Its own `visible` is false: it draws nothing. */
  | 'hidden'
  /** An ancestor is hidden, so the whole subtree draws nothing however this node's flags read. */
  | 'hidden-by-ancestor'
  /** Could not be projected at all (no camera, zero-sized canvas) — nothing is decided. */
  | 'unknown';

/** One declared argument of an interaction, flattened out of the property-schema vocabulary. */
export interface ControlInteractionArg {
  name: string;
  /** Property-schema type: 'number' | 'string' | 'boolean' | … */
  type: string;
  /** True when the interaction declares no default for it — omitting it is refused. */
  required: boolean;
  defaultValue?: Json;
  description?: string;
  /** Allowed values, for arguments that name a set (e.g. Joystick2D `dir`). */
  options?: string[];
  min?: number;
  max?: number;
}

/** One thing that can be done to a listed node. */
export interface ControlInteraction {
  name: string;
  description?: string;
  args?: ControlInteractionArg[];
  /**
   * Type of the script component that declares this interaction. Absent when the node itself
   * declares it (an engine control). Both are invoked the same way — by node name.
   */
  fromComponent?: string;
}

/** One interactive object of the running scene, as listed by `game_controls`. */
export interface LiveControlEntry {
  nodeId: string;
  name: string;
  type: string;
  /** The control's own `enabled`, for nodes that have one. A disabled control refuses everything. */
  enabled?: boolean;
  /** The node's OWN visible flag — not whether it is on screen (see `reach`). */
  visible: boolean;
  /** Nearest hidden ancestor, when this node's own flag is true (see `hiddenByAncestor` elsewhere). */
  hiddenByAncestor?: string;
  reach: ControlReach;
  /** Why `reach` reads the way it does, in one line. */
  reachNote?: string;
  /** The text the node renders right now, when it renders one. */
  text?: string;
  /** Node + component interactions merged, node's own first. */
  interactions: ControlInteraction[];
}

export interface GameControlsResult {
  ok: boolean;
  error?: string;
  controls?: LiveControlEntry[];
  /** Set when the scan hit its cap and later interactive nodes were left out. */
  truncated?: boolean;
  /** The two-channel rule and the overlap gap, restated where the listing is read. */
  note?: string;
  /**
   * Set only when the reach journal could not be used as found: the file was corrupt, foreign or
   * of another version and the listing started from an empty journal, or the last write failed.
   * Silence here means the journal on disk is the one these statuses were decided from.
   */
  journalNote?: string;
}

/**
 * How a tick-budgeted observe window actually ended. Present only when the window
 * was denominated in `frames`, and worth its own channel because a budget that was
 * not met changes what the sample proves: fewer ticks than asked for means the
 * window was cut short, not that the game did less.
 */
export interface ObserveFrameBudget {
  /** Logic ticks the caller asked the window to last. */
  requested: number;
  /** Logic ticks the window actually saw. */
  observed: number;
  /**
   * `frames` — the budget was met exactly; `cap` — the duration cap closed the
   * window before the runner could deliver the ticks; `no-ticks` — nothing ticked
   * at all, so the window degraded to the wall clock.
   */
  endedBy: 'frames' | 'cap' | 'no-ticks';
  /** Why the budget was not met; absent when `endedBy` is 'frames'. */
  note?: string;
}

export interface GameObserveResult {
  ok: boolean;
  error?: string;
  nodes?: Record<string, LiveNodeSnapshot | null>;
  /** Present when a window ran (`sampleMs` or `frames`): per-node movement over it. */
  movement?: Record<string, ObservedNodeDelta>;
  /** Wall-clock length of the window — the requested one, or the measured one under a frame budget. */
  sampleMs?: number;
  /** Present when the window was denominated in ticks — see {@link ObserveFrameBudget}. */
  frameBudget?: ObserveFrameBudget;
  /**
   * Explains any `null` snapshot: whether play mode is still warming up (retry) or the
   * name/id was wrong (a bare null left the model unable to tell those apart).
   */
  hint?: string;
  /** The running game's own debug snapshot (+ diff when sampled), when a provider is registered. */
  game?: GameStateDelta;
  /** What the game polled during a sampled window (see {@link GameInputObservation}). */
  input?: GameInputObservation;
  /**
   * Logic ticks observed during the window. Under a `frames` budget this is the
   * budget itself (or fewer, when the run ended first — the cap closed the window,
   * the scene swapped, the game stopped ticking).
   */
  frames?: number;
  /** One-line fused summary — present when sampleMs > 0 (a window was recorded). */
  verdict?: string;
  /** Set when the scene swapped during a sampled window — see {@link SceneSwap}. */
  sceneChanged?: SceneSwap;
}

const MAX_TOTAL_MS = 15_000;
const MAX_SAMPLE_MS = 5_000;
const DEFAULT_TAP_HOLD_MS = 700;
const DEFAULT_KEY_HOLD_MS = 500;
const DEFAULT_DRAG_MS = 300;
const DEFAULT_HOVER_MS = 800;
const DEFAULT_SETTLE_MS = 300;
const MOVED_THRESHOLD = 0.5;
/** Per-axis scale change that counts as "scaled" (1% — hover-scale presets are 5-10%). */
const SCALE_EPS = 0.01;
/** Opacity change that counts as a fade (5% — below that is float noise / trailing lerp). */
const OPACITY_EPS = 0.05;
/** Dot-product floor for an `expect` verdict to pass (≈ within 45° of the axis). */
const DIRECTION_ALIGN_MIN = 0.7;
/** Distinctive id so synthetic gestures never collide with a real pointer. */
const SYNTHETIC_POINTER_ID = 31337;
/** Wall-clock per logic tick assumed when the runner exposes no time contract. */
const FALLBACK_FRAME_MS = 1000 / 60;
/**
 * Wall-clock headroom a frame-budgeted window gets over its nominal length before
 * {@link MAX_SAMPLE_MS} closes it. Without slack the cap would truncate every
 * budget on a runner that ticks slower than its nominal rate (a heavy frame, a
 * throttled tab) — which is precisely the run you asked to measure in ticks.
 */
const FRAME_BUDGET_SLACK = 2;
/** Floor for that deadline, so a two-frame budget still tolerates a slow start. */
const MIN_FRAME_BUDGET_DEADLINE_MS = 500;
/**
 * How long a frame-budgeted window waits for its FIRST tick before deciding the
 * game is not ticking at all (paused, `manual` time mode, hidden tab, a host with
 * no frame hook) and degrading to the wall clock. Without it, `frames` on a stopped
 * runner would hold the call open for the whole cap.
 */
const FRAME_BUDGET_STALL_MS = 400;
/**
 * The rule that decides which channel to use, restated where the listing is read — and the one
 * thing this listing deliberately does NOT claim.
 */
const CONTROLS_NOTE =
  'Two channels, one rule: an `invoke` step exercises everything AFTER "the point is inside" — enabled, the ancestor-scroll gate, the skin state machine, the signal order, the game logic — but it never checks that a finger could hit the control, because it synthesizes the pointer from the control\'s own transform. So reach the control PHYSICALLY once ({type:\'tap\',target}), which flips its reach to "reachable", and use invoke for everything after that. Reach proofs are kept in the project (design/tests/reachability.json), so one earned in an earlier session still counts — and burns by itself when the control moves, is hidden, is disabled, is scrolled away or leaves the frame (`reachNote` says which). Not listed and not detectable: whether a control is COVERED by another one — the engine has no global picking pass, so a tap where two controls overlap fires both.';
/** Most interactive nodes one `game_controls` call reports (payload discipline). */
const MAX_LISTED_CONTROLS = 60;
/** Cap on nodes the discovery walk visits, so a pathological graph cannot stall the editor. */
const MAX_SCANNED_NODES = 4000;
/** Named in every `input` block so the field is never read as proof of handling. */
const OBSERVED_POLLS_NOTE =
  'observedPolls is an OBSERVATION, not proof that input was handled: it lists the names the game passed to getAxis/getButton during the window. Proof is an assert on the effect.';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const isNonEmptyString = (value: string | undefined): value is string =>
  typeof value === 'string' && value.length > 0;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Max scalar paths reported by a game-snapshot diff (payload discipline). */
const MAX_GAME_DIFF_PATHS = 20;

const isPlainObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Short display form of a Json scalar for one-line verdicts. */
const fmtScalar = (value: Json): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

/**
 * Dot-path diff between two Json snapshots down to `depth` object levels; scalar
 * (and array) leaves that differ become `path -> [before, after]`. Capped so a
 * big game snapshot can't blow up the tool payload.
 */
function diffJsonPaths(before: Json, after: Json, depth = 2): Record<string, [Json, Json]> {
  const out: Record<string, [Json, Json]> = {};
  const walk = (a: Json, b: Json, path: string, d: number): void => {
    if (Object.keys(out).length >= MAX_GAME_DIFF_PATHS) return;
    if (d > 0 && isPlainObject(a) && isPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[key] ?? null, b[key] ?? null, path ? `${path}.${key}` : key, d - 1);
      }
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out[path || '(root)'] = [a, b];
    }
  };
  walk(before, after, '', depth);
  return out;
}

/** Longest text reported per node — a HUD line, not a dialogue script. */
const MAX_SNAPSHOT_TEXT_CHARS = 200;

/**
 * The text a node renders, or null when it renders none. Every text-bearing 2D node descends from
 * `UIControl2D`, which exposes `getDisplayText()` (localization already resolved); a user script
 * node could expose a plain `text` property instead, so that is accepted as a fallback. Duck-typed
 * on purpose: this service must not depend on the runtime's UI class hierarchy.
 */
const readDisplayText = (node: unknown): string | null => {
  const candidate = node as { getDisplayText?: unknown; text?: unknown };
  let value: unknown;
  if (typeof candidate.getDisplayText === 'function') {
    try {
      value = (candidate.getDisplayText as () => unknown)();
    } catch {
      return null; // A throwing accessor must not break the whole snapshot.
    }
  } else if (typeof candidate.text === 'string') {
    value = candidate.text;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value.length > MAX_SNAPSHOT_TEXT_CHARS
    ? `${value.slice(0, MAX_SNAPSHOT_TEXT_CHARS)}…`
    : value;
};

/**
 * Name (or id) of the nearest ancestor that is hidden, or null when the whole chain up to the root
 * is visible. Call only for a node whose own `visible` is true — the interesting case is the
 * mismatch, where every property of the node claims it is shown and three.js draws nothing.
 */
const hiddenByAncestorName = (node: { parent?: unknown }): string | null => {
  let current = node.parent as
    | { visible?: unknown; name?: unknown; nodeId?: unknown; parent?: unknown }
    | null
    | undefined;
  // The three.js Scene at the top has visible === true, so the walk ends naturally at the root.
  while (current) {
    if (current.visible === false) {
      const name = typeof current.name === 'string' && current.name ? current.name : null;
      const id = typeof current.nodeId === 'string' && current.nodeId ? current.nodeId : null;
      return name ?? id ?? 'an ancestor';
    }
    current = current.parent as typeof current;
  }
  return null;
};

/**
 * Interaction state of a `UIControl2D`, or null for a node that is not one. Duck-typed on the three
 * members every control keeps (`isHovering`/`isPressed` are `protected`, which is a compile-time
 * notion only) so this service stays independent of the runtime's UI class hierarchy.
 */
const readControlState = (
  node: unknown
): { enabled: boolean; hovering: boolean; pressed: boolean } | null => {
  const candidate = node as { enabled?: unknown; isHovering?: unknown; isPressed?: unknown };
  if (typeof candidate.isHovering !== 'boolean' || typeof candidate.isPressed !== 'boolean') {
    return null;
  }
  return {
    enabled: candidate.enabled !== false,
    hovering: candidate.isHovering,
    pressed: candidate.isPressed,
  };
};

/** Error text for a note, without leaking a stack into a tool result. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * World position of a live node, via three.js' own accessor. Duck-typed: a spec fake that only
 * carries a `position` is read from that instead of being refused.
 */
const readWorldPosition = (node: unknown): { x: number; y: number; z: number } => {
  const candidate = node as {
    getWorldPosition?: (target: Vector3) => { x: number; y: number; z: number };
    position?: { x?: unknown; y?: unknown; z?: unknown };
  };
  if (typeof candidate.getWorldPosition === 'function') {
    try {
      const world = candidate.getWorldPosition(new Vector3());
      return { x: world.x, y: world.y, z: world.z };
    } catch {
      // fall through to the local position
    }
  }
  const local = candidate.position;
  return {
    x: typeof local?.x === 'number' ? local.x : 0,
    y: typeof local?.y === 'number' ? local.y : 0,
    z: typeof local?.z === 'number' ? local.z : 0,
  };
};

/**
 * The control's AUTHORED size, for nodes that expose one. Authored on purpose: `scale` is
 * animation state (a hover pop, a PunchScale), and stamping a proof with it would burn the proof
 * one frame after the tap that earned it.
 */
const readAuthoredSize = (node: unknown): [number, number] | null => {
  const candidate = node as { width?: unknown; height?: unknown };
  if (typeof candidate.width !== 'number' || typeof candidate.height !== 'number') return null;
  if (!Number.isFinite(candidate.width) || !Number.isFinite(candidate.height)) return null;
  // A zero dimension is not "zero-sized", it is "no authored size": an auto-sized Label2D lays
  // itself out from its text and reports 0x0 while being perfectly tappable. Reading that as a
  // collapsed control would have stamped every label's proof with a lie (observed live).
  if (candidate.width <= 0 || candidate.height <= 0) return null;
  return [candidate.width, candidate.height];
};

/**
 * Has the control collapsed to nothing? The discrete counterpart of leaving `scale` out of the
 * context: a permanent scale-to-zero still has to burn a proof, while a 1.05 hover pop must not.
 */
const isCollapsed = (node: unknown): boolean => {
  const candidate = node as { getWorldScale?: (target: Vector3) => Vector3 };
  if (typeof candidate.getWorldScale !== 'function') return false;
  try {
    const scale = candidate.getWorldScale(new Vector3());
    return Math.abs(scale.x) < 0.001 || Math.abs(scale.y) < 0.001;
  } catch {
    return false;
  }
};

/**
 * The slice of a live node the interaction walk needs. Structural, like every other view this
 * service takes of the runtime, so a spec fake and a real `NodeBase` are equally walkable.
 */
interface ScanNode {
  nodeId: string;
  name: string;
  type: string;
  visible: boolean;
  parent?: unknown;
  children?: unknown[];
  components?: unknown[];
}

/**
 * Whether an Object3D child is a scene node. Duck-typed on `nodeId`: a node's children include its
 * own meshes, which carry `children` too and would otherwise be walked as if they were nodes.
 */
const isScanNode = (value: unknown): value is ScanNode => {
  const candidate = value as Partial<ScanNode> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.nodeId === 'string' &&
    typeof candidate.type === 'string'
  );
};

/**
 * Name of the nearest ancestor scroll container, or null. Used only to EXPLAIN a refusal: a
 * control inside a scroller is denied the pointer while the scroller has claimed the gesture or
 * has clipped the control out of its viewport, and "returned false" alone sends the reader
 * hunting through the control instead of the list around it.
 *
 * Duck-typed on the scroll offset rather than on the class, like everything else here.
 */
const ancestorScrollContainerName = (node: { parent?: unknown }): string | null => {
  let current = node.parent as
    | { type?: unknown; scrollY?: unknown; name?: unknown; nodeId?: unknown; parent?: unknown }
    | null
    | undefined;
  while (current) {
    if (current.type === 'ScrollContainer2D' || typeof current.scrollY === 'number') {
      const name = typeof current.name === 'string' && current.name ? current.name : null;
      const id = typeof current.nodeId === 'string' && current.nodeId ? current.nodeId : null;
      return name ?? id ?? 'an ancestor scroll container';
    }
    current = current.parent as typeof current;
  }
  return null;
};

/** Flatten one interaction argument out of the property-schema vocabulary it is declared in. */
const describeInteractionArg = (
  arg: NonNullable<InteractionDescriptor['args']>[number]
): ControlInteractionArg => {
  const ui = arg.ui ?? {};
  const options = Array.isArray(ui.options)
    ? ui.options
    : ui.options && typeof ui.options === 'object'
      ? Object.keys(ui.options)
      : undefined;
  return {
    name: arg.name,
    type: arg.type,
    // No `required` flag exists in the schema vocabulary: an argument with no default is one the
    // interaction cannot run without, which is exactly what the controls refuse on.
    required: arg.defaultValue === undefined,
    ...(arg.defaultValue !== undefined ? { defaultValue: arg.defaultValue as Json } : {}),
    ...(ui.description ? { description: ui.description } : {}),
    ...(options?.length ? { options } : {}),
    ...(typeof ui.min === 'number' ? { min: ui.min } : {}),
    ...(typeof ui.max === 'number' ? { max: ui.max } : {}),
  };
};

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
    const frameMs = this.frameDurationMs(runtime.runner);
    const totalMs = steps.reduce(
      (sum, step) => sum + this.stepDurationMs(step, frameMs),
      options?.settleMs ?? DEFAULT_SETTLE_MS
    );
    if (totalMs > MAX_TOTAL_MS) {
      return failure(
        `Input script too long: ~${Math.round(totalMs)}ms requested, the cap is ${MAX_TOTAL_MS}ms. Split it into several game_input calls.`
      );
    }

    // Before the first step, so a proof earned in this run merges onto the project journal instead
    // of racing a load that would arrive after it.
    await this.loadJournal();

    const { runner } = runtime;
    const errorsBefore = capturedErrors().length;
    const wasPaused = runner.paused;
    // Input is driven in realtime, so a held pause (a previous `game_run`'s
    // outcome frame, most often) would swallow the whole script: the events land
    // and no tick ever polls them. Releasing the host-held pause is what makes
    // the resume below stick — the host re-applies its own pause decision on
    // every focus event, including the suppression toggle on the next line.
    this.playSession.setPauseRequested(false);
    this.playSession.setFocusPauseSuppressed(true);
    // Any node named in `expect` is implicitly observed, so a model can just state its assertion.
    const observeQueries = Array.from(
      new Set([...(options?.observe ?? []), ...Object.keys(options?.expect ?? {})])
    );
    let stepsRun = 0;
    const recorder = observeQueries.length ? this.makeRecorder(runner, observeQueries) : null;
    const inputService = this.resolveInputService(runner);
    try {
      const before = this.snapshotMany(runner, observeQueries);
      const rootsBefore = this.rootIdentity(runner);
      const gameBefore = this.snapshotGame();
      recorder?.start();
      inputService?.startPollRecording();

      for (const step of steps) {
        const stepError = await this.runStep(runtime, step, frameMs);
        if (stepError) {
          recorder?.stop();
          inputService?.stopPollRecording();
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
      const input = this.collectObservedPolls(inputService);

      const activities = recorder ? recorder.stop() : new Map<string, NodeActivity>();
      const gameAfter = this.snapshotGame();
      const game = this.describeGameDelta(gameBefore, gameAfter);

      const observed: Record<string, ObservedNodeDelta> = {};
      for (const [query, beforeSnap] of before) {
        const afterSnap = this.snapshotOne(runner, query);
        const delta = this.describeDelta(beforeSnap, afterSnap);
        const activity = activities.get(query);
        if (activity) delta.activity = activity;
        observed[query] = delta;
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

      const newErrors = this.newErrorsSince(errorsBefore);
      const ambiguousTargets = this.ambiguousQueries(runner, [
        ...steps.flatMap(step => [step.target, step.to?.target]).filter(isNonEmptyString),
        ...observeQueries,
      ]);
      const sceneChanged = this.detectSceneSwap(rootsBefore, this.rootIdentity(runner));
      return {
        ok: true,
        stepsRun,
        resumedFromFocusPause: wasPaused,
        ...(ambiguousTargets.length ? { ambiguousTargets } : {}),
        ...(sceneChanged ? { sceneChanged } : {}),
        ...(observeQueries.length ? { observed } : {}),
        ...(game ? { game } : {}),
        ...(input ? { input } : {}),
        // A scene swap is a reaction in its own right, so it earns a verdict even when nothing was
        // being watched — otherwise the single loudest outcome of a tap is reported as silence.
        ...(observeQueries.length || game || sceneChanged
          ? {
              verdict: this.buildVerdict(
                observed,
                game,
                newErrors.length,
                recorder?.droppedWatchCount ?? 0,
                sceneChanged,
                { input, steps }
              ),
            }
          : {}),
        newErrors,
      };
    } finally {
      inputService?.stopPollRecording();
      this.playSession.setFocusPauseSuppressed(false);
      // The tool-call boundary is where the journal hits the disk: awaited (so a proof is on disk
      // before the agent can act on the answer and reload the page), once per call (so a twenty-tap
      // script writes once, not twenty times inside a real-time loop), and unable to fail the call
      // — a write error is carried into `game_controls` as `journalNote` instead.
      await this.flushJournal();
    }
  }

  /**
   * Snapshot live nodes now; with a window budget, sample again and report movement.
   *
   * The window has two denominations and **`frames` wins whenever it is given** —
   * the rule input steps already follow. Wall clock is not a stable unit for an
   * assertion: under the time contract's `fixed` mode at ×4 a "2000 ms" window is
   * eight seconds of game time, so the meaning of a regression check changes
   * silently with the speed it happens to run at. A tick budget is reproducible.
   * `sampleMs` stays the default and remains the only sensible unit for `realtime`
   * (and for any host that exposes no frame hook).
   */
  async observe(queries: string[], sampleMs = 0, frames?: number): Promise<GameObserveResult> {
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
    // Names shared by several live nodes are reported alongside: the snapshot below is of one of
    // them, chosen by tree order, which is not what the caller asked for.
    const ambiguous = this.ambiguousQueries(runtime.runner, targets);
    const ambiguityNote = ambiguous.length
      ? `Ambiguous — more than one live node is named: ${ambiguous.join(', ')}. Reported values are the first match in tree order; target by nodeId (scene_tree) to be sure.`
      : undefined;
    // A node whose own flag says visible while an ancestor hides it is the single most misleading
    // state a snapshot can carry, so it goes in the hint rather than waiting to be noticed in a
    // field: "visible: true, text: ПОБЕДА" described a win screen that was never drawn.
    const offScreenNote = (
      snapshots: Array<[string, LiveNodeSnapshot | null]>
    ): string | undefined => {
      const hidden = snapshots
        .filter(([, snap]) => snap?.hiddenByAncestor !== undefined)
        .map(([query, snap]) => `${query} (behind hidden "${snap?.hiddenByAncestor}")`);
      return hidden.length
        ? `NOT ON SCREEN despite visible: true — ${hidden.join(', ')}. An invisible ancestor hides the whole subtree: these nodes render nothing and cannot be tapped. Show the ancestor.`
        : undefined;
    };
    const hintFor = (
      unresolved: string[],
      snapshots: Array<[string, LiveNodeSnapshot | null]>
    ): string | undefined => {
      const unresolvedNote =
        unresolved.length === 0
          ? undefined
          : hasLiveNodes
            ? `Not resolved by name/id: ${unresolved.join(', ')}. Check exact names with scene_tree.`
            : 'Play mode is still warming up (no live nodes yet) — wait ~300ms and retry.';
      return (
        [offScreenNote(snapshots), unresolvedNote, ambiguityNote].filter(Boolean).join(' ') ||
        undefined
      );
    };
    const framesRequested =
      typeof frames === 'number' && Number.isFinite(frames) && frames >= 1
        ? Math.floor(frames)
        : null;
    if (!(sampleMs > 0) && framesRequested === null) {
      const hint = hintFor(
        first.filter(([, snap]) => snap === null).map(([query]) => query),
        first
      );
      const game = this.describeGameDelta(null, this.snapshotGame());
      return {
        ok: true,
        nodes: Object.fromEntries(first),
        ...(game ? { game } : {}),
        ...(hint ? { hint } : {}),
      };
    }

    const frameMs = this.frameDurationMs(runtime.runner);
    // A frame budget's nominal wall clock is only used to size the timers around it —
    // the window itself ends on the Nth tick.
    const clampedMs =
      framesRequested !== null
        ? Math.min(MAX_SAMPLE_MS, Math.max(0, framesRequested * frameMs))
        : Math.min(sampleMs, MAX_SAMPLE_MS);
    const recorder = this.makeRecorder(runtime.runner, targets);
    const inputService = this.resolveInputService(runtime.runner);
    this.playSession.setFocusPauseSuppressed(true);
    try {
      const rootsBefore = this.rootIdentity(runtime.runner);
      const gameBefore = this.snapshotGame();
      recorder.start();
      inputService?.startPollRecording();
      let budget: (ObserveFrameBudget & { elapsedMs: number }) | null = null;
      if (framesRequested !== null) {
        budget = await this.awaitFrameBudget(
          this.resolveFrameSource(runtime.runner),
          framesRequested,
          frameMs
        );
      } else {
        await sleep(clampedMs);
      }
      const input = this.collectObservedPolls(inputService);
      const activities = recorder.stop();
      // Under a frame budget the awaiter is the authority on tick count: it counts the
      // same hook the recorder does, but it is armed even when no query resolved.
      const framesObserved = budget ? budget.observed : recorder.framesObserved;
      const gameAfter = this.snapshotGame();
      const game = this.describeGameDelta(gameBefore, gameAfter);

      const movement: Record<string, ObservedNodeDelta> = {};
      for (const [query, beforeSnap] of first) {
        const delta = this.describeDelta(beforeSnap, this.snapshotOne(runtime.runner, query));
        const activity = activities.get(query);
        if (activity) delta.activity = activity;
        movement[query] = delta;
      }
      const hint =
        [
          hintFor(
            Object.entries(movement)
              .filter(([, delta]) => delta.after === null)
              .map(([query]) => query),
            // End-of-window state: a node hidden all along should say so here, not in `first`.
            Object.entries(movement).map(([query, delta]) => [query, delta.after])
          ),
          budget?.note,
          // Observing a paused game is legitimate — it is what `pauseOnOutcome`
          // exists for — but a window with no ticks in it must not read as "the
          // game did nothing".
          runtime.runner.paused
            ? 'The game is PAUSED (game_run leaves it paused on its outcome frame), so no time passed during this window and every delta is necessarily zero. Resume with game_time {paused: false} to watch it move.'
            : undefined,
        ]
          .filter(Boolean)
          .join(' ') || undefined;
      const sceneChanged = this.detectSceneSwap(rootsBefore, this.rootIdentity(runtime.runner));
      return {
        ok: true,
        nodes: Object.fromEntries(first),
        movement,
        sampleMs: budget ? Math.round(budget.elapsedMs) : clampedMs,
        ...(budget
          ? {
              frameBudget: {
                requested: budget.requested,
                observed: budget.observed,
                endedBy: budget.endedBy,
                ...(budget.note ? { note: budget.note } : {}),
              },
            }
          : {}),
        ...(framesObserved > 0 ? { frames: framesObserved } : {}),
        ...(game ? { game } : {}),
        ...(input ? { input } : {}),
        ...(sceneChanged ? { sceneChanged } : {}),
        verdict: this.buildVerdict(movement, game, 0, recorder.droppedWatchCount, sceneChanged, {
          input,
        }),
        ...(hint ? { hint } : {}),
      };
    } finally {
      inputService?.stopPollRecording();
      this.playSession.setFocusPauseSuppressed(false);
    }
  }

  // -- interaction discovery ---------------------------------------------------

  /**
   * Every addressable object of the RUNNING scene, in one call: the controls the engine ships and
   * anything a script component declares interactions for. This is what replaces "read the whole
   * tree, then guess which nodes are buttons and where they are".
   */
  async listControls(): Promise<GameControlsResult> {
    if (!appState.ui.isPlaying) {
      return {
        ok: false,
        error:
          'The game is not running — game_controls lists the LIVE scene. Call play_start first (the authored graph is available via scene_tree).',
      };
    }
    const runtime = this.playSession.getActiveRuntime();
    if (!runtime) {
      return {
        ok: false,
        error: 'Play mode is starting but the runtime is not attached yet; retry in a moment.',
      };
    }
    // Awaited, not fired-and-forgotten: a listing that ran before the journal arrived would report
    // "unproven" for controls the project has proofs for — the exact false negative this replaces.
    await this.loadJournal();
    const { controls, truncated } = this.collectControls(runtime);
    return {
      ok: true,
      controls,
      ...(truncated ? { truncated: true } : {}),
      note: CONTROLS_NOTE,
      ...(() => {
        const journalNote = this.buildJournalNote();
        return journalNote ? { journalNote } : {};
      })(),
    };
  }

  /**
   * Walk the live scene depth-first and keep every node that offers interactions — its own (an
   * engine control) or a script component's. Tree order is preserved, so the listing reads like the
   * scene: a dialog's buttons stay together and under it.
   */
  private collectControls(runtime: { runner: SceneRunner; canvas: HTMLCanvasElement }): {
    controls: LiveControlEntry[];
    truncated: boolean;
  } {
    const controls: LiveControlEntry[] = [];
    let visited = 0;
    let truncated = false;
    const visit = (node: ScanNode): void => {
      if (visited++ >= MAX_SCANNED_NODES) {
        truncated = true;
        return;
      }
      const entry = this.describeControl(runtime, node);
      if (entry) {
        if (controls.length >= MAX_LISTED_CONTROLS) {
          truncated = true;
        } else {
          controls.push(entry);
        }
      }
      for (const child of node.children ?? []) {
        // Duck-typed on `nodeId` rather than `instanceof NodeBase`: a node's Object3D children also
        // include its own meshes, which have `children` too and must not be walked as scene nodes.
        if (isScanNode(child)) visit(child);
      }
    };
    for (const root of runtime.runner.getLiveRootNodes()) {
      if (isScanNode(root)) visit(root as unknown as ScanNode);
    }
    return { controls, truncated };
  }

  /** One listing entry, or null when the node offers no interactions at all. */
  private describeControl(
    runtime: { runner: SceneRunner; canvas: HTMLCanvasElement },
    node: ScanNode
  ): LiveControlEntry | null {
    const owners = this.interactionOwners(node);
    if (owners.length === 0) {
      return null;
    }
    const interactions: ControlInteraction[] = [];
    for (const owner of owners) {
      for (const descriptor of owner.descriptors) {
        const args = descriptor.args?.map(describeInteractionArg);
        interactions.push({
          name: descriptor.name,
          ...(descriptor.description ? { description: descriptor.description } : {}),
          ...(args?.length ? { args } : {}),
          ...(owner.componentType ? { fromComponent: owner.componentType } : {}),
        });
      }
    }
    const control = readControlState(node);
    const hiddenBy = node.visible ? hiddenByAncestorName(node) : null;
    const reach = this.describeReach(runtime, node, hiddenBy);
    const text = readDisplayText(node);
    return {
      nodeId: node.nodeId,
      name: node.name,
      type: node.type,
      ...(control ? { enabled: control.enabled } : {}),
      visible: node.visible,
      ...(hiddenBy !== null ? { hiddenByAncestor: hiddenBy } : {}),
      reach: reach.reach,
      ...(reach.note ? { reachNote: reach.note } : {}),
      ...(text !== null ? { text } : {}),
      interactions,
    };
  }

  /**
   * The three sources of interactions, merged: the node itself (engine controls) first, then each
   * script component that declares them. A component's list is kept whole — a name it shares with
   * the node's own set is simply listed twice, `fromComponent` apart, because collapsing them would
   * hide the fact that two different implementations answer to it.
   */
  private interactionOwners(node: ScanNode): Array<{
    owner: Interactive;
    componentType?: string;
    descriptors: InteractionDescriptor[];
  }> {
    const owners: Array<{
      owner: Interactive;
      componentType?: string;
      descriptors: InteractionDescriptor[];
    }> = [];
    const push = (candidate: unknown, componentType?: string): void => {
      if (!isInteractive(candidate)) return;
      let descriptors: InteractionDescriptor[];
      try {
        descriptors = candidate.getInteractions();
      } catch {
        // A throwing declaration must not take the whole listing down with it.
        return;
      }
      if (!Array.isArray(descriptors) || descriptors.length === 0) return;
      owners.push({
        owner: candidate,
        ...(componentType ? { componentType } : {}),
        descriptors: descriptors.filter(entry => typeof entry?.name === 'string'),
      });
    };
    push(node);
    for (const component of node.components ?? []) {
      const type = (component as { type?: unknown }).type;
      push(component, typeof type === 'string' ? type : 'component');
    }
    return owners.filter(entry => entry.descriptors.length > 0);
  }

  /**
   * How reachable this node is right now. Everything here is decided from state we can actually
   * read; the one thing the semantic channel can never establish — that a finger landed on the
   * control — is reported as `reachable` only when a PHYSICAL step proved it AND the context that
   * proof was earned in still holds (this session's proofs and the project journal's are judged by
   * exactly the same rule — see `reachability-journal.ts`).
   */
  private describeReach(
    runtime: { runner: SceneRunner; canvas: HTMLCanvasElement },
    node: ScanNode,
    hiddenByAncestor: string | null
  ): { reach: ControlReach; note?: string } {
    if (!node.visible) {
      return { reach: 'hidden', note: 'Its own visible is false, so it draws nothing.' };
    }
    if (hiddenByAncestor !== null) {
      return {
        reach: 'hidden-by-ancestor',
        note: `Ancestor "${hiddenByAncestor}" is hidden, so the whole subtree draws nothing — show the ancestor, not the children.`,
      };
    }
    const projection = this.projectForReach(runtime, node);
    if (projection.frame === 'unknown') {
      return { reach: 'unknown', note: projection.note };
    }
    if (projection.frame === 'out') {
      return { reach: 'off-screen', note: projection.note };
    }
    const proof = this.reachProofs.get(proofKey(this.currentSceneId(), node.nodeId));
    if (!proof) {
      return {
        reach: 'in-frame-unproven',
        note: 'In frame, but no physical tap/hover has ever landed on it (nothing in design/tests/reachability.json either) — invoke proves everything except that a finger can hit it.',
      };
    }
    const current = this.captureReachContext(node, projection.frame);
    const verdict = compareReachContext(proof.context, current);
    if (verdict.matches) {
      return {
        reach: 'reachable',
        note: this.sessionProofs.has(proofKey(this.currentSceneId(), node.nodeId))
          ? 'A real pointer landed on it during this session.'
          : `A real pointer landed on it on ${proof.provenAt.slice(0, 19).replace('T', ' ')}Z and the journal's context still matches.`,
      };
    }
    // The most useful signal the journal produces: there IS a proof, and here is what changed
    // since. Silently downgrading to "unproven" would throw that away.
    return {
      reach: 'in-frame-unproven',
      note: `A physical proof exists (${proof.provenAt.slice(0, 10)}, hash ${proof.hash}) but it has BURNED: ${verdict.reason}. Tap it physically again to re-prove it.`,
    };
  }

  /**
   * The normalized view fact the journal stores: does the control land inside the frame at all.
   * Deliberately not the pixel position — see the module comment in `reachability-journal.ts` for
   * why viewport/DPR/canvas/camera enter the context only through this in/out answer.
   */
  private projectForReach(
    runtime: { runner: SceneRunner; canvas: HTMLCanvasElement },
    node: ScanNode
  ): { frame: ReachFrame; note?: string } {
    let point: { x: number; y: number } | null = null;
    try {
      point = runtime.runner.projectNodeToCanvas(node as unknown as NodeBase);
    } catch {
      point = null;
    }
    if (!point) {
      return {
        frame: 'unknown',
        note: 'Could not be projected to the canvas (no camera, or the canvas has no size yet).',
      };
    }
    const width = runtime.canvas.width;
    const height = runtime.canvas.height;
    if (!(width > 0) || !(height > 0)) {
      return { frame: 'unknown', note: 'The game canvas has no size yet.' };
    }
    if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) {
      return {
        frame: 'out',
        note: `Its origin projects to ${Math.round(point.x)},${Math.round(point.y)} on a ${width}x${height} canvas — outside the frame, so no finger can reach it.`,
      };
    }
    return { frame: 'in' };
  }

  /**
   * Everything a proof is stamped with, read off the live node. Continuous fields (world position,
   * size, ancestor scroll) are stored raw-ish and compared with a tolerance; the discrete ones are
   * compared exactly and are what {@link contextHash} digests.
   */
  private captureReachContext(node: ScanNode, frame: ReachFrame): ReachContext {
    const ancestors: string[] = [];
    const hiddenAncestors: string[] = [];
    const scroll: number[] = [];
    let current = (node as { parent?: unknown }).parent as
      | { nodeId?: unknown; visible?: unknown; scrollY?: unknown; parent?: unknown }
      | null
      | undefined;
    let guard = 0;
    while (current && guard++ < 128) {
      if (typeof current.nodeId === 'string' && current.nodeId) {
        ancestors.push(current.nodeId);
        if (current.visible === false) hiddenAncestors.push(current.nodeId);
        // Duck-typed on the offset rather than the class, like everything else here: a scroll
        // container that scrolled away carries the control with it, and the proof must burn.
        if (typeof current.scrollY === 'number') scroll.push(current.scrollY);
      }
      current = current.parent as typeof current;
    }
    ancestors.reverse();
    hiddenAncestors.reverse();
    scroll.reverse();

    const world = readWorldPosition(node);
    const size = readAuthoredSize(node);
    const control = readControlState(node);
    return normalizeContext({
      ancestors: ancestors.join('>'),
      hiddenAncestors: hiddenAncestors.join('>'),
      visible: node.visible,
      enabled: control ? control.enabled : null,
      collapsed: isCollapsed(node),
      frame,
      world: [world.x, world.y, world.z],
      size,
      scroll,
    });
  }

  /**
   * The scene a proof belongs to. `nodeId`s are unique inside a scene, not across scenes, and the
   * same id in another scene is another control — so the journal is keyed by both.
   */
  private currentSceneId(): string {
    return appState.scenes.activeSceneId ?? '';
  }

  /**
   * Proofs, keyed `sceneId::nodeId`: the project journal merged with what this session earned.
   * Persisted to {@link REACHABILITY_JOURNAL_PATH} — the whole point of the journal is that a
   * proof outlives the page that earned it.
   */
  private readonly reachProofs = new Map<string, ReachProof>();
  /** Keys proved in THIS session, for wording only ("just now" vs "and the journal still holds"). */
  private readonly sessionProofs = new Set<string>();
  private reachStore: ReachabilityStore | null = null;
  private journalLoad: Promise<void> | null = null;
  private journalDirty = false;
  private journalWrite: Promise<void> = Promise.resolve();
  /** Why the journal on disk was not usable as found, if it was not. */
  private journalReset?: string;
  /** How many individual entries of an otherwise valid journal were unreadable. */
  private journalDropped = 0;
  /** Why the last write failed, if it did. */
  private journalWriteError?: string;
  /** A successful write has happened since — so a reset is history, not a pending threat. */
  private journalRewritten = false;

  /**
   * Swap the journal backend. Production leaves it alone (the project file); specs hand in an
   * in-memory store — which is also how "the proof survives a reload" is expressed: a second
   * service over the same store is exactly what a reloaded editor is.
   */
  setReachabilityStore(store: ReachabilityStore): void {
    this.reachStore = store;
    this.journalLoad = null;
    this.reachProofs.clear();
    this.sessionProofs.clear();
    this.journalReset = undefined;
    this.journalDropped = 0;
    this.journalWriteError = undefined;
    this.journalRewritten = false;
  }

  /**
   * The one line `game_controls` carries when the journal could not be used as found. Derived, not
   * latched: once a fresh journal has actually been written, the reset is reported in the past
   * tense instead of promising a rewrite that already happened.
   */
  private buildJournalNote(): string | undefined {
    if (this.journalWriteError) {
      return `Could not write ${REACHABILITY_JOURNAL_PATH} (${this.journalWriteError}); reach proofs earned now will not survive a reload.`;
    }
    if (this.journalReset) {
      return this.journalRewritten
        ? `${REACHABILITY_JOURNAL_PATH} was unusable (${this.journalReset}) and has been replaced with a fresh journal; proofs from before it are gone, proofs earned since are saved.`
        : `${REACHABILITY_JOURNAL_PATH} is being ignored and a fresh journal started because ${this.journalReset}. Earlier proofs are gone; the file is rewritten on the next physical tap.`;
    }
    if (this.journalDropped) {
      return `${this.journalDropped} unreadable entr${this.journalDropped === 1 ? 'y was' : 'ies were'} dropped from ${REACHABILITY_JOURNAL_PATH}; the rest of the journal is intact.`;
    }
    return undefined;
  }

  private store(): ReachabilityStore {
    if (!this.reachStore) this.reachStore = new ProjectFileReachabilityStore();
    return this.reachStore;
  }

  /**
   * Read the journal once per session (or once per store swap). A missing file is silence, not an
   * error; a corrupt or foreign one starts an empty journal and SAYS so through `journalNote`,
   * because quietly discarding somebody's file is how a tool loses trust.
   */
  private loadJournal(): Promise<void> {
    if (!this.journalLoad) {
      this.journalLoad = (async () => {
        let text: string | null = null;
        try {
          text = await this.store().read();
        } catch (error) {
          this.journalReset = `it could not be read (${describeError(error)})`;
          return;
        }
        if (text === null) return;
        const parsed = parseJournal(text);
        if (parsed.reset) this.journalReset = parsed.reset;
        this.journalDropped = parsed.droppedEntries ?? 0;
        for (const proof of parsed.proofs) {
          const key = proofKey(proof.sceneId, proof.nodeId);
          // In-session proofs win: they were earned against the live scene a moment ago, the file
          // may be older (or written by another editor tab).
          if (!this.reachProofs.has(key)) this.reachProofs.set(key, proof);
        }
      })();
    }
    return this.journalLoad;
  }

  /**
   * Write the journal, at most one write in flight. Called at the END of a `game_input` call, not
   * per tap: a script can tap twenty controls, and each of those is inside a real-time loop where a
   * file write would compete with the frames the input is being judged by. One write per tool call
   * is also the granularity that matters — a proof only has to survive a page reload, and nothing
   * can reload between two steps of the same script.
   */
  private flushJournal(): Promise<void> {
    if (!this.journalDirty) return this.journalWrite;
    this.journalDirty = false;
    const text = serializeJournal([...this.reachProofs.values()]);
    this.journalWrite = this.journalWrite
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.store().write(text);
          this.journalWriteError = undefined;
          this.journalRewritten = true;
        } catch (error) {
          // A journal that cannot be saved must never fail the input run — the game was still
          // driven and the proof still holds for this session. It is reported, not thrown.
          this.journalDirty = true;
          this.journalWriteError = describeError(error);
        }
      });
    return this.journalWrite;
  }

  /** Flush pending proofs — for a host that wants the journal on disk before it tears the page down. */
  async dispose(): Promise<void> {
    await this.flushJournal();
  }

  /**
   * Credit the journal for a physical press driven OUTSIDE this service — a bot policy's own
   * pointer (`GameTestService.buildBotWorld`).
   *
   * A bot tap is the same gesture as a `game_input` tap: a real pointer at the projected node,
   * witnessed by the control's own bounds check. Without this entry point a run in which the policy
   * provably pressed a button still left that control `in-frame-unproven`, so the "one physical
   * proof per control" invariant never accumulated from bot runs. Pair it with
   * {@link flushReachJournal} once the run is over — proofs are written per run, not per tap.
   */
  noteExternalPhysicalReach(
    runtime: { runner: SceneRunner; canvas: HTMLCanvasElement },
    target: string | undefined
  ): void {
    this.notePhysicalReach(runtime, target);
  }

  /** Persist proofs recorded through {@link noteExternalPhysicalReach}. No-op when none are pending. */
  async flushReachJournal(): Promise<void> {
    await this.flushJournal();
  }

  /**
   * Record that a physical step reached its target. For a UI control the control itself is the
   * witness — `hovering`/`pressed` are set by its own bounds check against the real pointer — so a
   * tap that projected onto empty space is NOT recorded. A node with no control state (a script
   * component's clickable object) has no such witness, so the aim resolving and projecting is all
   * the physical channel can say, and it is recorded as that.
   */
  private notePhysicalReach(
    runtime: { runner: SceneRunner; canvas: HTMLCanvasElement },
    target: string | undefined
  ): void {
    if (!target) return;
    const node = this.findLiveNode(runtime.runner, target);
    if (!node) return;
    const control = readControlState(node);
    if (control && !control.hovering && !control.pressed) return;
    const scan = node as unknown as ScanNode;
    // Stamped with the context it was earned in, so it can burn by itself later. Captured while
    // the finger is still down — which is why transient press state (scale) is not part of it.
    const context = this.captureReachContext(scan, this.projectForReach(runtime, scan).frame);
    const sceneId = this.currentSceneId();
    const key = proofKey(sceneId, scan.nodeId);
    this.reachProofs.set(key, {
      nodeId: scan.nodeId,
      name: scan.name,
      sceneId,
      hash: contextHash(context, sceneId),
      context,
      provenAt: new Date().toISOString(),
    });
    this.sessionProofs.add(key);
    this.journalDirty = true;
  }

  /**
   * Drive one interaction by name. Returns null on success, or the refusal to report — every
   * `false` from the runtime is turned into a sentence naming the reason we can establish, because
   * a bare "it returned false" is exactly the silence this channel exists to remove.
   */
  private invokeInteractionOn(
    node: ScanNode,
    interaction: string,
    args: Record<string, unknown> | undefined
  ): string | null {
    const label = `"${node.name || node.nodeId}" (${node.type})`;
    const owners = this.interactionOwners(node);
    if (owners.length === 0) {
      return `${label} is not interactive: neither the node nor any of its script components declares interactions. Use game_controls to see what is, or drive this node physically with {type:'tap'}.`;
    }
    const match = owners.find(entry =>
      entry.descriptors.some(descriptor => descriptor.name === interaction)
    );
    if (!match) {
      const available = owners
        .flatMap(entry => entry.descriptors.map(descriptor => descriptor.name))
        .join(', ');
      return `${label} has no interaction "${interaction}". It offers: ${available}. (Listings are per-frame — re-read game_controls if yours is old.)`;
    }
    const descriptor = match.descriptors.find(entry => entry.name === interaction)!;
    const missing = (descriptor.args ?? [])
      .filter(arg => arg.defaultValue === undefined)
      .filter(arg => args?.[arg.name] === undefined || args?.[arg.name] === null)
      .map(arg => arg.name);
    if (missing.length) {
      return `Interaction "${interaction}" on ${label} needs argument(s) ${missing.join(', ')}: pass them in \`args\`, e.g. {type:'invoke',target:'${node.name || node.nodeId}',interaction:'${interaction}',args:{${missing[0]}: …}}.`;
    }
    let delivered = false;
    try {
      delivered = match.owner.invokeInteraction(interaction, args);
    } catch (err) {
      return `Interaction "${interaction}" on ${label} threw: ${err instanceof Error ? err.message : String(err)}.`;
    }
    if (delivered) {
      return null;
    }
    const control = readControlState(node);
    if (control && !control.enabled) {
      return `${label} refused "${interaction}": the control is enabled:false, so it accepts nothing — a real tap would fail the same way. Enable it (or fix whatever should have) and retry.`;
    }
    const scroller = ancestorScrollContainerName(node);
    if (scroller) {
      return `${label} refused "${interaction}": its ancestor scroll container "${scroller}" has the pointer — the control is scrolled out of the viewport or the container has claimed the gesture. Bring it into view first (invoke scrollTo on "${scroller}"), then retry.`;
    }
    return `${label} refused "${interaction}" (the runtime returned false). Nothing here says the control is disabled or gated by a scroll ancestor, so the likely cause is an argument it could not use${
      descriptor.args?.length ? ` (${descriptor.args.map(arg => arg.name).join(', ')})` : ''
    }, or a node-specific gate — check game_controls for the current listing and this node's state.`;
  }

  // -- steps -------------------------------------------------------------------

  /**
   * Wall-clock a step should last. `frames` wins over `ms`/`holdMs` whenever it
   * is given — everything else keeps its old default, so existing scripts are
   * untouched.
   */
  private stepDurationMs(step: GameInputStep, frameMs: number): number {
    if (typeof step.frames === 'number' && Number.isFinite(step.frames) && step.frames >= 0) {
      return step.frames * frameMs;
    }
    switch (step.type) {
      case 'tap':
        return Math.max(0, step.holdMs ?? DEFAULT_TAP_HOLD_MS);
      case 'key':
      case 'keys':
        return Math.max(0, step.ms ?? DEFAULT_KEY_HOLD_MS);
      case 'drag':
        return Math.max(0, step.ms ?? DEFAULT_DRAG_MS);
      case 'hover':
        return Math.max(0, step.ms ?? DEFAULT_HOVER_MS);
      // An invocation is instantaneous — it feeds the funnel synchronously — so any `ms`/`frames`
      // on it is dwell AFTER the call (hold a latched press, let a hover be seen). It therefore
      // defaults to nothing, like `wait`, rather than to a hold nobody asked for.
      case 'wait':
      case 'invoke':
        return Math.max(0, step.ms ?? 0);
      default:
        return 0;
    }
  }

  /**
   * Wall-clock milliseconds one logic tick takes on this runner.
   *
   * Not simply `fixedDeltaSec`: under `fixed` mode with `ticksPerFrame > 1` the
   * runner packs several ticks into one animation frame, so N ticks elapse in
   * `N / ticksPerFrame` frames of wall clock. Dividing keeps `frames: 8`
   * meaning eight ticks at ×1 and at ×4 alike — which is the whole reason the
   * plan denominates input in frames. Duck-typed on `getTimeMode` so a host (or
   * a spec fake) without the time contract simply gets 1/60.
   *
   * `manual` mode is the one case wall-clock waiting cannot express — nothing
   * ticks until someone calls `stepFrames` — and stepping there belongs to the
   * `game_time` tool, not to a sleeping input step.
   */
  private frameDurationMs(runner: SceneRunner): number {
    const source = runner as unknown as { getTimeMode?: () => unknown };
    if (typeof source.getTimeMode !== 'function') return FALLBACK_FRAME_MS;
    let mode: unknown;
    try {
      mode = source.getTimeMode();
    } catch {
      return FALLBACK_FRAME_MS;
    }
    const config = mode as { fixedDeltaSec?: unknown; ticksPerFrame?: unknown } | null;
    const deltaSec = typeof config?.fixedDeltaSec === 'number' ? config.fixedDeltaSec : 0;
    if (!(deltaSec > 0) || !Number.isFinite(deltaSec)) return FALLBACK_FRAME_MS;
    const ticksPerFrame =
      typeof config?.ticksPerFrame === 'number' && config.ticksPerFrame >= 1
        ? config.ticksPerFrame
        : 1;
    return (deltaSec * 1000) / ticksPerFrame;
  }

  /** Execute one step; returns an error string (null = success). */
  private async runStep(
    runtime: { runner: SceneRunner; canvas: HTMLCanvasElement; windowRef: Window },
    step: GameInputStep,
    frameMs: number
  ): Promise<string | null> {
    const durationOf = (s: GameInputStep): number => this.stepDurationMs(s, frameMs);
    switch (step.type) {
      case 'wait':
        await sleep(durationOf(step));
        return null;
      case 'key':
        if (!step.code) return "A 'key' step needs a `code` (KeyboardEvent.code, e.g. 'KeyW').";
        return this.holdKeys([step.code], durationOf(step));
      case 'keys':
        if (!step.codes?.length) return "A 'keys' step needs `codes`: ['KeyW', 'KeyA', ...].";
        return this.holdKeys(step.codes, durationOf(step));
      case 'tap': {
        const point = this.resolveClientPoint(runtime, step.target, step.x, step.y);
        if (typeof point === 'string') return point;
        this.dispatchPointer(runtime.canvas, 'pointerdown', point);
        await sleep(durationOf(step));
        // Read the witness while the finger is still down: by now the control has ticked, so its
        // own bounds check has decided whether the point actually landed on it.
        this.notePhysicalReach(runtime, step.target);
        this.dispatchPointer(runtime.canvas, 'pointerup', point);
        return null;
      }
      case 'hover': {
        const point = this.resolveClientPoint(runtime, step.target, step.x, step.y);
        if (typeof point === 'string') return point;
        this.dispatchPointer(runtime.canvas, 'pointermove', point, { buttons: 0 });
        await sleep(durationOf(step));
        this.notePhysicalReach(runtime, step.target);
        return null;
      }
      case 'invoke': {
        if (!step.target) {
          return "An 'invoke' step needs `target` (node name or nodeId — game_controls lists them).";
        }
        if (!step.interaction) {
          return "An 'invoke' step needs `interaction` (the interaction name from game_controls, e.g. 'click').";
        }
        const node = this.findLiveNode(runtime.runner, step.target);
        if (!node) {
          return `No live node named or with id "${step.target}" in the running scene. game_controls lists every interactive node of the live scene by name.`;
        }
        const refusal = this.invokeInteractionOn(
          node as unknown as ScanNode,
          step.interaction,
          step.args
        );
        if (refusal) return refusal;
        await sleep(durationOf(step));
        return null;
      }
      case 'drag': {
        const from = this.resolveClientPoint(runtime, step.target, step.x, step.y);
        if (typeof from === 'string') return from;
        const to = this.resolveClientPoint(runtime, step.to?.target, step.to?.x, step.to?.y);
        if (typeof to === 'string') return `drag \`to\`: ${to}`;
        const durationMs = durationOf(step);
        // One move per tick when the drag is frame-denominated (inertia is read
        // from the last frames' velocity, so timer-sliced moves distort it),
        // else the historical ~30 ms slicing. Capped either way.
        const requested =
          typeof step.frames === 'number' ? step.frames : Math.round(durationMs / 30);
        const moves = Math.max(2, Math.min(20, requested));
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
        return `Unknown step type "${String(step.type)}". Use tap | hover | invoke | key | keys | drag | wait.`;
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
    client: { x: number; y: number },
    options?: { buttons?: number }
  ): void {
    const init = {
      pointerId: SYNTHETIC_POINTER_ID,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: client.x,
      clientY: client.y,
      button: 0,
      buttons: options?.buttons ?? (type === 'pointerup' ? 0 : 1),
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
      // Refuse rather than dispatch into empty space: an off-screen node still projects to a valid
      // canvas point, so tapping it "succeeded" with no reaction and read as dead game logic. This
      // cost two turns on a retry button whose parent overlay was never shown.
      if (!node.visible) {
        return `Node "${target}" has visible: false, so it is not on screen and cannot be tapped. Show it first (or fix whatever should have shown it).`;
      }
      const hiddenBy = hiddenByAncestorName(node);
      if (hiddenBy !== null) {
        return `Node "${target}" is visible itself but its ancestor "${hiddenBy}" is hidden, so nothing of it is on screen and a tap cannot reach it. Make "${hiddenBy}" visible — showing only the children is the bug.`;
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

  /**
   * Of `queries`, the ones that resolve by NAME to more than one live node. An id hit is unique by
   * construction and never ambiguous. Duplicated names are common in agent-built scenes (an
   * abandoned scratch node keeps the name it was given), and resolving one silently sends taps to
   * whichever copy tree order happens to reach first.
   */
  /**
   * Live scene roots plus their display names, captured for a later {@link detectSceneSwap}. Held
   * by object identity, not nodeId: `runGraph` re-clones the authored graph, so a swap BACK to the
   * same scene (or a restart) reuses the authored ids while every live node is a new instance.
   */
  private rootIdentity(runner: SceneRunner): { nodes: readonly NodeBase[]; names: string[] } {
    // Copied, not aliased: getLiveRootNodes() hands back the graph's own array, so a "before"
    // capture that kept the reference could quietly become the "after" list.
    const nodes = [...runner.getLiveRootNodes()];
    return { nodes, names: nodes.map(root => root.name || root.nodeId) };
  }

  /**
   * Did the running scene get replaced between the two captures? Every root being a different
   * instance is exactly what `SceneRunner.runGraph` does on `changeScene` / restart, and nothing
   * else produces it — an ordinary spawn/despawn keeps at least one root alive.
   */
  private detectSceneSwap(
    before: { nodes: readonly NodeBase[]; names: string[] },
    after: { nodes: readonly NodeBase[]; names: string[] }
  ): SceneSwap | undefined {
    if (before.nodes.length === 0 || after.nodes.length === 0) return undefined;
    if (after.nodes.some(root => before.nodes.includes(root))) return undefined;
    return { fromRoots: before.names, toRoots: after.names };
  }

  private ambiguousQueries(runner: SceneRunner, queries: readonly string[]): string[] {
    const ambiguous: string[] = [];
    for (const query of new Set(queries)) {
      if (runner.getLiveNodeById(query)) continue;
      if (runner.findLiveNodesByName(query, 2).length > 1) {
        ambiguous.push(query);
      }
    }
    return ambiguous;
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
    const children = node.children ?? [];
    const opacity = (node as { opacity?: unknown }).opacity;
    // UIControl2D (Label2D, Button2D, …) resolves its rendered text through getDisplayText() —
    // duck-typed so the runtime's UI classes stay out of this service's imports.
    const displayText = readDisplayText(node);
    const hiddenBy = node.visible ? hiddenByAncestorName(node) : null;
    const control = readControlState(node);
    return {
      nodeId: node.nodeId,
      name: node.name,
      type: node.type,
      visible: node.visible,
      ...(hiddenBy !== null ? { hiddenByAncestor: hiddenBy } : {}),
      position: { x: node.position.x, y: node.position.y, z: node.position.z },
      worldPosition: { x: world.x, y: world.y, z: world.z },
      rotationZ: node.rotation.z,
      scale: { x: round3(node.scale.x), y: round3(node.scale.y), z: round3(node.scale.z) },
      ...(typeof opacity === 'number' ? { opacity: round3(opacity) } : {}),
      ...(displayText !== null ? { text: displayText } : {}),
      childCount: children.length,
      visibleChildCount: children.reduce((n, child) => n + (child.visible !== false ? 1 : 0), 0),
      ...(control !== null ? { control } : {}),
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
      childrenChanged:
        before.childCount !== after.childCount ||
        before.visibleChildCount !== after.visibleChildCount,
    };
    const sdx = after.scale.x - before.scale.x;
    const sdy = after.scale.y - before.scale.y;
    const sdz = after.scale.z - before.scale.z;
    // Ratio on the axis that moved the most, guarded against a ~0 base (PopIn).
    const axes: Array<[number, number]> = [
      [sdx, before.scale.x],
      [sdy, before.scale.y],
      [sdz, before.scale.z],
    ];
    const [dMax, bMax] = axes.reduce((acc, cur) =>
      Math.abs(cur[0]) > Math.abs(acc[0]) ? cur : acc
    );
    base.scaleDelta = {
      x: round3(sdx),
      y: round3(sdy),
      z: round3(sdz),
      ...(Math.abs(bMax) > 1e-3 ? { ratio: round3((bMax + dMax) / bMax) } : {}),
    };
    base.scaled = Math.max(Math.abs(sdx), Math.abs(sdy), Math.abs(sdz)) > SCALE_EPS;
    if (typeof before.opacity === 'number' && typeof after.opacity === 'number') {
      const od = round3(after.opacity - before.opacity);
      if (Math.abs(od) > OPACITY_EPS) base.opacityDelta = od;
    }
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
      case 'activity': {
        // For spawners/shooters/pools/HUD: reacting means ANY channel fired, not motion.
        const act = d.activity;
        const reacted =
          act?.active === true ||
          moved ||
          d.childrenChanged === true ||
          d.scaled === true ||
          d.opacityDelta !== undefined;
        return { ok: reacted, note: reacted ? this.describeActivity(d) : 'no activity detected' };
      }
      default:
        return { ok: false, note: `unknown expectation "${String(expectation)}"` };
    }
  }

  /** Compact per-node activity phrase for verdicts and `directionNote`. */
  private describeActivity(d: ObservedNodeDelta): string {
    const bits: string[] = [];
    if (d.moved) bits.push(`moved ${Math.round(d.delta?.distance ?? 0)}u`);
    const act = d.activity;
    if (act) {
      if (act.spawned || act.removed) bits.push(`${act.spawned} spawned / ${act.removed} removed`);
      const startVisible = d.before?.visibleChildCount ?? 0;
      if (act.visibleChildPeak > startVisible) {
        bits.push(`${act.visibleChildPeak} children shown (peak)`);
      }
      if (act.maxChildDistance > MOVED_THRESHOLD) {
        bits.push(`child moved ${Math.round(act.maxChildDistance)}u`);
      }
      if (act.maxScaleDelta > SCALE_EPS) {
        bits.push(`scaled ±${round3(act.maxScaleDelta)} (peak)`);
      }
      if (act.opacityRange) {
        bits.push(`opacity ${act.opacityRange.min}..${act.opacityRange.max}`);
      }
      if (act.stateChanges) {
        const keys = Object.keys(act.stateChanges).slice(0, 3);
        bits.push(`state ${keys.join(', ')}`);
      }
    } else {
      if (d.scaled) bits.push(`scale ×${d.scaleDelta?.ratio ?? '?'}`);
      if (d.childrenChanged) bits.push('children changed');
    }
    return bits.length ? bits.join(', ') : 'reacted';
  }

  // -- game debug provider + verdict -------------------------------------------------

  /**
   * Build a watch recorder over the observed queries (null-safe resolver bound
   * to `runner`), sampling on the runner's frame hook so a short-lived node is
   * seen in the tick it exists rather than in whichever 100 ms sample it happens
   * to survive into. Hosts that expose no hook degrade to the timer inside the
   * recorder — the cast is duck-typing, not a claim about `SceneRunner`.
   */
  private makeRecorder(runner: SceneRunner, queries: string[]): NodeWatchRecorder {
    return new NodeWatchRecorder(
      query => this.findLiveNode(runner, query) as WatchNodeLike | null,
      queries,
      { frameSource: this.resolveFrameSource(runner) }
    );
  }

  /**
   * The runner's per-tick hook, or null when this host exposes none. Duck-typed on
   * purpose — a spec fake or an older runtime simply has no frame denomination, and
   * every caller must degrade rather than assume the contract.
   */
  private resolveFrameSource(runner: SceneRunner): WatchFrameSource | null {
    const source = runner as unknown as WatchFrameSource;
    return typeof source?.subscribeFrameStats === 'function' ? source : null;
  }

  /**
   * Hold an observe window open for exactly `frames` logic ticks, and report how it
   * really ended. Three exits, all of them bounded:
   *
   *  - **frames** — the Nth tick arrived. The promise settles from inside that tick's
   *    dispatch, so the count cannot drift past the budget before the caller stops
   *    the recorder.
   *  - **cap** — {@link MAX_SAMPLE_MS} (with {@link FRAME_BUDGET_SLACK} headroom over
   *    the budget's nominal length) elapsed first. This is the guard that keeps a
   *    tick budget from becoming an unbounded window on a runner that crawls.
   *  - **no-ticks** — nothing ticked within {@link FRAME_BUDGET_STALL_MS}, or the host
   *    has no frame hook at all. The window then falls back to the wall clock for the
   *    budget's nominal length, and says so — a frame budget must never hang a call
   *    just because the thing it counts never happens.
   */
  private async awaitFrameBudget(
    source: WatchFrameSource | null,
    frames: number,
    frameMs: number
  ): Promise<ObserveFrameBudget & { elapsedMs: number }> {
    const startedAt = Date.now();
    const nominalMs = Math.min(MAX_SAMPLE_MS, Math.max(0, frames * frameMs));
    const deadlineMs = Math.min(
      MAX_SAMPLE_MS,
      Math.max(MIN_FRAME_BUDGET_DEADLINE_MS, nominalMs * FRAME_BUDGET_SLACK)
    );
    const fallbackToClock = async (
      observed: number,
      why: string
    ): Promise<ObserveFrameBudget & { elapsedMs: number }> => {
      await sleep(Math.max(0, nominalMs - (Date.now() - startedAt)));
      return {
        requested: frames,
        observed,
        endedBy: 'no-ticks',
        note: `Frame budget degraded: ${why}, so this window was measured on the wall clock (~${Math.round(nominalMs)}ms) instead of ${frames} ticks. Treat its length as approximate and prefer sampleMs here.`,
        elapsedMs: Date.now() - startedAt,
      };
    };

    if (!source) {
      return fallbackToClock(0, 'this runner exposes no per-tick hook');
    }

    let observed = 0;
    let unsubscribe: (() => void) | null = null;
    const endedBy = await new Promise<'frames' | 'cap' | 'no-ticks'>(resolve => {
      let settled = false;
      const finish = (why: 'frames' | 'cap' | 'no-ticks'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(capTimer);
        clearTimeout(stallTimer);
        resolve(why);
      };
      const capTimer = setTimeout(() => finish('cap'), deadlineMs);
      const stallTimer = setTimeout(
        () => {
          if (observed === 0) finish('no-ticks');
        },
        Math.min(FRAME_BUDGET_STALL_MS, deadlineMs)
      );
      try {
        unsubscribe = source.subscribeFrameStats(() => {
          observed += 1;
          if (observed >= frames) finish('frames');
        });
      } catch {
        finish('no-ticks');
      }
    });
    if (unsubscribe) {
      try {
        (unsubscribe as () => void)();
      } catch {
        // A host that fails to unsubscribe must not sink the observation.
      }
    }

    if (endedBy === 'no-ticks') {
      return fallbackToClock(observed, 'the game did not tick during the window');
    }
    return {
      requested: frames,
      observed,
      endedBy,
      ...(endedBy === 'cap'
        ? {
            note: `Frame budget cut short: only ${observed} of ${frames} ticks arrived before the ${Math.round(deadlineMs)}ms duration cap closed the window. The game ticked slower than its nominal rate (or stopped); read the sample as ${observed} ticks, not ${frames}.`,
          }
        : {}),
      elapsedMs: Date.now() - startedAt,
    };
  }

  /**
   * The live `InputService` the running game polls. `SceneRunner` keeps it
   * private and hands it to every node, so the live graph is the supported way
   * to reach it — and the one that cannot go stale, since a node's reference is
   * the same object the game's scripts read.
   */
  private resolveInputService(runner: SceneRunner): PollRecordingInput | null {
    for (const root of runner.getLiveRootNodes()) {
      const input = (root as { input?: unknown }).input as PollRecordingInput | undefined;
      if (input && typeof input.startPollRecording === 'function') return input;
    }
    return null;
  }

  /** Close the poll window and shape it for the result (null when nothing recorded). */
  private collectObservedPolls(input: PollRecordingInput | null): GameInputObservation | undefined {
    if (!input) return undefined;
    let snapshot: ObservedPollsSnapshot;
    try {
      snapshot = input.takeObservedPolls();
    } catch {
      return undefined;
    }
    if (!snapshot.observedPolls.length && !snapshot.lockedDuringWindow) {
      // Nothing polled and no lock: still worth reporting — "the game asked for
      // nothing" is the diagnosis, not an absence of data.
      return { observedPolls: [], note: OBSERVED_POLLS_NOTE };
    }
    return {
      observedPolls: snapshot.observedPolls,
      ...(snapshot.lockedDuringWindow ? { inputLocked: true } : {}),
      ...(snapshot.truncated ? { truncated: true } : {}),
      note: OBSERVED_POLLS_NOTE,
    };
  }

  /**
   * The one line that closes the "pressed a key the game never reads" class:
   * which dispatched key codes the game did NOT poll, and what it polled
   * instead. Empty when nothing was keyed or every code was polled.
   */
  private describePollMismatch(
    input: GameInputObservation | undefined,
    steps: readonly GameInputStep[] | undefined
  ): string {
    if (!input) return '';
    if (input.inputLocked) {
      return ' INPUT LOCKED during the window (Cutscene Director / lock()), so no event reached gameplay at all — that alone explains silence.';
    }
    const dispatched = (steps ?? []).flatMap(step =>
      step.type === 'key' || step.type === 'keys' ? (step.codes ?? [step.code ?? '']) : []
    );
    const unpolled = [...new Set(dispatched.filter(isNonEmptyString))].filter(
      code => !input.observedPolls.includes(`Key_${code}`)
    );
    if (!dispatched.length) return '';
    const polled = input.observedPolls.length
      ? input.observedPolls.slice(0, 8).join(', ')
      : 'nothing';
    if (!unpolled.length) return ` Game polled ${polled} (observation, not proof of handling).`;
    return ` INPUT NOT POLLED: the game never asked about ${unpolled.map(c => `Key_${c}`).join(', ')} — over this window it polled ${polled}. Press what the game reads (or fix the binding); this is an observation of getAxis/getButton calls, not proof of handling.`;
  }

  /** One snapshot from the running game's GameDebugProvider, if one is registered. */
  private snapshotGame(): { name: string; snapshot?: Json; error?: string } | null {
    const provider = getGameDebug();
    if (!provider?.snapshot) return null;
    try {
      return { name: provider.name, snapshot: safeSerialize(provider.snapshot(), 5) };
    } catch (err) {
      return { name: provider.name, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Combine the before/after game snapshots into a `GameStateDelta` (+ scalar diff). */
  private describeGameDelta(
    before: { name: string; snapshot?: Json; error?: string } | null,
    after: { name: string; snapshot?: Json; error?: string } | null
  ): GameStateDelta | undefined {
    if (!after) return undefined;
    const delta: GameStateDelta = { provider: after.name, snapshot: after.snapshot ?? null };
    if (after.error) {
      delta.error = after.error;
      return delta;
    }
    if (before && !before.error && before.snapshot !== undefined && after.snapshot !== undefined) {
      const changed = diffJsonPaths(before.snapshot, after.snapshot);
      if (Object.keys(changed).length) delta.changed = changed;
    }
    return delta;
  }

  /**
   * Fuse every channel into one line the model reads FIRST. The whole point is
   * that `moved:false` must not read as "the game is dead" — a spawner, pool, or
   * HUD reacts without its own transform ever moving.
   */
  private buildVerdict(
    observed: Record<string, ObservedNodeDelta>,
    game: GameStateDelta | undefined,
    newErrorCount: number,
    droppedWatchCount: number,
    sceneChanged?: SceneSwap,
    inputContext?: { input?: GameInputObservation; steps?: readonly GameInputStep[] }
  ): string {
    const parts: string[] = [];
    const staticContainers: string[] = [];
    let anyActivity = false;

    for (const [query, delta] of Object.entries(observed)) {
      const reacted =
        delta.moved === true ||
        delta.childrenChanged === true ||
        delta.scaled === true ||
        delta.opacityDelta !== undefined ||
        delta.activity?.active === true;
      if (reacted) {
        anyActivity = true;
        parts.push(`${query}: ${this.describeActivity(delta)}`);
      } else if ((delta.before?.childCount ?? 0) > 0) {
        staticContainers.push(query);
      }
    }

    if (game?.changed && Object.keys(game.changed).length) {
      anyActivity = true;
      const summary = Object.entries(game.changed)
        .slice(0, 4)
        .map(([key, [a, b]]) => `${key} ${fmtScalar(a)}->${fmtScalar(b)}`)
        .join('; ');
      parts.push(`game ${summary}`);
    }
    if (game?.error) parts.push(`game snapshot threw: ${game.error}`);
    if (newErrorCount > 0) parts.push(`${newErrorCount} new runtime error(s)`);

    const dropped =
      droppedWatchCount > 0
        ? ` (${droppedWatchCount} extra watched node(s) not tracked — cap is 8)`
        : '';

    // An off-screen watched node explains a dead-looking result better than any guess in the tail,
    // so it leads the verdict: "no activity" invited debugging the input path when the real answer
    // was that the node is not drawn at all.
    const offScreen = Object.entries(observed)
      .filter(([, delta]) => delta.after?.hiddenByAncestor !== undefined)
      .map(([query, delta]) => `${query} (behind hidden "${delta.after?.hiddenByAncestor}")`);
    const offScreenTail = offScreen.length
      ? ` NOT ON SCREEN despite visible: true — ${offScreen.join(', ')}: an invisible ancestor hides the whole subtree, so these render nothing and cannot be tapped.`
      : '';

    // A scene swap leads unconditionally: it invalidates every other line of the verdict (the
    // watched nodes were destroyed with their scene, so their deltas describe corpses) and it is
    // the one outcome the old wording actively mis-reported as NO ACTIVITY.
    if (sceneChanged) {
      const errs = newErrorCount > 0 ? ` ${newErrorCount} new runtime error(s).` : '';
      return `SCENE CHANGED: the running scene was replaced (roots ${sceneChanged.fromRoots.join(', ') || '—'} → ${sceneChanged.toRoots.join(', ') || '—'}). That IS the reaction — the nodes you were watching belong to the old scene and no longer exist, so their deltas below mean nothing. Re-observe against the new scene's nodes (game_observe with no names lists its roots); scene_tree still shows the EDITOR's scene, not this one.${errs}${dropped}`;
    }
    if (anyActivity) {
      const tail = staticContainers.length
        ? ` Own positions of ${staticContainers.join(', ')} did not move — normal for spawners/pools/HUD.`
        : '';
      return `GAMEPLAY REACTED: ${parts.join('; ')}.${tail}${offScreenTail}${dropped}`;
    }
    const errs = newErrorCount > 0 ? `${newErrorCount} new error(s)` : 'no new errors';
    // The poll mismatch goes on the dead-looking verdict specifically: it is the
    // answer to the question this line always provoked ("did the input reach
    // gameplay?"), and guessing at it cost whole turns before.
    const polls = this.describePollMismatch(inputContext?.input, inputContext?.steps);
    return `NO ACTIVITY: no watched node moved/scaled/faded, no children spawned/shown, no component or game state changed, ${errs}.${offScreenTail}${polls} If the game should have reacted, the input may not have reached gameplay (menu overlay? wrong target/coords? paused?) — check read_logs / read_errors and scene_tree.${dropped}`;
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
