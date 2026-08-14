/**
 * Monkey mode for `game_run` (§5.2 of `.plans/agent-gameplay-testing.md`).
 *
 * Random input under the harness's control, judged by invariants instead of by
 * an understanding of the game. It is the **zero test** for Flow's verify gate:
 * it cannot tell you the game is fun, or even that it is winnable, but it finds
 * the two failures that need no understanding at all — a crash, and a state the
 * game cannot leave.
 *
 * Everything here is pure logic over plain records: a seeded decision stream, a
 * catalogue of what the scene actually offers, and a stateful invariant monitor.
 * The loop (`GameTestService`) supplies the world and executes the actions; this
 * module never touches a runner, a node or a clock. That split is what lets a
 * spec prove determinism by replaying an inventory sequence, which is impossible
 * against a live scene.
 *
 * ## Three rules this module exists to enforce
 *
 * 1. **The seed is mandatory and reported.** A monkey finding that cannot be
 *    re-run is an anecdote. `parseMonkeySpec` refuses a run without one rather
 *    than inventing a random seed, because a harness-chosen seed is only
 *    reproducible if someone thought to write it down.
 * 2. **Actions come from the scene, not from imagination.** Candidates are the
 *    live interactive controls (as `game_controls` lists them) and the intents
 *    the game actually declares. A monkey that taps coordinates in an empty
 *    region proves nothing and, worse, looks like it is testing something.
 * 3. **A monkey with nothing to press is not a pass.** An empty inventory ends
 *    the run with a stated reason ({@link MONKEY_EMPTY_NOTE}); silence would
 *    otherwise read as "hammered the game for 600 frames, all clear".
 */

import type { Json } from '@/core/agent-introspection';
import type {
  ControlInteraction,
  ControlInteractionArg,
  LiveControlEntry,
} from '@/services/agent/GameInputService';
import {
  formatJson,
  resolveJsonPath,
  type AssertionBaseline,
  type AssertionFrame,
} from '@/services/agent/game-assertions';

// ---------------------------------------------------------------------------
// The decision stream
// ---------------------------------------------------------------------------

/**
 * mulberry32 — a 32-bit PRNG chosen for one property: it is a pure function of a
 * 32-bit state, so "seed 42" means the same stream in this process, in a spec,
 * and in whoever's browser reproduces the report. `Math.random` cannot be seeded
 * at all, and anything the platform supplies could change under us.
 */
export function makeSeededRandom(seed: number): () => number {
  // Force the seed into uint32 so a float, a negative or a huge integer still
  // yields a defined, reproducible stream instead of NaN soup.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// What the scene offers
// ---------------------------------------------------------------------------

/**
 * The action surface of the running scene at one moment.
 *
 * `controls` is the exact listing `game_controls` produces
 * ({@link LiveControlEntry}) rather than a monkey-specific shape — the point is
 * that a monkey presses what a test (or a human) could press, and a second
 * definition of "what is pressable" would drift from the first.
 */
export interface MonkeyInventory {
  /** Live interactive nodes, as listed by `game_controls`. */
  controls: readonly LiveControlEntry[];
  /** Registered intents — `scene.commands.list()` / the provider's `actions()`. */
  commands: readonly string[];
  /**
   * Input action names the run declares (`monkey: {actions: […]}`) or the game
   * declares through its debug provider: `Key_ArrowLeft`, `Action_Primary`, …
   * These are held for a few frames rather than pulsed, because gameplay polls
   * input per tick and a one-frame press is invisible to most games.
   */
  actions: readonly string[];
}

/** One thing the monkey decided to do. The loop knows how to execute each shape. */
export type MonkeyAction =
  | {
      kind: 'interaction';
      /** Live node name. */
      node: string;
      /** Interaction id from the node's own listing: `click`, `setValue`, … */
      interaction: string;
      args?: Record<string, Json>;
    }
  | { kind: 'command'; name: string }
  | { kind: 'action'; name: string; frames: number };

/** One line of the monkey's log — what it pressed, when, and how that went. */
export interface MonkeyLogEntry {
  frame: number;
  action: MonkeyAction;
  /** `sent` until the loop says otherwise; `refused` when the control said no. */
  status: 'sent' | 'refused' | 'error';
  note?: string;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

export type MonkeyViolationKind =
  | 'new-errors'
  | 'non-finite-transform'
  | 'out-of-bounds'
  | 'score-decreased'
  | 'stalled';

export interface MonkeyViolation {
  kind: MonkeyViolationKind;
  /** Run-relative frame the violation was first observed on. */
  frame: number;
  /** One line of evidence, in the same voice as an assertion detail. */
  detail: string;
}

/**
 * Which invariants are on. Defaults are the §5.2 set; each can be turned off
 * because "off with a reason" beats a test everyone learns to ignore.
 */
export interface MonkeyInvariantOptions {
  /** A new runtime error ends the run. Default on — this is the crash detector. */
  newErrors?: boolean;
  /** NaN/Infinity in a watched transform ends the run. Default on. */
  finiteTransforms?: boolean;
  /**
   * How far from the origin a watched node may travel before it counts as
   * escaped. Default {@link DEFAULT_BOUNDS_RADIUS}; `false` disables the check.
   *
   * The default is deliberately far outside any playfield: the failure this
   * catches is a physics or integration blow-up, which reaches six figures in a
   * handful of frames, not a designer's arena being slightly bigger than
   * expected. A tight bound would fail honest games; a loose one still catches
   * every real blow-up.
   */
  boundsRadius?: number | false;
  /**
   * Snapshot path of a score that must never drop. Default: `'score'` when the
   * provider exposes one, otherwise the check is skipped. `false` disables it —
   * a game where the score legitimately falls (a golf-style counter, a penalty)
   * must say so instead of learning to ignore the report.
   */
  scorePath?: string | false;
  /**
   * Frames of complete stillness — no game-state change, no watched node moving —
   * that count as stuck, while the monkey keeps pressing things. Default 0 (off),
   * because a menu is legitimately still: turn it on for a run that is supposed
   * to be in gameplay.
   */
  stallFrames?: number;
}

/** Far outside any playfield: this is a blow-up detector, not a level boundary. */
export const DEFAULT_BOUNDS_RADIUS = 10_000;

/** Actions that must have been sent since the last change before "stuck" is fair. */
const STALL_MIN_ACTIONS = 3;

interface ResolvedInvariantOptions {
  newErrors: boolean;
  finiteTransforms: boolean;
  boundsRadius: number | false;
  scorePath: string | false | undefined;
  stallFrames: number;
}

/**
 * Judges one frame at a time and remembers just enough to make two of the
 * invariants meaningful: the score's **peak** (so a dip after a gain is caught
 * even when the run ends higher than it started) and the last frame anything
 * changed (so "stuck" is a span, not an instant).
 *
 * Stateful on purpose, and deliberately not folded into the predicate vocabulary:
 * a `fail` predicate answers "did the thing I asked about happen", while these
 * answer "did the game stop making sense", which no test author should have to
 * spell out per run.
 */
export class MonkeyInvariantMonitor {
  private readonly options: ResolvedInvariantOptions;
  private peakScore: number | null = null;
  private lastChangeFrame = 0;
  private lastFingerprint: string | null = null;
  private actionsAtLastChange = 0;
  private violation: MonkeyViolation | null = null;

  constructor(options: MonkeyInvariantOptions = {}) {
    this.options = {
      newErrors: options.newErrors !== false,
      finiteTransforms: options.finiteTransforms !== false,
      boundsRadius:
        options.boundsRadius === undefined ? DEFAULT_BOUNDS_RADIUS : options.boundsRadius,
      scorePath: options.scorePath,
      stallFrames: options.stallFrames ?? 0,
    };
  }

  /** The first violation seen, or null while the run is still sane. */
  get firstViolation(): MonkeyViolation | null {
    return this.violation;
  }

  /**
   * Check one frame. Returns the violation that ends the run, or null.
   *
   * `actionsSent` is how many actions the monkey has dispatched so far; the stall
   * check needs it so that a paused, untouched game does not read as stuck.
   */
  check(
    frame: AssertionFrame,
    baseline: AssertionBaseline,
    actionsSent: number
  ): MonkeyViolation | null {
    if (this.violation) return this.violation;
    const found =
      this.checkErrors(frame) ??
      this.checkTransforms(frame) ??
      this.checkScore(frame, baseline) ??
      this.checkStall(frame, actionsSent);
    if (found) this.violation = found;
    return found;
  }

  private checkErrors(frame: AssertionFrame): MonkeyViolation | null {
    if (!this.options.newErrors || frame.newErrorCount <= 0) return null;
    return {
      kind: 'new-errors',
      frame: frame.frame,
      detail: `${frame.newErrorCount} new runtime error(s) while pressing things at random`,
    };
  }

  private checkTransforms(frame: AssertionFrame): MonkeyViolation | null {
    const nodes = frame.nodes;
    if (!nodes) return null;
    for (const [query, snapshot] of nodes) {
      const p = snapshot.worldPosition;
      const s = snapshot.scale;
      if (this.options.finiteTransforms) {
        const bad = [p.x, p.y, p.z, s.x, s.y, s.z, snapshot.rotationZ].some(
          value => !Number.isFinite(value)
        );
        if (bad) {
          return {
            kind: 'non-finite-transform',
            frame: frame.frame,
            detail: `"${query}" has a non-finite transform (position ${p.x}, ${p.y}, ${p.z}; scale ${s.x}, ${s.y}, ${s.z}; rotationZ ${snapshot.rotationZ}) — a NaN got into the maths and the node is no longer anywhere`,
          };
        }
      }
      const radius = this.options.boundsRadius;
      if (radius !== false) {
        const distance = Math.hypot(p.x, p.y, p.z);
        if (distance > radius) {
          return {
            kind: 'out-of-bounds',
            frame: frame.frame,
            detail: `"${query}" is ${Math.round(distance)} units from the origin (limit ${radius}) — it left the world rather than the playfield, which is a velocity or integration blow-up`,
          };
        }
      }
    }
    return null;
  }

  private checkScore(frame: AssertionFrame, baseline: AssertionBaseline): MonkeyViolation | null {
    const path = this.resolveScorePath(baseline);
    if (!path) return null;
    const raw = resolveJsonPath(frame.gameState, path);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    if (this.peakScore === null) {
      this.peakScore = raw;
      return null;
    }
    if (raw < this.peakScore) {
      return {
        kind: 'score-decreased',
        frame: frame.frame,
        detail: `"${path}" fell from ${this.peakScore} to ${raw} — random input should never be able to take points away (set scorePath: false if this game's counter legitimately drops)`,
      };
    }
    this.peakScore = raw;
    return null;
  }

  /**
   * `undefined` means "decide from the snapshot": a game that exposes `score`
   * gets the check for free, and a game that does not is simply not judged on it.
   * That auto-detection is why the option can be `false` rather than only unset —
   * "there is a score and it may fall" has to be sayable.
   */
  private resolveScorePath(baseline: AssertionBaseline): string | null {
    if (this.options.scorePath === false) return null;
    if (typeof this.options.scorePath === 'string') return this.options.scorePath;
    return typeof resolveJsonPath(baseline.gameState, 'score') === 'number' ? 'score' : null;
  }

  private checkStall(frame: AssertionFrame, actionsSent: number): MonkeyViolation | null {
    const window = this.options.stallFrames;
    if (window <= 0) return null;
    const fingerprint = activityFingerprint(frame);
    if (fingerprint !== this.lastFingerprint) {
      this.lastFingerprint = fingerprint;
      this.lastChangeFrame = frame.frame;
      this.actionsAtLastChange = actionsSent;
      return null;
    }
    const still = frame.frame - this.lastChangeFrame;
    const pressed = actionsSent - this.actionsAtLastChange;
    if (still < window || pressed < STALL_MIN_ACTIONS) return null;
    return {
      kind: 'stalled',
      frame: frame.frame,
      detail: `nothing changed for ${still} frames while the monkey sent ${pressed} action(s) — the game state and every watched transform are frozen, which is what being stuck looks like from outside`,
    };
  }
}

/**
 * What "something happened" means for the stall check: the game's own state plus
 * the watched transforms, rounded so that floating-point noise (a physics solver
 * settling at 1e-9 per frame) does not pass for activity.
 */
function activityFingerprint(frame: AssertionFrame): string {
  const parts: string[] = [JSON.stringify(frame.gameState ?? null)];
  if (frame.nodes) {
    for (const [query, snapshot] of [...frame.nodes].sort((a, b) => a[0].localeCompare(b[0]))) {
      const p = snapshot.worldPosition;
      parts.push(
        `${query}:${round2(p.x)},${round2(p.y)},${round2(p.z)},${round2(snapshot.rotationZ)}`
      );
    }
  }
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export interface MonkeySpec {
  /** Mandatory — see rule 1 in the module doc. */
  seed: number;
  /** Input action names the run may press, on top of whatever the game declares. */
  actions?: string[];
  /** Frames between two decisions. */
  everyFrames?: number;
  /** Frames an input action is held for. */
  holdFrames?: number;
  /** Hard cap on decisions in one run. */
  maxActions?: number;
  invariants?: MonkeyInvariantOptions;
}

/** A quarter-second at 1/60: fast enough to cover ground, slow enough to react. */
const DEFAULT_EVERY_FRAMES = 12;
/** Long enough that a per-tick poll cannot miss the press. */
const DEFAULT_HOLD_FRAMES = 8;
const DEFAULT_MAX_ACTIONS = 200;
/** Log entries kept in full before the middle is dropped. */
const MAX_LOG_HEAD = 20;
const MAX_LOG_TAIL = 40;
/** How many trailing actions the report repeats as the reproduction hint. */
const REPRO_TAIL = 10;

export const MONKEY_EMPTY_NOTE =
  'The scene offered nothing to press: no interactive control was listed, the scene declares no commands, and the run declared no input actions. Nothing was tested — this is not a pass. Check that the game is actually running and that its controls are on screen, or pass monkey.actions with the keys the game reads.';

export interface NormalizedMonkeySpec {
  seed: number;
  actions: string[];
  everyFrames: number;
  holdFrames: number;
  maxActions: number;
  invariants: MonkeyInvariantOptions;
}

/**
 * Validate a `monkey:` block from a tool call. Written here, next to the thing it
 * configures, for the same reason `parseAssertion` lives next to the predicates.
 */
export function parseMonkeySpec(raw: unknown): { spec: NormalizedMonkeySpec } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `"monkey" must be an object like {seed: 42, actions: ['Key_ArrowLeft']}.` };
  }
  const record = raw as Record<string, unknown>;
  const seed = record.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0) {
    return {
      error: `"monkey.seed" is required and must be a non-negative integer. A monkey run without a seed cannot be reproduced, so a finding from it cannot be acted on — pick any number and keep it in the bug report.`,
    };
  }
  const actions = record.actions;
  if (
    actions !== undefined &&
    (!Array.isArray(actions) || actions.some(name => typeof name !== 'string' || !name.length))
  ) {
    return {
      error: `"monkey.actions" must be an array of input action names, e.g. ['Key_ArrowLeft', 'Action_Primary'].`,
    };
  }
  for (const field of ['everyFrames', 'holdFrames', 'maxActions'] as const) {
    const value = record[field];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    ) {
      return { error: `"monkey.${field}" must be an integer >= 1.` };
    }
  }
  const invariants = record.invariants;
  if (
    invariants !== undefined &&
    (typeof invariants !== 'object' || invariants === null || Array.isArray(invariants))
  ) {
    return {
      error: `"monkey.invariants" must be an object, e.g. {boundsRadius: 500, scorePath: false}.`,
    };
  }
  return {
    spec: {
      seed,
      actions: (actions as string[] | undefined) ?? [],
      everyFrames: (record.everyFrames as number | undefined) ?? DEFAULT_EVERY_FRAMES,
      holdFrames: (record.holdFrames as number | undefined) ?? DEFAULT_HOLD_FRAMES,
      maxActions: (record.maxActions as number | undefined) ?? DEFAULT_MAX_ACTIONS,
      invariants: (invariants as MonkeyInvariantOptions | undefined) ?? {},
    },
  };
}

export interface MonkeyReport {
  /** Always present: the run is worthless without it (rule 1). */
  seed: number;
  /** Actions dispatched. */
  actions: number;
  /** Actions the control refused (disabled, unknown interaction, …). */
  refused: number;
  /** Count per action kind, e.g. `{interaction: 14, command: 3}`. */
  byKind: Record<string, number>;
  /** The press log, oldest first; the middle is dropped when it grows. */
  log: string[];
  logTruncated?: boolean;
  /**
   * The last few presses before the run ended — the reproduction hint. Repeated
   * out of `log` on purpose: this is the line a human reads after a crash, and
   * making them scroll a capped log for it is how findings get dropped.
   */
  lastActions: string[];
  violation?: MonkeyViolation;
  /** Set when the run could not test anything at all ({@link MONKEY_EMPTY_NOTE}). */
  note?: string;
}

/**
 * The monkey itself: decides, logs, and reports. It never executes anything —
 * the loop does that and reports back with {@link log}.
 */
export class MonkeyDriver {
  private readonly random: () => number;
  private readonly head: MonkeyLogEntry[] = [];
  private readonly tail: MonkeyLogEntry[] = [];
  private dropped = 0;
  private sent = 0;
  private refused = 0;
  private readonly byKind = new Map<string, number>();
  private sawInventory = false;

  constructor(private readonly spec: NormalizedMonkeySpec) {
    this.random = makeSeededRandom(spec.seed);
  }

  /** How many actions have been dispatched — the stall invariant needs it. */
  get actionsSent(): number {
    return this.sent;
  }

  /** Is this frame a decision point? */
  shouldAct(frame: number): boolean {
    if (this.sent >= this.spec.maxActions) return false;
    return frame > 0 && frame % this.spec.everyFrames === 0;
  }

  /**
   * Pick the next action from the inventory **as it is right now**.
   *
   * Re-reading the inventory each time is what lets the monkey follow the game
   * into a menu or a game-over screen; the price is that reproducibility depends
   * on the game being deterministic too, which is exactly why the log — not the
   * seed alone — is the reproduction artefact.
   *
   * The choice is category-first (control / command / declared action) and then
   * uniform inside the category: a scene with thirty buttons and two keys would
   * otherwise press a key roughly never, and the keys are where the gameplay is.
   */
  decide(inventory: MonkeyInventory): MonkeyAction | null {
    const controls = usableControls(inventory.controls);
    const commands = inventory.commands.filter(name => name.length > 0);
    const actions = [...new Set([...this.spec.actions, ...inventory.actions])].filter(
      name => name.length > 0
    );
    if (controls.length || commands.length || actions.length) this.sawInventory = true;

    const categories: Array<() => MonkeyAction | null> = [];
    if (controls.length) categories.push(() => this.pickInteraction(controls));
    if (commands.length) {
      categories.push(() => ({ kind: 'command', name: this.pick(commands) }));
    }
    if (actions.length) {
      categories.push(() => ({
        kind: 'action',
        name: this.pick(actions),
        frames: this.spec.holdFrames,
      }));
    }
    if (categories.length === 0) return null;
    // One draw for the category and one inside it, always in this order, so the
    // stream stays aligned when a category appears or disappears mid-run.
    return this.pick(categories)();
  }

  private pickInteraction(controls: readonly LiveControlEntry[]): MonkeyAction | null {
    const control = this.pick(controls);
    const interactions = control.interactions.filter(entry => this.canInvoke(entry));
    if (interactions.length === 0) return null;
    const interaction = this.pick(interactions);
    const args = this.buildArgs(interaction);
    if (args === null) return null;
    return {
      kind: 'interaction',
      node: control.name,
      interaction: interaction.name,
      ...(Object.keys(args).length ? { args } : {}),
    };
  }

  /** An interaction is usable only if every required argument can be given a value. */
  private canInvoke(interaction: ControlInteraction): boolean {
    return (interaction.args ?? []).every(arg => !arg.required || canValue(arg));
  }

  /**
   * Values come from the argument's **declared** vocabulary — its options, its
   * min/max, its default. The monkey never invents a value for a type it has no
   * vocabulary for: a random string in a field expecting an item id produces a
   * failure that says more about the monkey than about the game.
   */
  private buildArgs(interaction: ControlInteraction): Record<string, Json> | null {
    const args: Record<string, Json> = {};
    for (const arg of interaction.args ?? []) {
      const value = this.valueFor(arg);
      if (value === undefined) {
        if (arg.required) return null;
        continue;
      }
      args[arg.name] = value;
    }
    return args;
  }

  private valueFor(arg: ControlInteractionArg): Json | undefined {
    if (arg.options && arg.options.length) return this.pick(arg.options);
    if (arg.type === 'number') {
      const min = typeof arg.min === 'number' ? arg.min : -1;
      const max = typeof arg.max === 'number' ? arg.max : 1;
      return round3(min + this.random() * (max - min));
    }
    if (arg.type === 'boolean') return this.random() < 0.5;
    return arg.defaultValue;
  }

  private pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.random() * items.length))];
  }

  /** Record what the loop did with an action. */
  log(
    frame: number,
    action: MonkeyAction,
    status: MonkeyLogEntry['status'] = 'sent',
    note?: string
  ): void {
    if (status === 'sent') {
      this.sent += 1;
      this.byKind.set(action.kind, (this.byKind.get(action.kind) ?? 0) + 1);
    } else {
      this.refused += 1;
    }
    const entry: MonkeyLogEntry = { frame, action, status, ...(note ? { note } : {}) };
    if (this.head.length < MAX_LOG_HEAD) {
      this.head.push(entry);
      return;
    }
    this.tail.push(entry);
    if (this.tail.length > MAX_LOG_TAIL) {
      this.tail.shift();
      this.dropped += 1;
    }
  }

  report(): MonkeyReport {
    const kept = [...this.head, ...this.tail];
    const lines = kept.map(formatLogEntry);
    if (this.dropped > 0) {
      lines.splice(this.head.length, 0, `… ${this.dropped} action(s) not shown …`);
    }
    return {
      seed: this.spec.seed,
      actions: this.sent,
      refused: this.refused,
      byKind: Object.fromEntries(this.byKind),
      log: lines,
      ...(this.dropped > 0 ? { logTruncated: true } : {}),
      lastActions: kept.slice(-REPRO_TAIL).map(formatLogEntry),
      ...(this.sawInventory ? {} : { note: MONKEY_EMPTY_NOTE }),
    };
  }
}

/**
 * Only controls a finger could actually reach. A disabled or off-screen control
 * would swallow decisions and make the run look busier than it is; the listing
 * already decided reachability, and re-deciding it here would be a second
 * opinion nobody asked for.
 */
export function usableControls(controls: readonly LiveControlEntry[]): LiveControlEntry[] {
  return controls.filter(
    control =>
      control.enabled !== false &&
      control.visible !== false &&
      control.hiddenByAncestor === undefined &&
      control.reach !== 'off-screen' &&
      control.reach !== 'hidden' &&
      control.reach !== 'hidden-by-ancestor' &&
      control.interactions.length > 0
  );
}

/** `f12 click RetryButton` — short enough to scan, complete enough to replay. */
export function formatLogEntry(entry: MonkeyLogEntry): string {
  const suffix =
    entry.status === 'sent' ? '' : ` [${entry.status}${entry.note ? `: ${entry.note}` : ''}]`;
  return `f${entry.frame} ${describeMonkeyAction(entry.action)}${suffix}`;
}

export function describeMonkeyAction(action: MonkeyAction): string {
  switch (action.kind) {
    case 'interaction': {
      const args =
        action.args && Object.keys(action.args).length ? ` ${formatJson(action.args as Json)}` : '';
      return `${action.interaction} ${action.node}${args}`;
    }
    case 'command':
      return `command ${action.name}`;
    case 'action':
      return `hold ${action.name} ×${action.frames}f`;
    default:
      return 'unknown action';
  }
}

const canValue = (arg: ControlInteractionArg): boolean =>
  (arg.options?.length ?? 0) > 0 ||
  arg.type === 'number' ||
  arg.type === 'boolean' ||
  arg.defaultValue !== undefined;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
