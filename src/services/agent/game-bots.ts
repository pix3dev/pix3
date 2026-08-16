/**
 * Bot policies — the fourth actuation layer of `.plans/done/agent-gameplay-testing.md`
 * (§5.3, phase 8): a short program, stored in the project, that *plays* the game
 * while the harness watches.
 *
 * The three layers below it all share one shape — the agent decides, one call at a
 * time, and every decision costs a round trip. That is fine for "open the shop and
 * buy slot 2" and hopeless for "survive thirty seconds of a runner": the decisions
 * a runner needs arrive every few frames, and a tool call per decision is both too
 * slow and too coarse. A policy moves the decision loop *inside* the frame loop, so
 * a thousand decisions cost one tool call.
 *
 * ## What a policy is
 *
 * A module in `design/tests/bots/<name>.ts` exporting an object with a `tick`:
 *
 * ```ts
 * export default {
 *   name: 'dodge-and-survive',
 *   start(bot) { bot.log('looking for the hero'); },
 *   tick(bot) {
 *     const hero = bot.nodes('Hero')[0];
 *     if (!hero) return bot.done(false, 'the hero is gone');
 *     const rock = bot.nearest('Rock2D', hero.worldPosition);
 *     if (rock && rock.worldPosition.x < hero.worldPosition.x) bot.axis('Horizontal', 1);
 *     else bot.axis('Horizontal', -1);
 *     if (bot.frame > 1800) bot.done(true, 'survived 30s');
 *   },
 * };
 * ```
 *
 * It lives in the project — not in the conversation — for the reason every other
 * artifact of this harness does (principle 5 of Flow): it survives context
 * compaction, it is reviewed and committed like code, and the next session reuses it
 * as a regression instead of re-deriving it.
 *
 * ## The timing contract, and why it is the first thing to state
 *
 * The policy is ticked from the runner's **frame listener** — the hook that fires
 * once per logic tick, after the tick's node updates and its render. That is a
 * hook the harness already uses (`NodeWatchRecorder`), so no new runtime seam is
 * needed, and it holds in every time mode: realtime, `fixed` (accelerated) and the
 * `manual` stepping `game_run` drives.
 *
 * Two consequences, and a policy that assumes otherwise will look flaky rather than
 * wrong:
 *
 * - **Sensors read a settled frame.** Everything the tick did has happened; nothing
 *   of the next tick has.
 * - **Actuators land on the NEXT tick, always.** Synthesized DOM events queue into
 *   `InputService`'s pending buffers and are swapped in by the next `beginFrame()`;
 *   direct `setAxis`/`setButton` writes are immediate but no game node reads them
 *   again until the next tick either. So the loop is strictly "observe frame N, act
 *   for frame N+1" — the same one-frame lag a human player has, and the reason this
 *   hook was chosen over ticking as a script component, where the lag would instead
 *   depend on where in the scene tree the component happened to sit.
 *
 * ## The channel ladder still applies (§5, invariant 5)
 *
 * A policy actuates on exactly one channel per run, named in the report:
 *
 * - `physical-input` (**the default**) — synthesized pointer and key events, i.e.
 *   the whole player path. A key press is a real `keydown`; a tap is a real pointer
 *   landing on the control's own bounds; an axis is the on-screen joystick actually
 *   being deflected.
 * - `direct-action` — `setAxis`/`setButton` on the live input service, semantic
 *   interactions, registered commands. It exercises game *logic* and proves nothing
 *   about a binding.
 *
 * A run on `direct-action` therefore **cannot close an input check**, and both the
 * report and the verdict line say so out loud. This is not a formality: the whole
 * value of the ladder is that each rung is proven by the rung below it exactly once,
 * and a policy is the layer where "just set the axis, it's easier" is most tempting.
 *
 * ## Rules the report obeys
 *
 * 1. **A refused actuator is neither silent nor fatal.** It cannot throw — that
 *    would kill a policy for asking a reasonable question — and it cannot be
 *    dropped, because a policy driving a misspelled node name would otherwise read
 *    as a game that ignores input. It becomes a log line with the reason.
 * 2. **A bot that drove nothing is not a pass.** Same rule as `monkey-empty`, same
 *    reason: "the budget elapsed and nothing broke" is exactly what a clean run
 *    looks like, and nothing in it says whether a single button was pressed. A
 *    *finding* (`done(false)`) still stands — a policy that reports it could not
 *    play is a real result.
 * 3. **A crashed policy is not a failed game.** The error is reported on its own
 *    channel (`componentType: 'test:bot'`) and ends the run as `bot-error`, whose
 *    verdict names the policy file. Reading "the game failed" off a typo in a test
 *    would be the worst possible outcome of adding this layer.
 */

import type { Json } from '@/core/agent-introspection';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Where policies live in a project. Mirrored by the `design/tests/` skeleton. */
export const BOT_DIRECTORY = 'design/tests/bots';

export const BOT_FILE_SUFFIX = '.ts';

/** Accepts a bare name (`dodge`) or a full path, and answers the full path. */
export function botFilePath(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes('/')) {
    return trimmed.endsWith(BOT_FILE_SUFFIX) ? trimmed : `${trimmed}${BOT_FILE_SUFFIX}`;
  }
  const bare = trimmed.endsWith(BOT_FILE_SUFFIX)
    ? trimmed.slice(0, -BOT_FILE_SUFFIX.length)
    : trimmed;
  return `${BOT_DIRECTORY}/${bare}${BOT_FILE_SUFFIX}`;
}

/** `design/tests/bots/dodge.ts` → `dodge`. */
export function botNameFromPath(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.endsWith(BOT_FILE_SUFFIX) ? file.slice(0, -BOT_FILE_SUFFIX.length) : file;
}

/** One stored policy, as text. Compilation happens in the host. */
export interface StoredBot {
  name: string;
  path: string;
  source: string;
}

/**
 * The storage seam, same shape and the same reasons as {@link
 * import('./game-routines').RoutineStore}: the tool layer decides whether it is the
 * open project's files (`ProjectBotStore`) or memory, and the driver never knows.
 *
 * Unlike a routine a policy is **not parsed here** — it is TypeScript, and the only
 * thing that can tell whether it is valid is the compiler. A store that tried would
 * be a second, worse parser.
 */
export interface BotStore {
  /** `null` when there is no such policy — not an error; the caller lists what exists. */
  load(name: string): Promise<StoredBot | null>;
  /** Every stored policy. */
  list(): Promise<StoredBot[]>;
}

/** In-memory store: the default, and what the specs run against. */
export class InMemoryBotStore implements BotStore {
  private readonly byPath = new Map<string, StoredBot>();

  put(name: string, source: string): void {
    const path = botFilePath(name);
    this.byPath.set(path, { name: botNameFromPath(path), path, source });
  }

  async load(name: string): Promise<StoredBot | null> {
    return this.byPath.get(botFilePath(name)) ?? null;
  }

  async list(): Promise<StoredBot[]> {
    return [...this.byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

// ---------------------------------------------------------------------------
// The policy-facing contract
// ---------------------------------------------------------------------------

/** Which rung of the ladder a policy's actuators use. Named in every report. */
export type BotActuatorChannel = 'physical-input' | 'direct-action';

export const BOT_ACTUATOR_CHANNELS: readonly BotActuatorChannel[] = [
  'physical-input',
  'direct-action',
];

export const DEFAULT_BOT_CHANNEL: BotActuatorChannel = 'physical-input';

export interface BotPoint {
  x: number;
  y: number;
  z?: number;
}

/** The `bot` block of a `game_run` spec, after validation. */
export interface NormalizedBotSpec {
  name: string;
  channel: BotActuatorChannel;
}

/**
 * Validate the `bot` block of a tool payload.
 *
 * The channel defaults to `physical-input` rather than being required, and that
 * default is the load-bearing part: a caller who does not think about the channel
 * gets the rung that proves the most, and has to ask explicitly for the one that
 * proves less. An unknown channel is refused with both names — silently falling back
 * to the default would hand back a run whose report says `physical-input` for a
 * caller who typed `direct` and believes otherwise.
 */
export function parseBotSpec(raw: unknown): { spec: NormalizedBotSpec } | { error: string } {
  const record =
    typeof raw === 'string'
      ? { name: raw }
      : typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
  if (!record) {
    return {
      error: `game_run \`bot\` takes {name, channel?} (or just the policy's name as a string), e.g. {bot: {name: 'dodge'}} for ${BOT_DIRECTORY}/dodge.ts.`,
    };
  }
  const unknown = Object.keys(record).filter(key => key !== 'name' && key !== 'channel');
  if (unknown.length > 0) {
    return {
      error: `game_run \`bot\` carries only {name, channel}; unknown field(s) ${unknown.map(key => `"${key}"`).join(', ')}. A policy takes no arguments — it is code, so put the variation in the file.`,
    };
  }
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!name) {
    return {
      error: `game_run \`bot.name\` must name a stored policy — the bare file name of a ${BOT_DIRECTORY}/<name>.ts.`,
    };
  }
  if (record.channel !== undefined) {
    if (!BOT_ACTUATOR_CHANNELS.includes(record.channel as BotActuatorChannel)) {
      return {
        error: `game_run \`bot.channel\` must be ${BOT_ACTUATOR_CHANNELS.map(entry => `'${entry}'`).join(' or ')} (got ${JSON.stringify(record.channel)}). 'physical-input' is the default and the only one that proves an input binding; 'direct-action' sets axes and interactions directly and proves game logic only.`,
      };
    }
  }
  return {
    spec: {
      name,
      channel: (record.channel as BotActuatorChannel | undefined) ?? DEFAULT_BOT_CHANNEL,
    },
  };
}

/**
 * What a policy sees of a live node. A deliberate subset of the harness's own
 * `LiveNodeSnapshot`: a policy decides from position, visibility and text, and
 * handing it the full record would invite decisions on fields (`control.pressed`)
 * that are the harness's evidence rather than the player's perception.
 */
export interface BotNodeView {
  nodeId: string;
  name: string;
  type: string;
  /** The node's own flag. `false` means it is not on screen and cannot be tapped. */
  visible: boolean;
  position: { x: number; y: number; z: number };
  worldPosition: { x: number; y: number; z: number };
  /** The text the node renders, for nodes that render one. */
  text?: string;
}

/** One raycast hit: the node the ray struck first and how far away it was. */
export interface BotHit {
  node: BotNodeView;
  distance: number;
  point: { x: number; y: number; z: number };
}

/**
 * The ~10 methods a policy is written against. Everything a policy can know and
 * everything it can do is here; there is no escape hatch to the runtime, on
 * purpose — a policy that reached into a node and called its handler would prove
 * nothing about the wire between the player and the effect, which is the one thing
 * this harness exists to prove.
 */
export interface Pix3TestBot {
  /** Ticks the policy has been ticked for. 1 on the first tick. */
  readonly frame: number;

  // -- sensors ---------------------------------------------------------------

  /**
   * Live nodes answering `query` — a node name, a node id, or a node type
   * (`'Sprite2D'`). Ordered as the scene tree walks them, capped.
   */
  nodes(query: string): BotNodeView[];
  /**
   * The nearest live node of `type` to `from`, or `null`.
   *
   * `from` defaults to the world origin because the harness does not know which
   * node is "you" — pass the position you are actually measuring from.
   */
  nearest(type: string, from?: BotPoint): BotHit | null;
  /** First live node struck by a ray, or `null`. `dir` need not be normalised. */
  raycast(from: BotPoint, dir: BotPoint): BotHit | null;
  /** The game's own `GameDebugProvider` snapshot, or `null` when it registered none. */
  gameState(): Json | null;

  // -- actuators -------------------------------------------------------------

  /**
   * Hold an input action: a key (`'Key_ArrowLeft'`, or the bare code
   * `'ArrowLeft'`) or a named button (`'Action_Primary'`). With `frames` it is
   * released automatically after that many ticks; without, it stays down until
   * {@link release}.
   */
  press(action: string, frames?: number): void;
  /** Let go of an action held by {@link press}. */
  release(action: string): void;
  /**
   * Tap a control by node name/id: pointer down now, up a few ticks later — a
   * control needs a tick with the pointer down before it registers the press, so
   * an instant down-up pair is not a tap at all.
   */
  tap(target: string): void;
  /**
   * Steer an input axis to `value` (clamped to -1..1).
   *
   * On `physical-input` this deflects the live on-screen joystick that writes the
   * axis, which is what makes "the stick moves the hero" a proven statement. When
   * no joystick writes it, the call is refused with that sentence rather than
   * quietly falling through to a direct write.
   */
  axis(name: string, value: number): void;
  /** Point the pointer at a world position (aim, hover, click-to-move targeting). */
  moveTo(point: BotPoint): void;

  // -- protocol --------------------------------------------------------------

  /** One line in the report. This is how a policy explains its own reasoning. */
  log(event: string): void;
  /**
   * End the run with the policy's own verdict, and say why in words a reader can
   * act on ("hero died: lives 0 at the third gap"). The first call wins; later
   * ones are noted and ignored.
   */
  done(pass: boolean, reason: string): void;
}

/** The object a policy module exports. `tick` is the only required member. */
export interface BotPolicy {
  /** Optional label for the report; the file name is used when absent. */
  name?: string;
  /** Run once before the first tick. */
  start?(bot: Pix3TestBot): void;
  /** Run once per logic tick until the policy calls `done` or the budget ends. */
  tick(bot: Pix3TestBot): void;
  /** Run once after the last tick, whatever ended the run. */
  end?(bot: Pix3TestBot): void;
}

/**
 * Pull the policy out of a compiled module namespace.
 *
 * Three export spellings are accepted (`default`, `policy`, `bot`) because a model
 * writing the file from memory reaches for all three, and refusing two of them
 * would spend a turn on a rename that changes nothing. What is *not* accepted is a
 * module with no `tick`: that is the one mistake whose symptom would otherwise be a
 * silent 600-frame run of a game nobody played.
 */
export function resolveBotPolicy(namespace: unknown): { policy: BotPolicy } | { error: string } {
  if (typeof namespace !== 'object' || namespace === null) {
    return { error: 'the compiled policy module exported nothing usable.' };
  }
  const record = namespace as Record<string, unknown>;
  const candidate = record.default ?? record.policy ?? record.bot;
  if (typeof candidate !== 'object' || candidate === null) {
    return {
      error:
        'a policy file must export the policy object — `export default { name, tick(bot) { … } }` (a named `policy` or `bot` export works too). Nothing of that shape was exported.',
    };
  }
  const policy = candidate as Partial<BotPolicy>;
  if (typeof policy.tick !== 'function') {
    return {
      error:
        'the exported policy has no `tick(bot)` function, so nothing would ever be decided. `tick` is called once per logic tick; put the decision there.',
    };
  }
  for (const hook of ['start', 'end'] as const) {
    if (policy[hook] !== undefined && typeof policy[hook] !== 'function') {
      return { error: `the exported policy's \`${hook}\` is not a function.` };
    }
  }
  return { policy: policy as BotPolicy };
}

// ---------------------------------------------------------------------------
// The world seam
// ---------------------------------------------------------------------------

/**
 * Everything a session needs from the live editor, injected so the driver is
 * testable without a scene, a renderer or DI — the same split `runGameTestLoop` and
 * the routine driver use.
 *
 * **Every actuator answers `null` on delivery or a sentence on refusal.** Not a
 * boolean: a refusal that cannot say why is the silence this whole harness exists to
 * remove, and the sentence is what ends up in the log the agent reads.
 */
export interface BotWorld {
  /** The rung this world actuates on. Fixed for the run and named in the report. */
  readonly channel: BotActuatorChannel;

  findNodes(query: string, max: number): BotNodeView[];
  nearestOfType(type: string, from: BotPoint): BotHit | null;
  raycast(from: BotPoint, dir: BotPoint): BotHit | null;
  gameState(): Json | null;

  pressAction(action: string): string | null;
  releaseAction(action: string): string | null;
  /** Put the pointer down on a control. The session schedules the matching release. */
  tapDown(target: string): string | null;
  /** Complete the tap started by {@link tapDown}. Never refuses — the press already happened. */
  tapUp(target: string): void;
  setAxisValue(name: string, value: number): string | null;
  pointAt(point: BotPoint): string | null;
  /** Drop everything still held. Called once, from the session's teardown. */
  releaseAll(): void;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type BotLogKind = 'policy' | 'refused' | 'harness';

export interface BotLogEntry {
  frame: number;
  kind: BotLogKind;
  message: string;
}

export interface BotReport {
  /** The policy as addressed — the file's bare name. */
  name: string;
  /** The policy's own label, when it declared one different from the file name. */
  label?: string;
  channel: BotActuatorChannel;
  /** Ticks the policy was ticked for. */
  frames: number;
  /** Actuator calls delivered, and calls the world refused. */
  sent: number;
  refused: number;
  /** The policy's verdict, when it reached one. */
  done?: { pass: boolean; reason: string; frame: number };
  /** Set when the policy threw. The run ends as `bot-error`, not as a game failure. */
  error?: { message: string; stack?: string; frame: number };
  log: BotLogEntry[];
  /** Log lines dropped between the kept head and tail. */
  logTruncated?: number;
  /** Caveats about the BOT, never about the game. */
  notes: string[];
}

/** Head and tail kept in the reply. The artifact keeps the whole log. */
const LOG_HEAD = 20;
const LOG_TAIL = 40;
/** Hard cap on lines held in memory, so a per-frame `log()` cannot grow unbounded. */
const LOG_LIMIT = 4000;
/** Live nodes one `nodes()` call may answer with. Evidence, not an inventory. */
const MAX_SENSED_NODES = 64;

/**
 * Ticks between a bot's pointer-down and its pointer-up.
 *
 * Three, not one: the down event is queued during tick N and delivered by the next
 * `beginFrame`, so the control first sees it on N+1 and can only see the up as a
 * separate event on N+2. A one-tick tap is a press the control never had a frame to
 * notice, which reads exactly like a dead button.
 */
export const DEFAULT_TAP_HOLD_FRAMES = 3;

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/**
 * One policy bound to one run.
 *
 * It owns the four things a frame loop needs from a policy and nothing else: the
 * `Pix3TestBot` the policy is handed, the frame-denominated release schedule for
 * whatever it is holding, the log, and the verdict. Every decision is the policy's,
 * every delivery is the world's, and the *ordering* between them is this class's.
 *
 * Held actions are released on a **frame** schedule rather than a timer for the same
 * reason the rest of the harness is frame-denominated: in `manual` time a
 * wall-clock release may never happen at all, and a key stuck down for the rest of
 * the run would be blamed on the game.
 */
export class BotSession {
  private readonly bot: Pix3TestBot;
  private readonly log: BotLogEntry[] = [];
  private logDropped = 0;
  private readonly notes: string[] = [];

  private currentFrame = 0;
  private sent = 0;
  private refused = 0;
  private started = false;
  private ended = false;
  /** True while `dispose()` runs — see {@link doDone} for why it is not `ended`. */
  private tearingDown = false;

  private verdict: { pass: boolean; reason: string; frame: number } | null = null;
  private failure: { message: string; stack?: string; frame: number } | null = null;

  /** Actions held by `press`, and the frame each is due to be released on (if any). */
  private readonly heldActions = new Map<string, number | null>();
  /** Taps in flight: target → the frame its pointer-up is due on. */
  private readonly openTaps = new Map<string, number>();

  constructor(
    private readonly name: string,
    private readonly policy: BotPolicy,
    private readonly world: BotWorld,
    /** Where a policy's throw is reported, on its own channel. */
    private readonly onError?: (error: { message: string; stack?: string }) => void
  ) {
    this.bot = this.buildBot();
    if (world.channel === 'direct-action') {
      this.notes.push(
        "This run actuated on `direct-action`: axes, interactions and commands were set directly on the running game. It exercises the game LOGIC and proves NOTHING about the player's input path — a control that is not wired to anything passes a direct-action run. Re-run on `physical-input` to close an input check."
      );
    }
  }

  /** True once the policy has reached a verdict, crashed, or been torn down. */
  get finished(): boolean {
    return this.ended || this.verdict !== null || this.failure !== null;
  }

  /** The policy's verdict, or null while it has not reached one. */
  get outcome(): { pass: boolean; reason: string; frame: number } | null {
    return this.verdict;
  }

  /** The policy's crash, or null. Distinct from {@link outcome} on purpose. */
  get crash(): { message: string; stack?: string; frame: number } | null {
    return this.failure;
  }

  /** Actuator calls the world accepted. Zero means nothing was driven — see rule 2. */
  get actionsSent(): number {
    return this.sent;
  }

  /**
   * Advance the policy by one logic tick. Called from the runner's frame hook, so
   * it is synchronous and it must never throw: a throw here would propagate into
   * the runner's tick and take the game down with the test.
   */
  tick(): void {
    if (this.finished) return;
    this.currentFrame += 1;
    this.releaseDue();
    if (!this.started) {
      this.started = true;
      if (!this.runHook('start')) return;
    }
    this.guard(() => this.policy.tick(this.bot));
  }

  /**
   * Close the session: run `end`, then let go of everything still held.
   *
   * The release comes last and always happens, including after a crash. A policy
   * that died holding the fire button would otherwise leave the game being driven
   * by a dead test — and, with `pauseOnOutcome`, leave the caller inspecting a frame
   * whose input state is the harness's rather than the game's.
   */
  dispose(): void {
    if (!this.ended) {
      this.ended = true;
      this.tearingDown = true;
      if (this.started) this.runHook('end');
      this.tearingDown = false;
    }
    this.heldActions.clear();
    this.openTaps.clear();
    this.world.releaseAll();
  }

  /**
   * The log with no head+tail window applied — everything the policy said.
   *
   * Separate from {@link report} because the two have different readers: the reply
   * has a context budget and the artifact file has none, and for a policy that logs
   * its decision every frame the lines the reply drops are precisely the ones a late
   * failure was decided in. (The `LOG_LIMIT` ceiling still applies: it is a
   * memory guard, not a presentation cap, and `logTruncated` reports it.)
   */
  fullLog(): readonly BotLogEntry[] {
    return this.log;
  }

  report(): BotReport {
    const label = this.policy.name?.trim();
    return {
      name: this.name,
      ...(label && label !== this.name ? { label } : {}),
      channel: this.world.channel,
      frames: this.currentFrame,
      sent: this.sent,
      refused: this.refused,
      ...(this.verdict ? { done: this.verdict } : {}),
      ...(this.failure ? { error: this.failure } : {}),
      log: this.cappedLog(),
      ...(this.logDropped > 0 ? { logTruncated: this.logDropped } : {}),
      notes: this.buildNotes(),
    };
  }

  // -- the contract ----------------------------------------------------------

  private buildBot(): Pix3TestBot {
    // `frame` is a live getter, not a copied number: a policy reads `bot.frame` in the
    // middle of its own tick, and a value captured when the object was built would be 1
    // forever. Read through a closure rather than an object-literal getter over an
    // aliased `this`, which is the same thing spelled less safely.
    const frame = (): number => this.currentFrame;
    return {
      get frame() {
        return frame();
      },
      nodes: query => this.sense(() => this.world.findNodes(query, MAX_SENSED_NODES), []),
      nearest: (type, from) =>
        this.sense(() => this.world.nearestOfType(type, from ?? { x: 0, y: 0, z: 0 }), null),
      raycast: (from, dir) => this.sense(() => this.world.raycast(from, dir), null),
      gameState: () => this.sense(() => this.world.gameState(), null),
      press: (action, frames) => this.doPress(action, frames),
      release: action => this.doRelease(action),
      tap: target => this.doTap(target),
      axis: (name, value) => this.doAxis(name, value),
      moveTo: point => this.doMoveTo(point),
      log: event => this.record('policy', String(event)),
      done: (pass, reason) => this.doDone(pass, reason),
    };
  }

  /**
   * A sensor that throws is the harness's problem, not the policy's, so it answers
   * the empty reading and says so once rather than propagating into `tick` and
   * being reported as a policy crash.
   */
  private sense<T>(read: () => T, fallback: T): T {
    try {
      return read();
    } catch (error) {
      this.record('harness', `a sensor failed: ${describeError(error)}`);
      return fallback;
    }
  }

  private doPress(action: string, frames?: number): void {
    const name = String(action ?? '').trim();
    if (!name) return this.refuse('press() needs an action name, e.g. press("Key_ArrowLeft").');
    const dueAt =
      typeof frames === 'number' && Number.isFinite(frames) && frames > 0
        ? this.currentFrame + Math.round(frames)
        : null;
    // Re-pressing something already held only extends its lease. Dispatching a
    // second keydown would be harmless for a polled button and misleading in the
    // log, which is where a reader counts what the policy did.
    if (this.heldActions.has(name)) {
      this.heldActions.set(name, dueAt);
      return;
    }
    const refusal = this.world.pressAction(name);
    if (refusal) return this.refuse(refusal);
    this.heldActions.set(name, dueAt);
    this.sent += 1;
  }

  private doRelease(action: string): void {
    const name = String(action ?? '').trim();
    if (!this.heldActions.has(name)) {
      // Not a refusal: releasing something that is not held is a no-op in every
      // input API, and logging it as an error would bury the real refusals.
      return;
    }
    this.heldActions.delete(name);
    const refusal = this.world.releaseAction(name);
    if (refusal) this.refuse(refusal);
  }

  private doTap(target: string): void {
    const name = String(target ?? '').trim();
    if (!name) return this.refuse('tap() needs a node name or id, e.g. tap("PlayButton").');
    if (this.openTaps.has(name)) return; // already down; the schedule owns the release
    const refusal = this.world.tapDown(name);
    if (refusal) return this.refuse(refusal);
    this.openTaps.set(name, this.currentFrame + DEFAULT_TAP_HOLD_FRAMES);
    this.sent += 1;
  }

  private doAxis(name: string, value: number): void {
    const axis = String(name ?? '').trim();
    if (!axis) return this.refuse('axis() needs an axis name, e.g. axis("Horizontal", -1).');
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return this.refuse(`axis("${axis}") needs a finite value in -1..1.`);
    }
    const refusal = this.world.setAxisValue(axis, Math.max(-1, Math.min(1, value)));
    if (refusal) return this.refuse(refusal);
    this.sent += 1;
  }

  private doMoveTo(point: BotPoint): void {
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
      return this.refuse('moveTo() needs a world point {x, y}.');
    }
    const refusal = this.world.pointAt(point);
    if (refusal) return this.refuse(refusal);
    this.sent += 1;
  }

  private doDone(pass: boolean, reason: string): void {
    const said = String(reason ?? '').trim();
    // A verdict from the `end` hook arrives after the run has already ended, so it
    // cannot be what decided the outcome. Recording it anyway would leave a report
    // whose `done` contradicts its own `outcome.kind`, and a reader would have no way
    // to tell which of the two to believe.
    if (this.tearingDown) {
      this.record(
        'harness',
        `done(${pass ? 'pass' : 'fail'}) was called from end() and ignored — by then the run had already ended, so this verdict decided nothing. Call done() from tick().`
      );
      return;
    }
    if (this.verdict) {
      this.record(
        'harness',
        `done() was called again (${pass ? 'pass' : 'fail'}: ${said || 'no reason given'}) and ignored — the first verdict is the one the policy meant.`
      );
      return;
    }
    this.verdict = {
      pass: pass === true,
      reason: said || '(the policy gave no reason)',
      frame: this.currentFrame,
    };
    this.record('policy', `done(${pass ? 'pass' : 'fail'}): ${this.verdict.reason}`);
  }

  // -- scheduling ------------------------------------------------------------

  private releaseDue(): void {
    for (const [action, dueAt] of [...this.heldActions]) {
      if (dueAt !== null && dueAt <= this.currentFrame) {
        this.heldActions.delete(action);
        const refusal = this.world.releaseAction(action);
        if (refusal) this.refuse(refusal);
      }
    }
    for (const [target, dueAt] of [...this.openTaps]) {
      if (dueAt <= this.currentFrame) {
        this.openTaps.delete(target);
        this.world.tapUp(target);
      }
    }
  }

  // -- policy isolation ------------------------------------------------------

  /**
   * Run one policy hook behind a hard boundary.
   *
   * The FIRST throw ends the policy. Not the third, not a rate limit: a policy that
   * threw once will almost always throw every frame, and 600 identical stacks would
   * bury the one line that matters. The run ends as `bot-error`, whose verdict names
   * the file — "the game failed" read off a typo in a test would be the worst thing
   * this layer could produce.
   */
  private guard(run: () => void): boolean {
    try {
      run();
      return true;
    } catch (error) {
      const { message, stack } = describeThrown(error);
      this.failure = { message, stack, frame: this.currentFrame };
      this.record('harness', `the policy threw: ${message}`);
      this.onError?.({ message, ...(stack ? { stack } : {}) });
      return false;
    }
  }

  private runHook(hook: 'start' | 'end'): boolean {
    const fn = this.policy[hook];
    if (typeof fn !== 'function') return true;
    return this.guard(() => fn.call(this.policy, this.bot));
  }

  // -- log -------------------------------------------------------------------

  private refuse(reason: string): void {
    this.refused += 1;
    this.record('refused', reason);
  }

  private record(kind: BotLogKind, message: string): void {
    if (this.log.length >= LOG_LIMIT) {
      this.logDropped += 1;
      return;
    }
    this.log.push({ frame: this.currentFrame, kind, message });
  }

  /** Head + tail, so the first decisions and the last ones both survive the cap. */
  private cappedLog(): BotLogEntry[] {
    if (this.log.length <= LOG_HEAD + LOG_TAIL) return [...this.log];
    return [...this.log.slice(0, LOG_HEAD), ...this.log.slice(-LOG_TAIL)];
  }

  private droppedInReply(): number {
    const middle = this.log.length - (LOG_HEAD + LOG_TAIL);
    return this.logDropped + Math.max(0, middle);
  }

  private buildNotes(): string[] {
    const notes = [...this.notes];
    if (this.refused > 0 && this.sent === 0) {
      notes.push(
        `Every one of the ${this.refused} actuator call(s) this policy made was refused, so the game ran untouched. Read the refusals in \`log\` — they name what could not be reached — rather than the outcome, which describes a game nobody played.`
      );
    } else if (this.refused > 0) {
      notes.push(
        `${this.refused} actuator call(s) were refused (of ${this.sent + this.refused}); the reasons are in \`log\`.`
      );
    }
    const dropped = this.droppedInReply();
    if (dropped > 0) {
      notes.push(
        `${dropped} log line(s) are not in this reply (head ${LOG_HEAD} + tail ${LOG_TAIL} kept). The full log is in the run's artifact file.`
      );
    }
    return notes;
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/**
 * One line, read first, and it has to carry the three things the phase-8 criterion
 * asks for: **why** the run ended, on **which frame**, and on **which channel**.
 * The channel is not decoration — it is the difference between a proven input
 * binding and an exercised code path.
 *
 * **The branch order is the contract**, and getting it wrong was a real defect a live
 * run caught: a `done(false)` from a policy that drove nothing was printed as
 * `BOT NOTHING DRIVEN` while the outcome stayed `bot-fail`, so the headline and
 * `outcome.kind` disagreed about the same run. The order below mirrors
 * `resolveBotOutcome` exactly — a crash, then a FINDING, then idleness, then a pass —
 * because a *finding* stands whether or not anything was driven ("I could not play" is
 * a result) while a *pass* does not. Any reordering here re-opens that disagreement.
 */
export function buildBotVerdict(report: BotReport, newErrors: number): string {
  const where = `frame ${report.frames}`;
  const channel = `[${report.channel}]`;
  const drove = `${report.sent} action(s) driven${report.refused > 0 ? `, ${report.refused} refused` : ''}`;
  const errs = newErrors > 0 ? ` ${newErrors} NEW RUNTIME ERROR(S) during the run.` : '';
  const unproven =
    report.channel === 'direct-action'
      ? ' Actuated on direct-action, so no input binding is proven by this run.'
      : '';
  const idle =
    report.sent === 0
      ? ` It actuated NOTHING${report.refused > 0 ? ` (all ${report.refused} attempt(s) were refused — the reasons are in \`log\`)` : ''}, so the finding is about a game it did not manage to play.`
      : '';

  if (report.error) {
    return `BOT ERROR ${report.name} ${channel} — the POLICY threw at frame ${report.error.frame}: ${report.error.message}. This is a fault in ${botFilePath(report.name)}, NOT in the game; nothing is claimed about the game here. ${drove} before it died.${errs}`;
  }
  if (report.done && !report.done.pass) {
    return `BOT FAIL ${report.name} ${channel} — the policy ended the run at frame ${report.done.frame}: ${report.done.reason}. ${drove} over ${report.frames} tick(s).${idle}${unproven}${errs}`;
  }
  if (report.sent === 0) {
    const said = report.done
      ? ` The policy called done(pass) — "${report.done.reason}" — but it never drove anything, so the claim rests on a game it did not play.`
      : '';
    return `BOT NOTHING DRIVEN ${report.name} ${channel} — ${report.frames} tick(s) ran and the policy actuated NOTHING${report.refused > 0 ? ` (all ${report.refused} attempt(s) were refused)` : ''}.${said}${errs}`;
  }
  if (report.done) {
    return `BOT PASS ${report.name} ${channel} — the policy ended the run at frame ${report.done.frame}: ${report.done.reason}. ${drove} over ${report.frames} tick(s).${unproven}${errs}`;
  }
  return `BOT UNDECIDED ${report.name} ${channel} — the budget ran out at ${where} and the policy never called done(), so IT reached no verdict; whatever ended the run below is the harness's own budget or predicate. ${drove}.${unproven}${errs}`;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function describeThrown(thrown: unknown): { message: string; stack?: string } {
  if (thrown instanceof Error) {
    return {
      message: `${thrown.name}: ${thrown.message}`,
      ...(thrown.stack ? { stack: thrown.stack } : {}),
    };
  }
  return { message: String(thrown) };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Shared by every "no such policy" answer, so the model always sees what exists. */
export function describeAvailableBots(bots: readonly StoredBot[]): string {
  if (bots.length === 0) {
    return `No policies are stored in ${BOT_DIRECTORY}/ yet.`;
  }
  return `Stored policies: ${bots
    .map(bot => bot.name)
    .sort()
    .join(', ')}.`;
}
