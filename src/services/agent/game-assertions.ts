/**
 * Predicates for `game_run` (§5.2 of `.plans/done/agent-gameplay-testing.md`).
 *
 * Everything here is a **pure function of two data records** — the frame being
 * judged and the frame-0 baseline. No runtime, no DI, no clock, no scene graph.
 * That is the whole reason predicates live in their own file: the frame loop in
 * `GameTestService` is hard to unit-test (it drives a real runner), while the
 * thing that decides pass/fail must be exhaustively testable, and mixing the two
 * would make every predicate case pay for a runner mock.
 *
 * All ten predicates of §5.2 are here. Each is a `case` in
 * {@link evaluateAssertion} plus whatever data the loop must collect into
 * {@link AssertionFrame} — and the second half is the load-bearing one: a
 * predicate can only be as honest as the record it is judged against, so every
 * field of the frame says explicitly what "absent" means for it (never collected
 * / collected and empty / collected and unreadable), because those are three
 * different bugs and only one of them belongs to the game.
 *
 * Two of them — {@link CommandAssertion} and {@link SignalAssertion} — judge
 * *events* rather than state, so they read data the loop collects **only for the
 * run's window** ({@link AssertionFrame.commands} / {@link AssertionFrame.signals}).
 * Purity is unaffected: the windowing happens in the loop, and by the time a
 * predicate sees the record, "since the baseline" is already true of everything in
 * it. One consequence is worth knowing: both are empty at frame 0 by construction,
 * so neither can ever trip the baseline rule (`precondition-already-met`) the way a
 * state predicate can.
 */

import type { Json } from '@/core/agent-introspection';
import type { GameCommandLogEntry } from '@pix3/runtime';
import type { LiveNodeSnapshot } from '@/services/agent/GameInputService';

// ---------------------------------------------------------------------------
// Shared state core (see §5.2: "стейт-ядро общее с agent-eval")
// ---------------------------------------------------------------------------

/**
 * Comparison operators shared by every value-testing predicate. Deliberately
 * small: these are the ones a gameplay assertion actually needs, and each extra
 * operator is another thing a model can get subtly wrong.
 */
export type ComparisonOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';

export const COMPARISON_OPS: readonly ComparisonOp[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
];

export function isComparisonOp(value: unknown): value is ComparisonOp {
  return typeof value === 'string' && (COMPARISON_OPS as readonly string[]).includes(value);
}

/**
 * Resolve a dot path (`'gun.ammo.mag'`) inside a Json snapshot. Returns
 * `undefined` for a missing path — distinct from a present `null`, which is a
 * legitimate value a game may report and which must not read as "no such field".
 *
 * Numeric segments index into arrays (`'waves.0.enemies'`), because a game that
 * exposes a list is otherwise unassertable without a wrapper object.
 */
export function resolveJsonPath(root: Json | null, path: string): Json | undefined {
  if (path.length === 0) return root ?? undefined;
  let current: Json | undefined = root ?? undefined;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    current = (current as { [key: string]: Json })[segment];
  }
  return current;
}

/**
 * Compare two Json values under an operator.
 *
 * The ordering operators require both sides to be numbers and return `false`
 * otherwise — `'3' > 2` being true in JS is exactly the kind of coincidence that
 * makes a green test meaningless. `eq`/`ne` compare structurally (so an object or
 * array value works), `contains` covers strings and arrays.
 */
export function compareJson(actual: Json | undefined, op: ComparisonOp, expected: Json): boolean {
  switch (op) {
    case 'eq':
      return JSON.stringify(actual ?? null) === JSON.stringify(expected);
    case 'ne':
      return JSON.stringify(actual ?? null) !== JSON.stringify(expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof actual !== 'number' || typeof expected !== 'number') return false;
      if (op === 'gt') return actual > expected;
      if (op === 'gte') return actual >= expected;
      if (op === 'lt') return actual < expected;
      return actual <= expected;
    }
    case 'contains': {
      if (typeof actual === 'string') {
        return actual.includes(typeof expected === 'string' ? expected : String(expected));
      }
      if (Array.isArray(actual)) {
        const needle = JSON.stringify(expected);
        return actual.some(item => JSON.stringify(item) === needle);
      }
      return false;
    }
    default:
      return false;
  }
}

/** Short display form of a Json scalar for one-line details. */
export function formatJson(value: Json | undefined): string {
  if (value === undefined) return '(absent)';
  if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  const text = JSON.stringify(value) ?? 'null';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

// ---------------------------------------------------------------------------
// The predicates
// ---------------------------------------------------------------------------

/** A scalar from the running game's `GameDebugProvider.snapshot()` satisfies `op value`. */
export interface GameStateAssertion {
  kind: 'gameState';
  path: string;
  op: ComparisonOp;
  value: Json;
}

/**
 * A scalar moved away from its frame-0 value. With `by`, the *signed* delta must
 * have reached it: `by: 1` means "grew by at least 1", `by: -2` means "dropped by
 * at least 2". Without `by`, any structural change counts.
 */
export interface GameStateChangedAssertion {
  kind: 'gameStateChanged';
  path: string;
  by?: number;
}

/** A live node with this name (or nodeId) is no longer in the running scene. */
export interface NodeGoneAssertion {
  kind: 'nodeGone';
  name: string;
}

/** At least `min` (default 1) new runtime errors were captured since the run started. */
export interface NewErrorsAssertion {
  kind: 'newErrors';
  min?: number;
}

/**
 * The run reached frame `n`. Useful as an explicit *budget* on the `until` side
 * ("run 300 frames and then look"), and as a deliberate failure on the `fail`
 * side. `n` must be >= 1: `frames(0)` is true at the baseline by construction and
 * would only ever produce `precondition-already-met`.
 */
export interface FramesAssertion {
  kind: 'frames';
  n: number;
}

/**
 * A live node was displaced from where it stood at frame 0.
 *
 * Measured against the **baseline snapshot**, not against the previous frame: a
 * game that jitters a node back and forth would otherwise satisfy "it moved"
 * forever, and what a test means by "the player moved left" is displacement from
 * where the run started.
 *
 * Two shapes, and the difference matters:
 *
 * - **Without `axis`** the measurement is the unsigned distance travelled, so
 *   `min` is a plain "moved at least this far" (default
 *   {@link DEFAULT_MOVE_MIN} — the same half-unit floor `GameInputService` uses
 *   for `moved`, so the two layers do not disagree about what counts as motion).
 * - **With `axis`** the measurement is the *signed* delta on that world axis, so
 *   `min`/`max` are bounds on direction as well as size: `{axis: 'x', max: 0}`
 *   is "moved left", `{axis: 'y', min: 2}` is "rose by at least 2".
 *
 * A direction bound alone can never be satisfied by standing still: a floor on
 * |delta| is always applied (the explicit bound when it demands more, the default
 * otherwise). Without that, `{axis: 'x', max: 0}` would be true of a node that
 * never moved at all — precisely the hollow green this harness exists to prevent.
 *
 * Deliberately *not* here: facing-relative verdicts (`forward` / `sideways`).
 * That vocabulary already exists as `GameInputService`'s `expect` apparatus over
 * a whole input window; duplicating its trigonometry per frame would create a
 * second definition of "forward" that could drift from the first. See the note on
 * {@link AssertionFrame.nodes}.
 */
export interface NodeMovedAssertion {
  kind: 'nodeMoved';
  /** Live node name or nodeId. */
  name: string;
  /** World axis to measure the signed delta on. Omit to measure distance. */
  axis?: 'x' | 'y' | 'z';
  /** Lower bound: distance (no axis) or signed delta (with axis). */
  min?: number;
  /** Upper bound on the same measurement — the half that expresses "leftwards". */
  max?: number;
}

/**
 * Something that was not in the scene at frame 0 is in it now — a spawn.
 *
 * One argument, two readings, because a test says "an Enemy appeared" without
 * caring which of the two it is:
 *
 * - **as a name/nodeId**: absent at the baseline, present now;
 * - **as a node type**: the live count of nodes of that type is higher than at
 *   the baseline (`Enemy2D`, `Sprite2D`, a script-component type — whatever the
 *   loop's counter understands).
 *
 * Either reading satisfies it, and the detail says which one fired, so a
 * misspelled name that happens to match no type reads as "nothing by that name or
 * type ever appeared" rather than as a bare false.
 *
 * The count reading is what makes a *pool* provable: a recycled enemy keeps its
 * node identity, so "a new name appeared" is false while "there are three more
 * visible enemies" is true. The name reading is what makes a *unique* spawn
 * provable (the boss, the win banner).
 */
export interface NodeAppearedAssertion {
  kind: 'nodeAppeared';
  /** Live node name/nodeId, or a node type. Both readings are tried. */
  query: string;
}

/**
 * A property of a live node satisfies `op value` — the `node-property` check of
 * `agent-eval.ts`, lifted into the frame loop.
 *
 * The path is a dot path into the node's readable properties (`position.x`,
 * `text`, `enabled`, `modulate.a`), resolved by the loop against the live node,
 * and the comparison is the shared state core ({@link compareJson}) — so the same
 * `gt`-refuses-strings strictness applies here as everywhere else.
 *
 * Why it earns a place next to `gameState`: a game without a `GameDebugProvider`
 * has no snapshot at all, and a HUD label or a button's `enabled` flag is then
 * the only readable evidence that anything happened. It is also the honest way to
 * assert on *engine* state (`visible`, `opacity`) that a game would never think
 * to export.
 */
export interface NodePropertyAssertion {
  kind: 'nodeProperty';
  /** Live node name or nodeId. */
  name: string;
  /** Dot path into the node's properties, e.g. `position.x`, `text`, `enabled`. */
  path: string;
  op: ComparisonOp;
  value: Json;
}

/**
 * An **input axis** holds a value — the joystick's own output, read before any
 * game logic touches it (§5.4.5).
 *
 * This is the predicate that splits the single most confusing gameplay failure
 * into its two halves. "The stick does not move the hero" is really two claims:
 *
 * 1. `axis('Horizontal', 'lt', -0.4)` — the gesture reached the axis at all;
 * 2. `nodeMoved('Player', {axis: 'x', max: 0})` — the game reads the axis.
 *
 * Assert both and the failure names the broken half instead of shrugging. Assert
 * only the second and a dead control and an unread axis look identical.
 *
 * Only ordering and equality operators are accepted, `value` must be a finite
 * number, and a non-numeric reading never compares true — an axis is a number by
 * definition, so anything else is a harness fault worth saying out loud. Prefer
 * thresholds to `eq`: an analogue stick lands on 0.6187…, not on 0.6.
 *
 * One requirement on the loop that is easy to get wrong and impossible to see
 * afterwards: the reading **must not register as a game poll**. The runtime
 * records `getAxis` callers while a harness window is open, and that recording is
 * what `input.observedPolls` reports — if the harness's own per-frame read went
 * through the same path, every run would "prove" the game polls every axis the
 * test mentions. See {@link AssertionFrame.axes}.
 */
export interface AxisAssertion {
  kind: 'axis';
  /** Axis name as the game knows it, e.g. `Horizontal`, `Move_X`. */
  name: string;
  op: ComparisonOp;
  value: number;
}

/**
 * ## Why binding is proven by two different predicates
 *
 * {@link CommandAssertion} and {@link SignalAssertion} answer the same question —
 * *did the tap actually reach the intent?* (§5.8.4) — for two shapes of control
 * that cannot share one answer.
 *
 * **Buttons are proven with `command`.** A button's handler dispatches
 * (`scene.commands.dispatch('open-menu')`), so a single tap plus
 * `{kind: 'command', name: 'open-menu'}` proves that wire once. Every later
 * scenario then opens the menu *by dispatching* and never taps a pixel again —
 * which is the whole payoff of the command layer: a trace that survives renaming
 * the button.
 *
 * **Stateful controls — checkbox, inventory slot — are proven with `signal`.** For
 * them the arrow runs the other way. In the templates the command
 * `settings.toggle-music` *flips the checkbox*, and applying the effect hangs off
 * the checkbox's `toggled` signal. If `toggled` dispatched the command back, the
 * command would dispatch itself (the registry's recursion cap exists because that
 * mistake is easy to make), so asserting a command here would either prove nothing
 * or prove a cycle. The observable end of the wire is the signal instead:
 * `{kind: 'signal', name: 'toggled', node: 'MusicCheckbox'}` says the control
 * really changed state, and `Checkbox2D`/`InventorySlot2D` fix the order (`click`
 * before the change, `toggled` after), so it cannot be satisfied by a tap that
 * bounced off a disabled control.
 *
 * This is a division of roles, not a workaround for a missing feature: `command`
 * observes an intent being **raised**, `signal` observes a control **having
 * changed**. A test that wants both facts asserts both.
 */

/**
 * A named intent was dispatched through `scene.commands` **during this run**.
 *
 * Scope is the run window: the journal is a shared ring buffer that outlives any
 * one `game_run`, so entries present at the baseline never count (see
 * {@link CommandWindow}). Practical consequence for the §5.8.4 recipe: the tap has
 * to land *inside* the window, so a `game_input` call made before `game_run` shows
 * up as a pre-window dispatch — the predicate says exactly that rather than a bare
 * "never dispatched".
 *
 * With `args`, the match is a **subset**: every key given must be present and
 * equal, extra keys in the dispatched payload are ignored. An agent wants to
 * assert "bought the item in slot 2", not to reproduce a payload byte for byte.
 *
 * Only a dispatch that *ran* (`status: 'ok'`) counts. A dispatch of an unregistered
 * name, a refused one, or one whose handler threw is reported in the detail with
 * its reason — "the button dispatches an intent nobody registered" is a far more
 * useful sentence than `false`.
 */
export interface CommandAssertion {
  kind: 'command';
  /** The command name as registered, e.g. `settings.toggle-music`. */
  name: string;
  /** Fields the dispatched arguments must contain (subset match). */
  args?: Record<string, Json>;
}

/**
 * A node emitted this signal **during this run**.
 *
 * `node` scopes the listener to one node by name or nodeId; without it the run
 * listens on every live node, including ones spawned mid-run (so
 * `{kind: 'signal', name: 'died'}` catches an enemy that did not exist at the
 * baseline). The scoped form is the cheap one and the one to prefer: an unscoped
 * watch re-walks the live scene every frame looking for new nodes to attach to.
 *
 * Windowing is structural rather than filtered: the loop subscribes when the run
 * starts and disconnects in its `finally`, so an emission outside the run is not
 * "excluded", it is never seen. Absence is reported with its reason — a scope that
 * never resolved to a live node ("the name is wrong") reads differently from one
 * that was listening on three nodes and heard nothing ("the control did not fire").
 */
export interface SignalAssertion {
  kind: 'signal';
  /** The signal name, e.g. `toggled`, `pressed`, `died`. */
  name: string;
  /** Live node name or nodeId to listen on. Omit to listen scene-wide. */
  node?: string;
}

export type GameAssertion =
  | GameStateAssertion
  | GameStateChangedAssertion
  | NodeGoneAssertion
  | NodeMovedAssertion
  | NodeAppearedAssertion
  | NodePropertyAssertion
  | AxisAssertion
  | NewErrorsAssertion
  | FramesAssertion
  | CommandAssertion
  | SignalAssertion;

export const GAME_ASSERTION_KINDS: ReadonlyArray<GameAssertion['kind']> = [
  'gameState',
  'gameStateChanged',
  'nodeGone',
  'nodeMoved',
  'nodeAppeared',
  'nodeProperty',
  'axis',
  'newErrors',
  'frames',
  'command',
  'signal',
];

/**
 * The half-unit floor that counts as motion, shared with `GameInputService`'s
 * `moved` flag on purpose: two layers of the same harness disagreeing about
 * whether a node moved is a bug report nobody can act on.
 */
export const DEFAULT_MOVE_MIN = 0.5;

// ---------------------------------------------------------------------------
// What a predicate is allowed to see
// ---------------------------------------------------------------------------

/**
 * The slice of `scene.commands.log` that belongs to this run.
 *
 * The journal is a **ring buffer shared with the whole scene** (50 entries, oldest
 * dropped, drops counted), so "since the baseline" cannot be a filter over the
 * array — the array itself shifts. The loop cuts the window by *position* instead:
 * `entries.length + droppedLogEntries` is a monotonically growing count of
 * everything ever pushed, so the number appended since the baseline is the
 * difference of two readings of it, and the window is that many entries off the
 * end. Frame stamps would be the wrong key twice over — many entries share a
 * frame, and the stamp is the engine's frame counter, not the run's.
 *
 * {@link dropped} is what keeps an overflow from reading as "the command was never
 * dispatched": it counts in-window entries the ring threw away before the loop
 * could read them, and a predicate that fails while it is non-zero says so.
 */
export interface CommandWindow {
  /** Journal entries appended since the baseline, oldest first. */
  entries: readonly GameCommandLogEntry[];
  /** In-window entries lost to the ring buffer's cap before the loop read them. */
  dropped: number;
  /** False when the running scene exposes no command registry at all. */
  available: boolean;
  /** True when the journal was cleared mid-run (the scene stopped or changed). */
  reset?: boolean;
  /**
   * The tail of the journal as it stood at the baseline (capped). Never counts
   * towards a match — it exists so "you dispatched it, just before the run
   * started" can be said out loud instead of looking like silence.
   */
  beforeWindow?: readonly GameCommandLogEntry[];
}

/** What the loop watched for one {@link SignalAssertion}, and what it heard. */
export interface SignalObservation {
  /** Emissions seen inside the run window. */
  count: number;
  /** Run-relative frame of the first / last emission (0 when `count` is 0). */
  firstFrame: number;
  lastFrame: number;
  /** Names of the emitting nodes, capped; `emitterOverflow` marks the cut. */
  emitters: readonly string[];
  emitterOverflow?: boolean;
  /** Live nodes currently subscribed under this watch. */
  attached: number;
  /** True when the watch resolved to at least one node at any point in the run. */
  everAttached: boolean;
  /** True when the sweep hit its node-visit cap, so some nodes were never attached. */
  attachOverflow?: boolean;
}

/**
 * Everything a predicate may read about one frame — plain data, no closures, so
 * a spec builds one by hand and the loop can keep frame 0 around as the baseline
 * without worrying about a resolver that has since gone stale.
 */
export interface AssertionFrame {
  /** Ticks executed since the run started; the baseline is frame 0. */
  frame: number;
  /** Driver time: `frame × fixedDeltaSec × 1000` (see GameTestService). */
  gameTimeMs: number;
  /** `GameDebugProvider.snapshot()` for this frame, or null when no provider is registered. */
  gameState: Json | null;
  /**
   * Of the node names/ids the assertions mention, the ones that resolve to a live
   * node this frame. Only the mentioned names are resolved — a frame loop must not
   * pay for a full scene walk 600 times.
   */
  presentNodes: ReadonlySet<string>;
  /** Runtime errors captured since the run started. 0 at the baseline by construction. */
  newErrorCount: number;
  /**
   * Command journal for the run window. Collected only when a `command`
   * predicate asks for it — reading and slicing it every frame is not free, and a
   * run that never mentions commands must not pay for it. `undefined` therefore
   * means "not collected", which the predicate reports as a harness problem rather
   * than as a negative result.
   */
  commands?: CommandWindow;
  /**
   * What each `signal` watch heard, keyed by {@link signalWatchKey}. Present only
   * while a subscription is live, for the same reason as {@link commands}.
   */
  signals?: ReadonlyMap<string, SignalObservation>;
  /**
   * Transform snapshots for the node queries {@link assertionSnapshotNames}
   * asks for, keyed by the **query string the assertion used** (not by nodeId):
   * the predicate knows the name a model typed, and a node that dies and is
   * replaced by a same-named one is the same subject as far as the test is
   * concerned.
   *
   * The value type is `GameInputService`'s exported {@link LiveNodeSnapshot} on
   * purpose rather than a private struct: it is the shape the input layer already
   * captures for `observe`/`expect`, so the loop can hand this map straight from
   * that capture and no second definition of "where a node is" enters the
   * codebase. (The facing-relative *verdicts* built on it — `alignForward`,
   * `expect: 'sideways'` — remain private to `GameInputService`; making them
   * shareable means lifting `describeDelta`/`evaluateExpectation` into a module
   * both can import, which is a change to that file.)
   *
   * A missing entry means "no live node answered that query this frame", which is
   * a real and reportable state (it died, or the name is wrong); an absent map
   * means the loop never collected any, which is a harness fault.
   */
  nodes?: ReadonlyMap<string, LiveNodeSnapshot>;
  /**
   * How many live nodes match each type query of {@link assertionTypeQueries},
   * keyed by the query string. Feeds the by-type reading of `nodeAppeared`, which
   * is the only one that can see a *pooled* spawn (a recycled node keeps its
   * identity, so no new name ever appears).
   *
   * Absent map = the loop did not count, and `nodeAppeared` then falls back to
   * the by-name reading and says so, rather than reporting a spawn that nobody
   * looked for.
   */
  typeCounts?: ReadonlyMap<string, number>;
  /**
   * Property readings for the (node, path) pairs of {@link assertionPropertyReads},
   * keyed by {@link nodePropertyKey}.
   *
   * `has(key) === false` means the loop never read that pair; `has(key) === true`
   * with an `undefined` value means it looked and the node has no such property.
   * The predicate reports those as different sentences because one is a harness
   * bug and the other is a typo in the test.
   */
  nodeProperties?: ReadonlyMap<string, Json | undefined>;
  /**
   * Input-axis values for the names of {@link assertionAxisNames}, sampled this
   * frame **without registering as a game poll** (see {@link AxisAssertion}).
   *
   * The runtime records the names passed to `getAxis` while a harness poll window
   * is open, and `input.observedPolls` — the field that separates "the key was
   * never pressed" from "the game never asks" — is exactly that recording. A
   * harness that sampled axes through the recorded path would list every axis its
   * own assertions mention as polled by the game, turning the most valuable
   * diagnostic in the report into a tautology. So the loop's reader must either
   * bypass the recording or sample while the window is closed.
   */
  axes?: ReadonlyMap<string, number>;
}

/** One live subscription the loop must set up for the run. */
export interface SignalWatchSpec {
  /** Signal name to listen for. */
  name: string;
  /** Live node name or nodeId, or undefined for a scene-wide watch. */
  node?: string;
}

/**
 * Key shared by the watcher (which records) and the predicate (which reads), so
 * the two cannot drift. The separator is a NUL because a node name is whatever a
 * user typed in the editor — dots, colons and slashes are all plausible in one.
 */
export function signalWatchKey(spec: SignalWatchSpec): string {
  return `${spec.node ?? '*'}\u0000${spec.name}`;
}

/** The frame-0 record every predicate is judged against. */
export type AssertionBaseline = AssertionFrame;

export interface AssertionOutcome {
  met: boolean;
  /** One line of evidence: what was measured. Becomes the tail of the verdict. */
  detail: string;
}

/**
 * Node names/ids the assertions mention — what the loop must resolve each frame.
 *
 * `nodeAppeared` contributes its query too: the by-name reading of that predicate
 * is answered entirely from `presentNodes`, so listing it here is what makes the
 * common case ("the win banner appeared") work with no extra loop machinery at
 * all. A query that is really a type name simply never resolves, which costs one
 * failed lookup per frame and is reported by the by-type reading instead.
 */
export function assertionNodeNames(assertions: readonly GameAssertion[]): string[] {
  const names = new Set<string>();
  for (const assertion of assertions) {
    switch (assertion.kind) {
      case 'nodeGone':
      case 'nodeMoved':
      case 'nodeProperty':
        names.add(assertion.name);
        break;
      case 'nodeAppeared':
        names.add(assertion.query);
        break;
      default:
        break;
    }
  }
  return [...names];
}

/**
 * Nodes whose full transform snapshot the loop must capture each frame.
 *
 * Kept separate from {@link assertionNodeNames} because the two cost wildly
 * different amounts: existence is a lookup, a snapshot walks the node's world
 * matrix, children and control state. Only `nodeMoved` needs the expensive one.
 */
export function assertionSnapshotNames(assertions: readonly GameAssertion[]): string[] {
  const names = new Set<string>();
  for (const assertion of assertions) {
    if (assertion.kind === 'nodeMoved') names.add(assertion.name);
  }
  return [...names];
}

/** Type queries the loop must count live nodes for (the by-type `nodeAppeared`). */
export function assertionTypeQueries(assertions: readonly GameAssertion[]): string[] {
  const queries = new Set<string>();
  for (const assertion of assertions) {
    if (assertion.kind === 'nodeAppeared') queries.add(assertion.query);
  }
  return [...queries];
}

/** One (node, property path) pair the loop must read each frame. */
export interface NodePropertyRead {
  name: string;
  path: string;
  /** The map key both sides use — see {@link nodePropertyKey}. */
  key: string;
}

/**
 * Key shared by the reader and the predicate. NUL-separated for the same reason
 * as {@link signalWatchKey}: a node name is whatever a user typed, and dots are
 * ordinary in one — while dots are *structural* in the property path, so any
 * printable separator could be produced by a legitimate name.
 */
export function nodePropertyKey(name: string, path: string): string {
  return `${name} ${path}`;
}

/** The property readings the loop must take, deduped. */
export function assertionPropertyReads(assertions: readonly GameAssertion[]): NodePropertyRead[] {
  const reads = new Map<string, NodePropertyRead>();
  for (const assertion of assertions) {
    if (assertion.kind !== 'nodeProperty') continue;
    const key = nodePropertyKey(assertion.name, assertion.path);
    reads.set(key, { name: assertion.name, path: assertion.path, key });
  }
  return [...reads.values()];
}

/** Input axes the loop must sample each frame (without recording a game poll). */
export function assertionAxisNames(assertions: readonly GameAssertion[]): string[] {
  const names = new Set<string>();
  for (const assertion of assertions) {
    if (assertion.kind === 'axis') names.add(assertion.name);
  }
  return [...names];
}

/** True when any assertion needs the game's debug snapshot (lets the loop skip sampling). */
export function assertionsNeedGameState(assertions: readonly GameAssertion[]): boolean {
  return assertions.some(a => a.kind === 'gameState' || a.kind === 'gameStateChanged');
}

/** True when the loop must read and window the command journal each frame. */
export function assertionsNeedCommands(assertions: readonly GameAssertion[]): boolean {
  return assertions.some(a => a.kind === 'command');
}

/**
 * The subscriptions the loop must open for the run, deduped — two assertions on
 * the same node and signal share one listener, and one global watch subsumes
 * nothing (a scoped watch and a global watch on the same name are separate
 * observations on purpose: the scoped one must stay provable on its own).
 */
export function assertionSignalWatches(assertions: readonly GameAssertion[]): SignalWatchSpec[] {
  const specs = new Map<string, SignalWatchSpec>();
  for (const assertion of assertions) {
    if (assertion.kind !== 'signal') continue;
    const spec: SignalWatchSpec = {
      name: assertion.name,
      ...(assertion.node ? { node: assertion.node } : {}),
    };
    specs.set(signalWatchKey(spec), spec);
  }
  return [...specs.values()];
}

/** Compact human label, e.g. `gameStateChanged score by +1`. Used in verdicts and reports. */
export function describeAssertion(assertion: GameAssertion): string {
  switch (assertion.kind) {
    case 'gameState':
      return `gameState ${assertion.path} ${assertion.op} ${formatJson(assertion.value)}`;
    case 'gameStateChanged':
      return assertion.by === undefined
        ? `gameStateChanged ${assertion.path}`
        : `gameStateChanged ${assertion.path} by ${assertion.by > 0 ? '+' : ''}${assertion.by}`;
    case 'nodeGone':
      return `nodeGone ${assertion.name}`;
    case 'nodeMoved': {
      const bounds: string[] = [];
      if (assertion.axis) bounds.push(`axis ${assertion.axis}`);
      if (assertion.min !== undefined) bounds.push(`min ${assertion.min}`);
      if (assertion.max !== undefined) bounds.push(`max ${assertion.max}`);
      return bounds.length
        ? `nodeMoved ${assertion.name} (${bounds.join(', ')})`
        : `nodeMoved ${assertion.name}`;
    }
    case 'nodeAppeared':
      return `nodeAppeared ${assertion.query}`;
    case 'nodeProperty':
      return `nodeProperty ${assertion.name}.${assertion.path} ${assertion.op} ${formatJson(assertion.value)}`;
    case 'axis':
      return `axis ${assertion.name} ${assertion.op} ${assertion.value}`;
    case 'newErrors':
      return assertion.min !== undefined && assertion.min !== 1
        ? `newErrors >= ${assertion.min}`
        : 'newErrors';
    case 'frames':
      return `frames ${assertion.n}`;
    case 'command':
      return assertion.args
        ? `command ${assertion.name} ${formatJson(assertion.args as Json)}`
        : `command ${assertion.name}`;
    case 'signal':
      return assertion.node
        ? `signal ${assertion.node}.${assertion.name}`
        : `signal ${assertion.name}`;
    default:
      return `unknown assertion ${String((assertion as { kind?: unknown }).kind)}`;
  }
}

/**
 * Judge one predicate against one frame.
 *
 * Every branch returns a `detail` whether or not it passed: the *unmet* details
 * are what a `timeout` verdict reports ("score was still 0 at frame 600"), and
 * without them a timeout says only that nothing happened, which is the least
 * useful sentence a test harness can produce.
 */
export function evaluateAssertion(
  assertion: GameAssertion,
  frame: AssertionFrame,
  baseline: AssertionBaseline
): AssertionOutcome {
  switch (assertion.kind) {
    case 'gameState': {
      if (frame.gameState === null) {
        return {
          met: false,
          detail: `no GameDebugProvider snapshot — "${assertion.path}" is unreadable (register one with registerGameDebug)`,
        };
      }
      const actual = resolveJsonPath(frame.gameState, assertion.path);
      const met = compareJson(actual, assertion.op, assertion.value);
      if (actual === undefined) {
        return { met, detail: `game state has no "${assertion.path}"` };
      }
      return {
        met,
        detail: `${assertion.path} = ${formatJson(actual)} (wanted ${assertion.op} ${formatJson(assertion.value)})`,
      };
    }

    case 'gameStateChanged': {
      if (frame.gameState === null) {
        return {
          met: false,
          detail: `no GameDebugProvider snapshot — "${assertion.path}" is unreadable (register one with registerGameDebug)`,
        };
      }
      const before = resolveJsonPath(baseline.gameState, assertion.path);
      const now = resolveJsonPath(frame.gameState, assertion.path);
      if (before === undefined && now === undefined) {
        return { met: false, detail: `game state has no "${assertion.path}"` };
      }
      if (assertion.by === undefined) {
        const met = JSON.stringify(before ?? null) !== JSON.stringify(now ?? null);
        return {
          met,
          detail: `${assertion.path} ${formatJson(before)} → ${formatJson(now)}`,
        };
      }
      if (typeof before !== 'number' || typeof now !== 'number') {
        return {
          met: false,
          detail: `${assertion.path} is not numeric (${formatJson(before)} → ${formatJson(now)}), so a "by" delta cannot be measured`,
        };
      }
      const delta = now - before;
      // A signed threshold: `by: -2` asks for a drop of at least 2, not "any change of size 2".
      const met = assertion.by >= 0 ? delta >= assertion.by : delta <= assertion.by;
      return {
        met,
        detail: `${assertion.path} ${before} → ${now} (Δ${delta >= 0 ? '+' : ''}${round3(delta)}, wanted ${assertion.by >= 0 ? '≥ +' : '≤ '}${assertion.by})`,
      };
    }

    case 'nodeGone': {
      const present = frame.presentNodes.has(assertion.name);
      if (!baseline.presentNodes.has(assertion.name)) {
        // True, but for the wrong reason. Said plainly here it surfaces as
        // `precondition-already-met` at frame 0 instead of a hollow PASS.
        return {
          met: !present,
          detail: `"${assertion.name}" was already absent at frame 0 — nothing died, the name may be wrong`,
        };
      }
      return {
        met: !present,
        detail: present
          ? `"${assertion.name}" is still in the scene`
          : `"${assertion.name}" left the scene`,
      };
    }

    case 'nodeMoved':
      return evaluateNodeMoved(assertion, frame, baseline);

    case 'nodeAppeared':
      return evaluateNodeAppeared(assertion, frame, baseline);

    case 'nodeProperty':
      return evaluateNodeProperty(assertion, frame);

    case 'axis':
      return evaluateAxis(assertion, frame);

    case 'newErrors': {
      const min = assertion.min ?? 1;
      return {
        met: frame.newErrorCount >= min,
        detail: `${frame.newErrorCount} new runtime error(s) (wanted ≥ ${min})`,
      };
    }

    case 'frames':
      return {
        met: frame.frame >= assertion.n,
        detail: `frame ${frame.frame} of ${assertion.n}`,
      };

    case 'command':
      return evaluateCommand(assertion, frame);

    case 'signal':
      return evaluateSignal(assertion, frame);

    default:
      return {
        met: false,
        detail: `unknown assertion kind "${String((assertion as { kind?: unknown }).kind)}"`,
      };
  }
}

/**
 * Displacement from the baseline, with the direction bounds of §5.4.5.
 *
 * Every negative branch names a different bug: an unknown name, a node that died
 * mid-run, a NaN transform, and "it moved, but not the way you asked" are four
 * separate sentences because they have four separate fixes.
 */
function evaluateNodeMoved(
  assertion: NodeMovedAssertion,
  frame: AssertionFrame,
  baseline: AssertionBaseline
): AssertionOutcome {
  if (!frame.nodes || !baseline.nodes) {
    return {
      met: false,
      detail: `no transform snapshots were captured for this run, so "${assertion.name}" cannot be measured (harness bug: a nodeMoved predicate must turn snapshot capture on)`,
    };
  }
  const before = baseline.nodes.get(assertion.name);
  const after = frame.nodes.get(assertion.name);
  if (!before) {
    return {
      met: false,
      detail: `"${assertion.name}" was not in the scene at frame 0, so there is no origin to measure from — check the name against the running scene`,
    };
  }
  if (!after) {
    return {
      met: false,
      detail: `"${assertion.name}" is no longer in the scene at frame ${frame.frame}, so its displacement cannot be measured — assert nodeGone if leaving is the event you meant`,
    };
  }

  const dx = after.worldPosition.x - before.worldPosition.x;
  const dy = after.worldPosition.y - before.worldPosition.y;
  const dz = after.worldPosition.z - before.worldPosition.z;
  if (![dx, dy, dz].every(Number.isFinite)) {
    // Not a subtle result: a non-finite transform means physics or a script
    // produced garbage, and the node has stopped rendering anywhere real.
    return {
      met: false,
      detail: `"${assertion.name}" has a non-finite world position (${formatVec(after.worldPosition)}) — the transform is NaN/Infinity, so nothing about its motion is measurable; that is the bug to fix first`,
    };
  }

  const distance = Math.hypot(dx, dy, dz);
  const measured = assertion.axis ? { x: dx, y: dy, z: dz }[assertion.axis] : distance;
  const { min, max } = assertion;
  // A bound that already demands motion replaces the default floor; otherwise the
  // half-unit floor applies, so `{axis:'x', max:0}` cannot be met by standing still.
  const floor =
    min !== undefined && min > 0 ? min : max !== undefined && max < 0 ? -max : undefined;
  const effectiveFloor = floor ?? DEFAULT_MOVE_MIN;
  const met =
    Math.abs(measured) >= effectiveFloor &&
    (min === undefined || measured >= min) &&
    (max === undefined || measured <= max);

  const what = assertion.axis
    ? `Δ${assertion.axis} ${signed(measured)}`
    : `moved ${round3(distance)}u`;
  const where = assertion.axis
    ? ` (total ${round3(distance)}u)`
    : ` (Δ${signed(dx)}, ${signed(dy)}, ${signed(dz)})`;
  return {
    met,
    detail: `"${assertion.name}" ${what}${where} since frame 0 — wanted ${describeMoveBounds(assertion, effectiveFloor)}`,
  };
}

/** The bound half of a `nodeMoved` detail, written the way the test asked for it. */
function describeMoveBounds(assertion: NodeMovedAssertion, floor: number): string {
  const parts: string[] = [];
  if (assertion.min !== undefined) parts.push(`≥ ${assertion.min}`);
  if (assertion.max !== undefined) parts.push(`≤ ${assertion.max}`);
  const bounds = parts.length ? parts.join(' and ') : `≥ ${floor}`;
  const magnitude =
    parts.length && floor > 0 ? ` (and at least ${floor} of movement either way)` : '';
  return assertion.axis
    ? `a signed ${assertion.axis} delta ${bounds}${magnitude}`
    : `a distance ${bounds}${magnitude}`;
}

/**
 * A spawn, read two ways (see {@link NodeAppearedAssertion}).
 *
 * The by-type reading is the one that survives object pooling, so its absence is
 * reported explicitly: "no type count was collected" and "the count did not go
 * up" are different answers, and only the second is about the game.
 */
function evaluateNodeAppeared(
  assertion: NodeAppearedAssertion,
  frame: AssertionFrame,
  baseline: AssertionBaseline
): AssertionOutcome {
  const query = assertion.query;
  const wasPresent = baseline.presentNodes.has(query);
  const isPresent = frame.presentNodes.has(query);
  const countNow = frame.typeCounts?.get(query);
  const countBefore = baseline.typeCounts?.get(query);

  if (!wasPresent && isPresent) {
    return {
      met: true,
      detail: `"${query}" was absent at frame 0 and is in the scene at frame ${frame.frame}`,
    };
  }
  if (countNow !== undefined && countBefore !== undefined && countNow > countBefore) {
    return {
      met: true,
      detail: `${countNow} live "${query}" node(s) at frame ${frame.frame}, up from ${countBefore} at frame 0`,
    };
  }

  const byName = wasPresent
    ? `a node named "${query}" was already in the scene at frame 0, so nothing appeared under that name`
    : `nothing named "${query}" is in the scene`;
  const byType =
    countNow === undefined || countBefore === undefined
      ? ` and no live count was collected for the type "${query}", so a pooled or duplicate spawn would be invisible here`
      : ` and the live count of "${query}" nodes is still ${countNow} (was ${countBefore})`;
  return { met: false, detail: `${byName}${byType}` };
}

/** A property of a live node, judged with the same state core as `gameState`. */
function evaluateNodeProperty(
  assertion: NodePropertyAssertion,
  frame: AssertionFrame
): AssertionOutcome {
  const key = nodePropertyKey(assertion.name, assertion.path);
  if (!frame.nodeProperties || !frame.nodeProperties.has(key)) {
    return {
      met: false,
      detail: `"${assertion.name}".${assertion.path} was never read during the run, so it cannot be judged (harness bug: a nodeProperty predicate must be collected each frame)`,
    };
  }
  const actual = frame.nodeProperties.get(key);
  if (actual === undefined) {
    return {
      met: false,
      detail: frame.presentNodes.has(assertion.name)
        ? `"${assertion.name}" has no property "${assertion.path}" — the path is a dot path into the node's own properties (position.x, text, enabled, opacity)`
        : `no live node answers "${assertion.name}", so "${assertion.path}" could not be read — check the name against the running scene`,
    };
  }
  const met = compareJson(actual, assertion.op, assertion.value);
  const strictness =
    !met && isOrderingOp(assertion.op) && typeof actual !== 'number'
      ? ` — "${assertion.op}" orders numbers only, and this value is a ${typeof actual}; compare it with eq/ne or assert a numeric property`
      : '';
  return {
    met,
    detail: `${assertion.name}.${assertion.path} = ${formatJson(actual)} (wanted ${assertion.op} ${formatJson(assertion.value)})${strictness}`,
  };
}

/** The joystick's own output, before any game logic (§5.4.5). */
function evaluateAxis(assertion: AxisAssertion, frame: AssertionFrame): AssertionOutcome {
  if (!frame.axes || !frame.axes.has(assertion.name)) {
    return {
      met: false,
      detail: `input axis "${assertion.name}" was not sampled during the run, so it cannot be judged (harness bug: an axis predicate must be sampled each frame, without registering as a game poll)`,
    };
  }
  const value = frame.axes.get(assertion.name);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      met: false,
      detail: `input axis "${assertion.name}" read as ${formatJson((value ?? null) as Json)}, which is not a finite number — an axis is numeric by definition, so this is an input-layer fault rather than a game result`,
    };
  }
  const met = compareJson(value, assertion.op, assertion.value);
  // The single most useful hint in the whole vocabulary: an axis still at rest
  // means the gesture never reached the control, so the game is not even in the
  // picture yet (§5.4.5).
  const atRest =
    !met && value === 0
      ? ` — the axis never left 0, so the gesture did not reach the control at all (wrong control name, pointer outside its bounds, or the control is disabled); the game's reading of the axis is not in question yet`
      : '';
  return {
    met,
    detail: `axis ${assertion.name} = ${round3(value)} (wanted ${assertion.op} ${assertion.value})${atRest}`,
  };
}

const ORDERING_OPS: readonly ComparisonOp[] = ['gt', 'gte', 'lt', 'lte'];
const isOrderingOp = (op: ComparisonOp): boolean => ORDERING_OPS.includes(op);

const signed = (n: number): string => `${n >= 0 ? '+' : ''}${round3(n)}`;
const formatVec = (v: { x: number; y: number; z: number }): string => `${v.x}, ${v.y}, ${v.z}`;

/** How many distinct command names a "never dispatched" detail lists. */
const MAX_DETAIL_NAMES = 5;
/** How many dispatched payloads a "wrong args" detail shows. */
const MAX_DETAIL_ARGS = 3;

/**
 * Did an intent get raised inside the run window, and did it run?
 *
 * Split out of {@link evaluateAssertion} because the negative branches carry most
 * of the value: "dispatched, but nothing is registered under that name", "the
 * journal overflowed", "you dispatched it before the run started" are three
 * different bugs that a bare `false` would collapse into one shrug.
 */
function evaluateCommand(assertion: CommandAssertion, frame: AssertionFrame): AssertionOutcome {
  const window = frame.commands;
  if (!window) {
    return {
      met: false,
      detail: `the command journal was not collected for this run, so "${assertion.name}" cannot be judged (harness bug: a command predicate must turn the collection on)`,
    };
  }
  if (!window.available) {
    return {
      met: false,
      detail: `the running scene exposes no command registry, so nothing could have dispatched "${assertion.name}" — register the intent with scene.commands.register() and have the control's handler dispatch it`,
    };
  }

  // A dropped entry must never read as "it never happened" (§5.2): the ring
  // buffer keeps the newest 50 dispatches, so a busy run loses the oldest.
  const overflow =
    window.dropped > 0
      ? ` The journal dropped ${window.dropped} entr${window.dropped === 1 ? 'y' : 'ies'} during this run (it holds only the most recent dispatches), so an earlier dispatch may be invisible here — shorten the run or assert closer to the action.`
      : '';
  const reset = window.reset
    ? ' The journal was also cleared mid-run (the scene stopped or changed), so anything dispatched before that is gone.'
    : '';

  const named = window.entries.filter(entry => entry.name === assertion.name);
  if (named.length === 0) {
    return {
      met: false,
      detail: `"${assertion.name}" was not dispatched during the run${describeOtherCommands(window.entries)}${describePreWindowDispatches(assertion.name, window)}.${overflow}${reset}`,
    };
  }

  // Only a dispatch that reached the end of its handler counts. The others are
  // reported by name: an intent raised into a registry that has no such command
  // is a broken game, not a passing binding test.
  const ran = named.filter(entry => entry.status === 'ok');
  if (ran.length === 0) {
    const last = named[named.length - 1];
    return {
      met: false,
      detail: `"${assertion.name}" was dispatched (engine frame ${last.frame}) but did not run — ${explainCommandStatus(last)}.${overflow}`,
    };
  }

  const expected = assertion.args;
  if (!expected) {
    return {
      met: true,
      detail: `"${assertion.name}" dispatched ${ran.length}× (first at engine frame ${ran[0].frame})`,
    };
  }

  const matched = ran.find(entry => matchesArgsSubset(entry.args, expected));
  if (matched) {
    return {
      met: true,
      detail: `"${assertion.name}" dispatched at engine frame ${matched.frame} with ${formatJson((matched.args ?? null) as Json)}, which contains ${formatJson(expected as Json)}`,
    };
  }
  if (ran.some(entry => entry.argsOmitted)) {
    return {
      met: false,
      detail: `"${assertion.name}" was dispatched ${ran.length}×, but its arguments were too large to journal, so they cannot be matched — assert on the effect instead, or dispatch a smaller payload.${overflow}`,
    };
  }
  const seen = ran
    .slice(-MAX_DETAIL_ARGS)
    .map(entry => formatJson((entry.args ?? null) as Json))
    .join(', ');
  return {
    met: false,
    detail: `"${assertion.name}" dispatched ${ran.length}× but never with ${formatJson(expected as Json)} — saw ${seen}.${overflow}`,
  };
}

/** Every key given must be present and deep-equal; extra keys are ignored (§ subset match). */
function matchesArgsSubset(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, Json>
): boolean {
  if (!actual) return false;
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in actual)) return false;
    // Nested values compare as whole subtrees: partial matching stops at the top
    // level, which is the level an agent names ("slot: 2"), and going deeper would
    // make `{a: {}}` match everything.
    if (JSON.stringify(actual[key] ?? null) !== JSON.stringify(value ?? null)) return false;
  }
  return true;
}

function describeOtherCommands(entries: readonly GameCommandLogEntry[]): string {
  const names = [...new Set(entries.map(entry => entry.name))];
  if (names.length === 0) return ' (no command was dispatched at all)';
  const shown = names.slice(0, MAX_DETAIL_NAMES).join(', ');
  return ` (what was dispatched: ${shown}${names.length > MAX_DETAIL_NAMES ? ', …' : ''})`;
}

/**
 * The one case where entries outside the window are worth mentioning: the §5.8.4
 * recipe taps with `game_input`, which runs in realtime *before* `game_run`, so a
 * correct binding can still look silent. Saying so beats a false negative.
 */
function describePreWindowDispatches(name: string, window: CommandWindow): string {
  const before = (window.beforeWindow ?? []).filter(entry => entry.name === name);
  if (before.length === 0) return '';
  return `, though it WAS dispatched ${before.length}× before the run started (last at engine frame ${before[before.length - 1].frame}) — the window opens at the baseline, so an action sent before game_run falls outside it`;
}

function explainCommandStatus(entry: GameCommandLogEntry): string {
  switch (entry.status) {
    case 'unknown':
      return `nothing is registered under that name, so the intent was raised into thin air (the control's binding is fine; the handler is missing)`;
    case 'rejected':
      return `the registry refused it: ${entry.error ?? 'rejected'}`;
    case 'error':
      return `its handler threw: ${entry.error ?? 'error'}`;
    case 'undo':
      return `that journal line is an undo of the command, not a dispatch of it`;
    default:
      return entry.error ?? entry.status;
  }
}

/** Did a node emit this signal inside the run window? */
function evaluateSignal(assertion: SignalAssertion, frame: AssertionFrame): AssertionOutcome {
  const label = assertion.node ? `"${assertion.node}.${assertion.name}"` : `"${assertion.name}"`;
  const observation = frame.signals?.get(signalWatchKey(assertion));
  if (!observation) {
    return {
      met: false,
      detail: `no listener was installed for ${label}, so it cannot be judged (harness bug: a signal predicate needs a subscription open for the whole run)`,
    };
  }
  if (observation.count > 0) {
    const who = observation.emitters.length
      ? ` from ${observation.emitters.join(', ')}${observation.emitterOverflow ? ', …' : ''}`
      : '';
    const span =
      observation.lastFrame > observation.firstFrame
        ? `frames ${observation.firstFrame}–${observation.lastFrame}`
        : `frame ${observation.firstFrame}`;
    return { met: true, detail: `${label} fired ${observation.count}× at ${span}${who}` };
  }
  if (!observation.everAttached) {
    // The signal analogue of nodeGone's "already absent" guard: unreachable is a
    // different failure from silent, and only one of them is the game's fault.
    return {
      met: false,
      detail: assertion.node
        ? `no live node named "${assertion.node}" was found during the run, so ${label} could never be heard — check the name against the running scene`
        : `the running scene had no live nodes to listen on, so ${label} could never be heard`,
    };
  }
  const overflow = observation.attachOverflow
    ? ' The scene is bigger than the watcher\'s sweep cap, so some nodes were never subscribed — scope the assertion with "node" to make it exact.'
    : '';
  return {
    met: false,
    detail: `${label} never fired (listening on ${observation.attached} node(s)).${overflow}`,
  };
}

/**
 * The first assertion of a list that is met, with its index and evidence — the
 * "OR over the list" of §5.2. Returns null when none fired, along with nothing
 * else: the caller already holds the list and can re-evaluate for details.
 */
export function firstMetAssertion(
  assertions: readonly GameAssertion[],
  frame: AssertionFrame,
  baseline: AssertionBaseline
): { index: number; assertion: GameAssertion; outcome: AssertionOutcome } | null {
  for (let index = 0; index < assertions.length; index += 1) {
    const outcome = evaluateAssertion(assertions[index], frame, baseline);
    if (outcome.met) {
      return { index, assertion: assertions[index], outcome };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parsing (tool-facing)
// ---------------------------------------------------------------------------

/**
 * Validate one assertion straight out of a tool call's JSON.
 *
 * Written here rather than at the tool boundary because the *predicate* owns
 * what a well-formed predicate is; a registry that re-derives it would drift.
 * Every rejection names the field and the accepted shape, since the reader is a
 * model that has to fix the call from the message alone.
 */
export function parseAssertion(raw: unknown): { assertion: GameAssertion } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      error: `Each assertion must be an object like {kind: 'gameStateChanged', path: 'score', by: 1}.`,
    };
  }
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  switch (kind) {
    case 'gameState': {
      if (typeof record.path !== 'string' || record.path.length === 0) {
        return { error: `gameState needs a non-empty "path" (dot path into the game snapshot).` };
      }
      if (!isComparisonOp(record.op)) {
        return { error: `gameState needs "op" — one of ${COMPARISON_OPS.join(' | ')}.` };
      }
      if (record.value === undefined) {
        return { error: `gameState needs a "value" to compare against.` };
      }
      return {
        assertion: {
          kind: 'gameState',
          path: record.path,
          op: record.op,
          value: record.value as Json,
        },
      };
    }
    case 'gameStateChanged': {
      if (typeof record.path !== 'string' || record.path.length === 0) {
        return { error: `gameStateChanged needs a non-empty "path".` };
      }
      if (
        record.by !== undefined &&
        (typeof record.by !== 'number' || !Number.isFinite(record.by))
      ) {
        return {
          error: `gameStateChanged "by" must be a finite number (the signed delta to reach).`,
        };
      }
      return {
        assertion: {
          kind: 'gameStateChanged',
          path: record.path,
          ...(record.by !== undefined ? { by: record.by as number } : {}),
        },
      };
    }
    case 'nodeGone': {
      const name = record.name ?? record.target;
      if (typeof name !== 'string' || name.length === 0) {
        return { error: `nodeGone needs a "name" (live node name or nodeId).` };
      }
      return { assertion: { kind: 'nodeGone', name } };
    }
    case 'nodeMoved': {
      const name = record.name ?? record.target ?? record.node;
      if (typeof name !== 'string' || name.length === 0) {
        return { error: `nodeMoved needs a "name" (live node name or nodeId).` };
      }
      const axis = record.axis;
      if (axis !== undefined && axis !== 'x' && axis !== 'y' && axis !== 'z') {
        return {
          error: `nodeMoved "axis" must be 'x', 'y' or 'z' (a world axis); omit it to measure plain distance travelled.`,
        };
      }
      for (const bound of ['min', 'max'] as const) {
        const value = record[bound];
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
          return {
            error: `nodeMoved "${bound}" must be a finite number — ${
              axis
                ? `a bound on the signed ${String(axis)} delta, e.g. {axis: '${String(axis)}', max: 0} for "moved left".`
                : `a bound on the distance travelled, e.g. {min: 2}. Add "axis" if you meant a direction.`
            }`,
          };
        }
      }
      if (
        typeof record.min === 'number' &&
        typeof record.max === 'number' &&
        record.min > record.max
      ) {
        return {
          error: `nodeMoved "min" (${record.min}) is above "max" (${record.max}), so nothing can satisfy it.`,
        };
      }
      if (axis === undefined && typeof record.max === 'number' && record.max < 0) {
        return {
          error: `nodeMoved "max" is negative without an "axis", but a distance is never negative — add {axis: 'x' | 'y' | 'z'} to express a direction.`,
        };
      }
      return {
        assertion: {
          kind: 'nodeMoved',
          name,
          ...(axis !== undefined ? { axis: axis as 'x' | 'y' | 'z' } : {}),
          ...(record.min !== undefined ? { min: record.min as number } : {}),
          ...(record.max !== undefined ? { max: record.max as number } : {}),
        },
      };
    }
    case 'nodeAppeared': {
      const query = record.query ?? record.name ?? record.type ?? record.target;
      if (typeof query !== 'string' || query.length === 0) {
        return {
          error: `nodeAppeared needs a name or a node type, e.g. {kind: 'nodeAppeared', query: 'Enemy2D'}. Both readings are tried: a node with that name showing up, or more live nodes of that type than at the start.`,
        };
      }
      return { assertion: { kind: 'nodeAppeared', query } };
    }
    case 'nodeProperty': {
      const name = record.name ?? record.node ?? record.target;
      if (typeof name !== 'string' || name.length === 0) {
        return { error: `nodeProperty needs a "name" (live node name or nodeId).` };
      }
      const path = record.path ?? record.property;
      if (typeof path !== 'string' || path.length === 0) {
        return {
          error: `nodeProperty needs a "path" — a dot path into the node's properties, e.g. 'position.x', 'text', 'enabled'.`,
        };
      }
      if (!isComparisonOp(record.op)) {
        return { error: `nodeProperty needs "op" — one of ${COMPARISON_OPS.join(' | ')}.` };
      }
      if (record.value === undefined) {
        return { error: `nodeProperty needs a "value" to compare against.` };
      }
      return {
        assertion: {
          kind: 'nodeProperty',
          name,
          path,
          op: record.op,
          value: record.value as Json,
        },
      };
    }
    case 'axis': {
      const name = record.name ?? record.axis;
      if (typeof name !== 'string' || name.length === 0) {
        return {
          error: `axis needs a "name" — the input axis as the game knows it, e.g. {kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4}.`,
        };
      }
      if (!isComparisonOp(record.op) || record.op === 'contains') {
        return {
          error: `axis needs "op" — one of ${COMPARISON_OPS.filter(op => op !== 'contains').join(' | ')} ("contains" has no meaning for a number).`,
        };
      }
      if (typeof record.value !== 'number' || !Number.isFinite(record.value)) {
        return {
          error: `axis "value" must be a finite number (axes read −1..1). Prefer a threshold to equality: a stick lands on 0.6187…, not on 0.6.`,
        };
      }
      return { assertion: { kind: 'axis', name, op: record.op, value: record.value } };
    }
    case 'newErrors': {
      if (
        record.min !== undefined &&
        (typeof record.min !== 'number' || !Number.isInteger(record.min) || record.min < 1)
      ) {
        return { error: `newErrors "min" must be an integer >= 1.` };
      }
      return {
        assertion: {
          kind: 'newErrors',
          ...(record.min !== undefined ? { min: record.min as number } : {}),
        },
      };
    }
    case 'frames': {
      const n = record.n ?? record.count;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
        return {
          error: `frames needs "n" — an integer >= 1 (frames(0) is true before the run starts).`,
        };
      }
      return { assertion: { kind: 'frames', n } };
    }
    case 'command': {
      const name = record.name ?? record.command;
      if (typeof name !== 'string' || name.length === 0) {
        return {
          error: `command needs a "name" — the intent as registered, e.g. {kind: 'command', name: 'settings.toggle-music'}.`,
        };
      }
      if (
        record.args !== undefined &&
        (typeof record.args !== 'object' || record.args === null || Array.isArray(record.args))
      ) {
        return {
          error: `command "args" must be an object of fields to match, e.g. {slot: 2}. Only the fields you name are compared, so a partial payload is fine.`,
        };
      }
      return {
        assertion: {
          kind: 'command',
          name,
          ...(record.args !== undefined ? { args: record.args as Record<string, Json> } : {}),
        },
      };
    }
    case 'signal': {
      const name = record.name ?? record.signal;
      if (typeof name !== 'string' || name.length === 0) {
        return {
          error: `signal needs a "name" — the signal a node emits, e.g. {kind: 'signal', name: 'toggled', node: 'MusicCheckbox'}.`,
        };
      }
      const node = record.node ?? record.target;
      if (node !== undefined && (typeof node !== 'string' || node.length === 0)) {
        return {
          error: `signal "node" must be a non-empty live node name or nodeId; omit it to listen scene-wide.`,
        };
      }
      return {
        assertion: {
          kind: 'signal',
          name,
          ...(typeof node === 'string' ? { node } : {}),
        },
      };
    }
    default:
      return {
        error: `Unknown assertion kind "${String(kind)}". This slice supports: ${GAME_ASSERTION_KINDS.join(', ')}.`,
      };
  }
}

/** Validate a whole list; the first bad entry aborts with its position named. */
export function parseAssertions(
  raw: unknown,
  channel: string
): { assertions: GameAssertion[] } | { error: string } {
  if (raw === undefined || raw === null) return { assertions: [] };
  if (!Array.isArray(raw)) {
    return { error: `"${channel}" must be an array of assertions.` };
  }
  const assertions: GameAssertion[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseAssertion(raw[index]);
    if ('error' in parsed) {
      return { error: `${channel}[${index}]: ${parsed.error}` };
    }
    assertions.push(parsed.assertion);
  }
  return { assertions };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
