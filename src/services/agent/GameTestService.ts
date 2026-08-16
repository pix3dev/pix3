import { injectable, inject } from '@/fw/di';
import { appState } from '@/state';
import { errors as capturedErrors, safeSerialize, type Json } from '@/core/agent-introspection';
import { GamePlaySessionService } from '@/services/play/GamePlaySessionService';
import {
  getGameDebug,
  isInteractive,
  reportScriptError,
  DEFAULT_FIXED_DELTA_SEC,
  NodeBase,
  type Interactive,
  type GameCommandLogEntry,
  type RuntimeTimeConfig,
  type RuntimeTimeMode,
  type ResolvedRuntimeTimeConfig,
  type SceneRunner,
} from '@pix3/runtime';
import {
  assertionAxisNames,
  assertionNodeNames,
  assertionPropertyReads,
  assertionSignalWatches,
  assertionSnapshotNames,
  assertionTypeQueries,
  assertionsNeedCommands,
  assertionsNeedGameState,
  describeAssertion,
  evaluateAssertion,
  firstMetAssertion,
  parseAssertions,
  signalWatchKey,
  type AssertionBaseline,
  type AssertionFrame,
  type CommandWindow,
  type GameAssertion,
  type SignalObservation,
  type SignalWatchSpec,
} from '@/services/agent/game-assertions';
import {
  buildTraceFromRun,
  compareTraceToRun,
  DomTraceEventSource,
  DomTraceInputSink,
  InMemoryTraceStore,
  makeTraceFeeder,
  TraceRecorder,
  traceFilePath,
  type CompareTraceOptions,
  type GameInputTrace,
  type TraceComparison,
  type TraceEnvelope,
  type TraceEvent,
  type TraceEventSource,
  type TraceInputSink,
  type TraceStore,
} from '@/services/agent/game-traces';
import {
  describeAvailableRoutines,
  InMemoryRoutineStore,
  ROUTINE_DIRECTORY,
  runRoutine,
  type GameRoutine,
  type RoutineGameSample,
  type RoutineInputStep,
  type RoutineRunResult,
  type RoutineStore,
  type RoutineWorld,
} from '@/services/agent/game-routines';
import {
  buildRunProtocolDocument,
  protocolReply,
  protocolJson,
  recordRoutineWorld,
  RunProtocolRecorder,
  saveRunProtocol,
  type ProtocolRoutineRead,
  type RunArtifactReport,
  type RunProtocolSink,
  type RunProtocolStore,
} from '@/services/agent/game-run-protocol';
import {
  installNondeterminismProbe,
  type NondeterminismProbe,
  type ProbeTarget,
} from '@/services/agent/nondeterminism-probe';
import {
  MonkeyDriver,
  MonkeyInvariantMonitor,
  parseMonkeySpec,
  usableControls,
  type MonkeyAction,
  type MonkeyInventory,
  type MonkeyLogEntry,
  type MonkeyReport,
  type NormalizedMonkeySpec,
} from '@/services/agent/game-monkey';
import {
  assessControlStrength,
  isolateForControl,
  judgeNegativeControl,
  parseNegativeControlSpec,
  type ControlInconclusiveReason,
  type ControlIsolationReport,
  type ControlRunOutcome,
  type ControlStrengthInput,
  type ControlVerdict,
  type NegativeControlSpec,
} from '@/services/agent/game-control';
import { GameInputService, type LiveNodeSnapshot } from '@/services/agent/GameInputService';
import { GameBotHost } from '@/services/agent/GameBotHost';
import {
  BotSession,
  buildBotVerdict,
  type BotActuatorChannel,
  type BotReport,
  type BotStore,
  type BotWorld,
  type NormalizedBotSpec,
  parseBotSpec,
} from '@/services/agent/game-bots';
import {
  BOT_POINTER_ID,
  collectBotNodeViews,
  nearestBotNode,
  PhysicalAxisDriver,
  projectToCanvasFraction,
  raycastBotNodes,
  type BotSceneHandle,
} from '@/services/agent/game-bot-world';
import { Vector3 } from 'three';
import { CURRENT_EDITOR_VERSION } from '@/version';

/**
 * `game_run` — drive the running game frame by frame and stop on the first
 * outcome (§5.2 of `.plans/done/agent-gameplay-testing.md`). Phase 2: the vertical
 * slice. The point is the *loop* — baseline, per-frame predicates, early exit,
 * pause on outcome, report — not a full predicate vocabulary (that is phase 6).
 *
 * Why frame-stepping rather than "wait 3 s and look": the loop owns the clock, so
 * an event is caught in the frame it happens (not in a 100 ms sample that may
 * straddle it), a win on the second second does not cost fifteen, and the whole
 * run works in a background tab, where rAF is throttled to a crawl.
 *
 * ## Time-mode discipline
 *
 * The run switches the runner to `'manual'` and **always restores the previous
 * mode**, even on an error path. Leaving `'manual'` behind would be the worst
 * kind of leak: `manual` schedules no animation frame, so the next `play_resume`
 * (or a human pressing Play) produces a game that is running, unpaused, and
 * completely frozen — indistinguishable from a hang caused by the code under
 * test. The *pause* is a different matter and is kept (`pauseOnOutcome`): it is
 * what makes the outcome frame inspectable, and it is undone by
 * `game_time {paused: false}`, by `game_input` (which needs a running game), or
 * by play_restart. Either way the report states both facts under `time`.
 *
 * The pause is requested from the **host** (`deps.setHostPaused` →
 * `GamePlaySessionService.setPauseRequested`), not applied to the runner behind
 * its back. The editor decides the runner's pause state from its focus rule and
 * re-applies that decision on every focus event and suppression toggle — and this
 * very call drops its focus-pause suppression in its `finally` — so a bare
 * `runner.pause()` was undone milliseconds after the report claimed it held.
 * `leftPaused` is therefore read back from `runner.paused` at the end rather than
 * set from `pauseOnOutcome`: it is a fact about the game, not a restatement of
 * the request.
 *
 * ## Event predicates own a window, not a filter
 *
 * `command` and `signal` judge things that *happened* rather than values that
 * *are*, so the loop, not the predicate, decides what belongs to the run. The two
 * do it differently for a reason:
 *
 * - the **command journal** already exists and is shared with the whole scene, so
 *   the loop cuts it by position (`entries.length + dropped` is a monotone
 *   watermark) and reports what the ring buffer dropped inside the window;
 * - **signals** have no journal at all — `NodeBase.emit` walks its connections and
 *   returns — so the loop *creates* the record by subscribing at the start and
 *   disconnecting in its `finally`. Nothing outside the run is filtered out
 *   because nothing outside the run is ever heard.
 *
 * ## Input steps are not in this slice
 *
 * `GameInputService.run()` paces its steps with wall-clock `setTimeout`, and in
 * `'manual'` mode no tick happens while those timers run: a 500 ms key hold would
 * deliver keydown and keyup with **zero** frames in between, so the game would
 * never poll the key and every input-driven assertion would fail for a reason
 * that has nothing to do with the game. Frame-denominated input steps are a phase
 * 1/3 item on `GameInputService` itself. Until then a spec carrying `input` is
 * rejected with that explanation rather than run into a false negative.
 */

/** Frames a run executes when the spec does not say. ~10 s of game at 1/60. */
const DEFAULT_MAX_FRAMES = 600;
/** Hard ceiling on the frame budget — one minute of game time at 1/60. */
const MAX_MAX_FRAMES = 3600;
/** Wall-clock ceiling. A manual loop is CPU-bound, so this is the real runaway guard. */
const DEFAULT_MAX_WALL_MS = 20_000;
const MAX_MAX_WALL_MS = 60_000;
/**
 * Ticks between yields to the host event loop. The loop is synchronous per tick;
 * without a yield a 600-frame run blocks the main thread outright and the editor
 * looks hung. 30 keeps each block at roughly one animation frame's worth of work.
 */
const YIELD_EVERY_FRAMES = 30;
/**
 * Breath between a routine's last step and the frame its expectations are judged
 * on. Short on purpose: the input layer settles each of its own batches, so this
 * only has to cover a command step's effect landing on the next tick.
 */
const ROUTINE_SETTLE_MS = 150;

/** Max node names tracked per run (matches NodeWatchRecorder's watch cap). */
const MAX_TRACKED_NODES = 8;
/** Timeline cap (§6 rule 2). */
const MAX_TIMELINE_ENTRIES = 20;
/** Max changed paths recorded per frame, so one chaotic frame cannot eat the timeline. */
const MAX_TIMELINE_PATHS_PER_FRAME = 3;
/** Max scalar paths in the baseline→outcome game diff (payload discipline, cf. MAX_GAME_DIFF_PATHS). */
const MAX_GAME_DIFF_PATHS = 20;
/**
 * When no predicate reads game state, the snapshot is sampled only this often —
 * purely to give the timeline something to show. Predicate correctness never
 * depends on it: the predicates that read state force per-frame sampling.
 */
const STATE_SAMPLE_EVERY_FRAMES = 10;
/** Depth of the game-snapshot serialization (matches GameInputService). */
const GAME_SNAPSHOT_DEPTH = 5;
/**
 * Journal entries kept from *before* the run, purely so a `command` predicate can
 * say "you dispatched it just before the run started" instead of "never". Copied
 * once at the baseline; the live journal is a ring buffer and would shift under us.
 */
const MAX_PRE_WINDOW_ENTRIES = 20;
/** Nodes one signal sweep may visit. A bullet-hell scene must not turn a sweep into the run's cost. */
const MAX_SIGNAL_SWEEP_NODES = 4000;
/** Distinct emitter names remembered per watch — evidence, not an inventory. */
const MAX_SIGNAL_EMITTERS = 5;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The spec a `game_run` call carries (the tool layer parses raw JSON into this). */
export interface GameRunSpec {
  /** OR over the list — the first one that holds ends the run successfully. */
  until: GameAssertion[];
  /** OR over the list — the first one that holds ends the run as a failure. */
  fail?: GameAssertion[];
  /** Extra node names/ids to report presence transitions for in the timeline. */
  watch?: string[];
  /** Frame budget (default {@link DEFAULT_MAX_FRAMES}, capped at {@link MAX_MAX_FRAMES}). */
  maxFrames?: number;
  /** Tick length in seconds (default 1/60). Same knob as `RuntimeTimeConfig.fixedDeltaSec`. */
  fixedDeltaSec?: number;
  /** Wall-clock budget in ms (default {@link DEFAULT_MAX_WALL_MS}). */
  maxWallMs?: number;
  /** Leave the game paused on the outcome frame so it can be inspected. Default true. */
  pauseOnOutcome?: boolean;
  /**
   * Turn the run into a monkey run: random input from the seeded stream, judged by
   * invariants instead of by an understanding of the game (§5.2, `game-monkey.ts`).
   */
  monkey?: NormalizedMonkeySpec;
  /**
   * The negative control (§5.4.4): the same gesture, away from the control. Run
   * after the main run, from an isolated state, with the same budget.
   */
  control?: NegativeControlSpec;
  /**
   * Turn the run into a bot run: a stored policy plays the game while the loop
   * watches (§5.3, `game-bots.ts`). The policy's own `done()` ends the run, and the
   * `until`/`fail` predicates stay in force as the budget and the crash net.
   */
  bot?: NormalizedBotSpec;
}

export type GameRunOutcomeKind =
  | 'until'
  | 'fail'
  | 'timeout'
  | 'error'
  | 'precondition-already-met'
  /**
   * A monkey run that found nothing to press. Its own kind rather than a note on a
   * PASS, because "the budget elapsed and no invariant broke" is exactly what a
   * clean 600-frame monkey run looks like — and a reader who sees PASS will not
   * ask whether anything was pressed (rule 3 of the monkey module).
   */
  | 'monkey-empty'
  /** A policy called `done(true, …)`: the run ended on the bot's own verdict. */
  | 'bot-pass'
  /** A policy called `done(false, …)` — the finding this layer exists to produce. */
  | 'bot-fail'
  /**
   * The POLICY threw. Its own kind, and never `fail`: "the game failed" read off a
   * typo in a test file is the worst thing this layer could produce, so the outcome
   * itself — not a note on it — has to say which of the two broke.
   */
  | 'bot-error'
  /**
   * A bot run in which no actuator was ever delivered. The `monkey-empty` rule
   * applied to a written policy: a game nobody played is not a game that passed.
   */
  | 'bot-idle';

/**
 * How an outcome is spelled in a report's FILE NAME (`0009-run-timeout-f600.json`).
 *
 * Deliberately not `outcome.kind` verbatim: the name has to answer "how did this
 * run end" to a human scanning an `fs_list`, and `until` answers that question
 * wrongly — it names the channel that fired, not the fact that the run passed.
 */
const REPORT_VERDICT_SLUGS: Record<GameRunOutcomeKind, string> = {
  until: 'pass',
  fail: 'fail',
  timeout: 'timeout',
  error: 'error',
  'precondition-already-met': 'precondition',
  'monkey-empty': 'nothing-tested',
  'bot-pass': 'bot-pass',
  'bot-fail': 'bot-fail',
  'bot-error': 'bot-error',
  'bot-idle': 'nothing-driven',
};

export interface GameRunOutcome {
  kind: GameRunOutcomeKind;
  /** Index into the channel's assertion list, when a predicate decided the run. */
  index?: number;
  /** Which list `index` refers to. */
  channel?: 'until' | 'fail';
  /** Frame the outcome landed on. 0 means "before any tick ran". */
  frame: number;
  /** Driver time at the outcome: `frame × fixedDeltaSec × 1000`. */
  gameTimeMs: number;
  /** Label of the deciding predicate. */
  assertion?: string;
  /** One line of evidence. */
  detail: string;
}

export interface GameRunTimelineEntry {
  frame: number;
  kind: 'state' | 'error' | 'gone' | 'appeared';
  note: string;
  /** Repeats of the same event folded into one entry (§6 rule 2). */
  count?: number;
}

export interface GameRunTimeReport {
  /** The mode the run itself executed in — always `'manual'`. */
  ranIn: RuntimeTimeMode;
  fixedDeltaSec: number;
  /** The mode the runner was left in (the one it had before the run). */
  restoredMode: RuntimeTimeMode;
  /** Whether the game was left paused on the outcome frame. */
  leftPaused: boolean;
}

export interface GameRunGameReport {
  provider: string;
  /** Snapshot at the outcome frame. */
  snapshot: Json;
  /** Scalar paths that differ between frame 0 and the outcome frame. */
  changed?: Record<string, [Json, Json]>;
  /** Set instead of a diff when `snapshot()` threw. */
  error?: string;
}

export interface GameRunResult {
  /** The call executed. A `fail`/`timeout` outcome is still `ok: true`. */
  ok: boolean;
  /** Set only when the call could not run at all (not playing, bad spec, …). */
  error?: string;
  /** Read this first (§6 rule 1). */
  verdict?: string;
  outcome?: GameRunOutcome;
  metrics?: {
    frames: number;
    gameTimeMs: number;
    wallMs: number;
    newErrors: number;
    /** Ticks per wall-clock second achieved — the honest analogue of a "speed×N". */
    framesPerSecond: number;
  };
  game?: GameRunGameReport;
  timeline?: GameRunTimelineEntry[];
  /** True when the timeline hit its cap and later events were dropped. */
  timelineTruncated?: boolean;
  time?: GameRunTimeReport;
  newErrors?: Array<{ source: string; message: string }>;
  /** Labels of the predicates as the harness understood them. */
  assertions?: { until: string[]; fail: string[] };
  /** Caveats worth one line each (unmet predicates at timeout, missing provider, …). */
  notes?: string[];
  /** What the monkey pressed, and with which seed (monkey runs only). */
  monkey?: MonkeyReport;
  /**
   * What the policy did, and on which actuator channel (bot runs only). Read
   * `channel` before believing anything about input: a `direct-action` run proves
   * game logic and no binding at all.
   */
  bot?: BotReport;
  /** Whether the negative control proved the binding — three-valued (§5.4.4). */
  control?: NegativeControlReport;
  /**
   * The pointer to the FULL protocol of this run in `design/tests/reports/`: read
   * it with `fs_read {offset, limit}` when this reply is not enough, and read the
   * `reason` when it says `written: false` — that is the one case where everything
   * the caps cut is gone for good.
   */
  artifact?: RunArtifactReport;
}

/**
 * The negative control's own report. Every field exists because the verdict alone
 * cannot be acted on: `isolation.method` says whether the state really came back
 * (a scene restart keeps a script's module state, a game's own `reset` does not),
 * and `frames` is the budget comparison the verdict depends on.
 */
export interface NegativeControlReport {
  verdict: ControlVerdict;
  /** Why it could not decide. Absent on `passed`/`failed`. */
  reason?: ControlInconclusiveReason;
  /** The one line that explains the verdict. */
  note: string;
  /** How the game was put back to the main run's starting state, and whether that worked. */
  isolation: ControlIsolationReport;
  /** The gesture that was performed, in words. */
  gesture: string;
  /** Frames the effect needed in the main run vs frames the control gesture got. */
  frames: { main: number; control: number };
  /** Precondition differences, when they are what made the control inconclusive. */
  differences?: string[];
  /** How the control run itself ended — read it when the verdict is `failed`. */
  outcome?: GameRunOutcome;
}

/**
 * The subset of `SceneRunner` the loop drives. Structural on purpose: the loop's
 * spec builds a twenty-line fake instead of a scene, a renderer and an audio
 * mixer, and the loop cannot accidentally reach for anything else.
 */
export interface TestableRunner {
  readonly paused: boolean;
  readonly running: boolean;
  getTimeMode(): Readonly<ResolvedRuntimeTimeConfig>;
  setTimeMode(config: RuntimeTimeConfig): void;
  stepFrames(count?: number): number;
  pause(): void;
  resume(): void;
}

/** One reading of the game's own debug provider. */
export interface GameStateSample {
  provider: string;
  snapshot?: Json;
  error?: string;
}

/** One reading of the scene's command journal. */
export interface CommandJournalReading {
  /** The live ring buffer, oldest first. */
  entries: readonly GameCommandLogEntry[];
  /** Total entries the ring has dropped since the scene started. */
  dropped: number;
}

/**
 * A live subscription to the signals a run's assertions name.
 *
 * It exists for the length of one run and nothing else: `dispose()` disconnects
 * every listener it attached, and the loop calls it from its `finally` — before
 * the time mode is restored, so not a single emission after the run's last frame
 * can be recorded. Signal windowing is therefore *structural*, not a filter:
 * emissions outside the run are never observed rather than observed-and-discarded.
 */
export interface SignalWatcher {
  /**
   * Attach to nodes that have joined the scene since the last sweep, and stamp
   * subsequent emissions with `frame`. Called immediately before stepping that
   * frame, so a node spawned mid-run is heard from the frame it appears in.
   */
  sweep(frame: number): void;
  /** Immutable snapshot of what each watch has heard so far. */
  observations(): ReadonlyMap<string, SignalObservation>;
  /** Disconnect everything. Idempotent. */
  dispose(): void;
}

/** How one monkey action went, as the world reports it back to the driver. */
export interface MonkeyExecution {
  status: MonkeyLogEntry['status'];
  /** Why it was refused, or what threw. Shown in the log next to the action. */
  note?: string;
}

/**
 * The world a monkey run needs: what can be pressed right now, and how to press
 * it. The split is the one the monkey module's header insists on — the loop
 * supplies the world and executes the actions, the driver only decides — and it is
 * what lets a spec replay an inventory sequence without a scene.
 *
 * `inventory` is async because the live control listing is
 * (`GameInputService.listControls` awaits the reachability journal). That is safe
 * inside the loop for one structural reason: the run holds the runner in `'manual'`
 * time, where no animation frame is scheduled, so nothing advances while the
 * promise settles.
 */
export interface MonkeyWorld {
  /** The action surface of the scene as it is at this moment. */
  inventory: () => Promise<MonkeyInventory>;
  /** Perform one decided action. Called in the gap before the frame it belongs to. */
  execute: (action: MonkeyAction, frame: number) => Promise<MonkeyExecution> | MonkeyExecution;
  /** Release holds whose frame budget has run out. Called in every inter-tick gap. */
  releaseDue: (frame: number) => void;
  /** Release everything still held. Called from the loop's `finally`. */
  releaseAll: () => void;
}

/**
 * What the frame loop needs from a bot session — deliberately read-only plus a
 * teardown.
 *
 * Structural rather than the `BotSession` class so the loop's spec can express "the
 * policy finishes on frame 12" in four lines, and so the loop cannot reach for
 * anything else: it must not be able to tick, actuate, or inspect the policy. The
 * ticking belongs to the runner and the decisions to the policy; the loop only reads
 * the verdict and hands the game back.
 */
export interface BotRunHooks {
  /** True once the policy reached a verdict or threw. */
  readonly finished: boolean;
  /** The policy's own verdict, or null while it has none. */
  readonly outcome: { pass: boolean; reason: string; frame: number } | null;
  /** The policy's crash, kept apart from {@link outcome} — see `bot-error`. */
  readonly crash: { message: string; stack?: string; frame: number } | null;
  report(): BotReport;
  /** Run the policy's `end` hook and release everything it still holds. */
  dispose(): void;
}

/** Everything the loop needs from the world, injected so the loop is testable. */
export interface GameRunLoopDeps {
  runner: TestableRunner;
  /** Read the registered `GameDebugProvider`, or null when there is none. */
  sampleGameState: () => GameStateSample | null;
  /** Total runtime errors captured so far (a counter, not a copy — called per frame). */
  errorCount: () => number;
  /** Errors captured after index `from`, in compact form. */
  errorsSince: (from: number) => Array<{ source: string; message: string }>;
  /** Does a live node with this name/id exist right now? */
  nodeExists: (query: string) => boolean;
  /**
   * The four readers below are the per-predicate collectors, and they are optional
   * for one reason only: a spec (or a runtime) that cannot supply one must make the
   * predicate say *that* rather than report a negative result about the game. The
   * loop calls each one **only when an assertion asks for it** — see the selectors
   * in `drive` — so a run that mentions none of them costs nothing.
   *
   * Their names and signatures are deliberately identical to {@link RoutineWorld}'s:
   * the routine driver collects exactly the same four fields, both are fed by the
   * same live readers in this file (`snapshotLiveNode`, `readLiveNodeProperty`,
   * `countLiveNodesOfType`, `readLiveAxis`), and a second spelling of "where the
   * node is" would be a second thing to keep in sync.
   */
  /** Transform snapshot of a live node — the expensive read `nodeMoved` needs. */
  snapshotNode?: (query: string) => LiveNodeSnapshot | null;
  /** A dot path into a live node's own properties; `undefined` = no node or no such property. */
  readNodeProperty?: (query: string, path: string) => Json | undefined;
  /** Live node count for a type query — the pooling-proof reading of `nodeAppeared`. */
  countNodesOfType?: (type: string) => number;
  /**
   * Input axis value, sampled **without registering as a game poll** (see
   * {@link AssertionFrame.axes}): a harness that read axes through the recorded
   * path would list every axis its own assertions mention as polled by the game.
   */
  readAxis?: (name: string) => number | undefined;
  /**
   * Read the scene's command journal, or null when the running scene has no
   * registry. Optional: a runtime that cannot produce one makes every `command`
   * predicate report that, instead of failing for an unstated reason.
   */
  readCommandJournal?: () => CommandJournalReading | null;
  /** Open the run's signal subscriptions. Optional for the same reason. */
  watchSignals?: (specs: readonly SignalWatchSpec[]) => SignalWatcher;
  now: () => number;
  /** Hand the main thread back so the editor can breathe mid-run. */
  yieldToHost: () => Promise<void>;
  /**
   * Called immediately before `stepFrames(1)` executes `frame`, i.e. in the gap
   * between two ticks. This is the seam trace replay feeds input through
   * (`game-traces.ts`): a wall-clock pacer cannot deliver input in `'manual'`
   * mode at all, whereas an event dispatched here is polled by the game on
   * exactly `frame`. Recording and the nondeterminism probe use the same gap.
   */
  beforeFrame?: (frame: number) => void;
  /**
   * Called immediately after the tick returns — including when it throws, so a
   * probe armed in `beforeFrame` is always disarmed.
   */
  afterFrame?: (frame: number) => void;
  /**
   * Ask the *host* to hold the game paused (or release it), rather than pausing
   * the runner behind the host's back. It matters because the editor decides the
   * runner's pause state from its own focus rule and re-applies that decision on
   * every focus event and suppression toggle — including the one `game_run` does
   * in its own `finally` — so a bare `runner.pause()` is undone milliseconds
   * later. Optional: a runtime without a host pause owner falls back to
   * `runner.pause()`, and `leftPaused` reports whichever state actually held.
   */
  setHostPaused?: (paused: boolean) => void;
  /**
   * The action surface and the executor for a monkey run. Optional: a spec that
   * asks for a monkey against a runtime that cannot supply one is reported as
   * such, rather than running 600 frames of nothing and calling it clean.
   */
  monkey?: MonkeyWorld;
  /**
   * The live bot session, when a policy is playing. The loop **does not tick it** —
   * the runner does, through its own per-tick hook, which is what lets the same
   * session play in realtime and under manual stepping alike. All the loop does is
   * ask each frame whether the policy has finished, and let go of it at the end.
   */
  bot?: BotRunHooks;
  /**
   * Hand the run's frame-0 record out. The negative control needs BOTH runs'
   * baselines to compare preconditions, and a baseline is a live `Map`/`Set`
   * record — not something the JSON report can carry — so it leaves through this
   * seam instead of through {@link GameRunResult}.
   */
  onBaseline?: (baseline: AssertionBaseline) => void;
  /**
   * Where the run's full protocol is recorded (`game-run-protocol.ts`). The loop
   * writes into it and never *decides* anything from it, so a run without one
   * behaves identically — which is what lets every existing loop spec keep passing
   * a sink-less deps object and still describe the loop faithfully.
   */
  protocol?: RunProtocolSink;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@injectable()
export class GameTestService {
  @inject(GamePlaySessionService)
  private readonly playSession!: GamePlaySessionService;

  /**
   * Borrowed for one thing only: the live control listing. A monkey presses what
   * `game_controls` lists, and building a second opinion on "what is pressable"
   * here would drift from the first one the moment either changed.
   */
  @inject(GameInputService)
  private readonly gameInput!: GameInputService;

  /**
   * Compiles the stored policies. Borrowed rather than absorbed for the same reason
   * `gameInput` is: turning a `.ts` file into a callable object is a compiler
   * concern, and this service's business is the frame loop.
   */
  @inject(GameBotHost)
  private readonly botHost!: GameBotHost;

  /**
   * Default storage is in-memory: a record → replay round trip inside one editor
   * session works, a reload loses the traces. Writing `design/tests/*.trace.json`
   * into the open project means going through the project's file services, so it
   * is a backend swapped in via {@link setTraceStore} rather than a dependency of
   * this service. See {@link TraceStore} for the seam.
   */
  private traceStore: TraceStore = new InMemoryTraceStore();

  /** Routine library backend, swapped for the project's files by the tool layer. */
  private routineStore: RoutineStore = new InMemoryRoutineStore();

  /**
   * Where a run's full protocol is written — the same seam as the two stores above
   * and for the same reason (the file backend needs `ProjectStorageService`, which
   * this service deliberately does not depend on). `null` rather than an in-memory
   * default on purpose: an in-memory protocol store would be a file the agent is
   * told to `fs_read` and cannot, so with no project open the run says the protocol
   * was lost instead of pointing at nothing.
   */
  private protocolStore: RunProtocolStore | null = null;

  /**
   * Run one gameplay test against the live game. Returns `ok: false` only when
   * the run could not start; a failed or timed-out run is a successful call with
   * a negative verdict.
   */
  async run(spec: GameRunSpec & { input?: unknown }): Promise<GameRunResult> {
    if (!appState.ui.isPlaying) {
      return {
        ok: false,
        error: 'The game is not running. Call play_start first, then game_run.',
      };
    }
    const runtime = this.playSession.getActiveRuntime();
    if (!runtime) {
      return {
        ok: false,
        error: 'Play mode is starting but the runtime is not attached yet; retry in a moment.',
      };
    }
    if (spec.input !== undefined) {
      return {
        ok: false,
        error:
          'game_run does not drive input yet. Its frame loop runs the game in manual time mode, where no tick happens while game_input waits on wall-clock timers — a 500ms key hold would deliver keydown and keyup with zero frames in between and the game would never poll it. Send the input with game_input first (it runs in realtime), then call game_run with only `until`/`fail` to judge what follows.',
      };
    }
    const validation = validateSpec(spec);
    if ('error' in validation) {
      return { ok: false, error: validation.error };
    }
    const normalized = validation.spec;

    // The policy is loaded and compiled BEFORE the clock is touched. A compile error
    // is the most common failure of a bot run, and paying for it with a time-mode
    // switch, a resume and a pause would leave the game in a state nobody asked for
    // over a typo.
    let bot: BotSession | null = null;
    if (normalized.bot) {
      const loaded = await this.botHost.load(normalized.bot.name);
      if ('error' in loaded) return { ok: false, error: loaded.error };
      bot = new BotSession(
        loaded.name,
        loaded.policy,
        this.buildBotWorld(runtime, normalized.bot.channel),
        // The policy's own error channel. `componentType: 'test:bot'` is what keeps
        // "the bot fell over" from reading as "the game fell over" in the Logs panel,
        // which is the same separation `bot-error` makes in the verdict.
        error =>
          reportScriptError({
            phase: 'update',
            componentType: 'test:bot',
            componentId: loaded.name,
            message: `bot "${loaded.name}": ${error.message}`,
            ...(error.stack ? { stack: error.stack } : {}),
          })
      );
    }

    const startedAt = new Date().toISOString();
    // ONE recorder for the whole experiment, created here rather than inside
    // `runSession`: a recorder per session would give the negative control its own
    // report file, and a control read apart from the run it controls means nothing.
    const recorders = [new RunProtocolRecorder('main', normalized.monkey?.seed ?? null)];

    let mainBaseline: AssertionBaseline | null = null;
    // The runner ticks the policy, not the loop — through the same per-tick hook the
    // watch recorder uses. That is what makes one session work under manual stepping
    // and in realtime alike, and it is why the subscription is owned here (for the
    // length of the call) rather than by the loop.
    const detachBot = bot ? runtime.runner.subscribeFrameStats(() => bot?.tick()) : null;
    let main: GameRunResult;
    try {
      main = await this.runSession(runtime.runner, deps =>
        runGameTestLoop(
          {
            ...deps,
            protocol: recorders[0],
            onBaseline: baseline => {
              mainBaseline = baseline;
            },
            ...(normalized.monkey ? { monkey: this.buildMonkeyWorld(runtime) } : {}),
            ...(bot ? { bot } : {}),
          },
          normalized
        )
      );
    } finally {
      // Unsubscribe before anything else can tick: a policy still attached while the
      // negative control restarts the scene would play the control run too.
      detachBot?.();
      // One write per run, the same granularity `game_input` uses: a policy can press twenty
      // controls, and each press happens inside the frame loop the run is judged by.
      if (bot) await this.gameInput.flushReachJournal();
    }
    if (bot) {
      const report = bot.report();
      recorders[0].botLog({
        name: report.name,
        channel: report.channel,
        frames: report.frames,
        sent: report.sent,
        refused: report.refused,
        log: bot.fullLog().map(entry => ({ ...entry })),
      });
    }
    const judged = await this.judgeWithNegativeControl(main, normalized, mainBaseline, recorders);
    // `ok: false` gets no artifact and no `written: false` note: nothing ran, so
    // there is no protocol to have lost, and a pointer to a file that would only
    // hold the refusal is noise on top of the sentence that already explains it.
    if (!judged.ok || !judged.outcome) return judged;

    judged.artifact = await saveRunProtocol(
      this.protocolStore,
      buildRunProtocolDocument({
        kind: 'game_run',
        subject: runSubject(normalized),
        startedAt,
        editorVersion: CURRENT_EDITOR_VERSION.version,
        sceneId: appState.scenes.activeSceneId,
        reply: protocolReply(judged),
        sections: recorders.map(recorder => recorder.section()),
        notes: recorders.flatMap(recorder => [...recorder.notes()]),
      }),
      {
        subject: runSubject(normalized),
        verdict: REPORT_VERDICT_SLUGS[judged.outcome.kind],
        frame: judged.outcome.frame,
      }
    );
    return judged;
  }

  /**
   * Run the negative control (§5.4.4) and mark the verdict with what it proved.
   *
   * The order here is the whole argument of the mechanism: the control runs only
   * after the main run has a result worth controlling, from a state that was
   * *restored* (awaited — a `reset` that is still tearing down is isolation in
   * name only), with the main run's own budget. Anything that breaks one of those
   * three is `inconclusive` with the reason named, never "control passed".
   */
  private async judgeWithNegativeControl(
    main: GameRunResult,
    spec: NormalizedRunSpec,
    mainBaseline: AssertionBaseline | null,
    /**
     * The experiment's recorders, `main` first. A control run appends its own here
     * instead of opening a second report: the two runs are one experiment, and
     * `sections[0]` vs `sections[1]` is the comparison the whole mechanism is about.
     */
    recorders: RunProtocolRecorder[] = []
  ): Promise<GameRunResult> {
    if (!main.ok || !main.outcome) return main;
    const passed = main.outcome.kind === 'until';

    if (!spec.control) {
      // Nothing to run: decide only whether the result must be read as WEAK.
      // A `direct-action` policy is exempt for the monkey's reason: it synthesizes no
      // pointer press at all, so there is no "tapped somewhere else" the marker could
      // be warning about. A `physical-input` policy is NOT exempt — it presses real
      // fingers, which is exactly when `Action_Primary` can fake a working button.
      const drivenWithoutPointer = Boolean(spec.monkey) || spec.bot?.channel === 'direct-action';
      const usedScreenControl =
        passed && !drivenWithoutPointer && (await this.assertsAboutScreenControl(spec));
      return markControlStrength(main, { usedScreenControl, judgement: null, passed });
    }
    if (!passed) {
      main.notes = [
        ...(main.notes ?? []),
        `The negative control was not run: the main run ended as ${main.outcome.kind}, and a control gesture only means something against an effect that DID happen. Nothing about the control's binding is claimed either way.`,
      ];
      return main;
    }

    const control = spec.control;
    const gesture = `pointer down at nx ${control.tap.nx}, ny ${control.tap.ny} (fractions of the canvas), held ${control.holdFrames} frames`;
    const reset = resolveGameReset();
    const isolation = await isolateForControl({
      ...(reset ? { resetGame: reset } : {}),
      restartScene: () => this.playSession.restart(),
      ...(control.seed !== undefined ? { seed: control.seed } : {}),
    });

    // Re-read the runtime: a scene restart replaces it wholesale, so the handle the
    // main run used is stale by now.
    const runtime = this.playSession.getActiveRuntime();
    let controlBaseline: AssertionBaseline | null = null;
    let controlResult: GameRunResult | null = null;
    if (runtime) {
      const controlSpec: NormalizedRunSpec = { ...spec };
      // The control run performs ONE gesture and nothing else: a monkey pressing
      // random things through it — or a policy playing on — would be a different
      // experiment, and the control's whole meaning is that nothing else touched the
      // game while it ran.
      delete controlSpec.monkey;
      delete controlSpec.control;
      delete controlSpec.bot;
      const feeder = makeTraceFeeder(
        controlGestureEvents(control),
        new DomTraceInputSink(runtime.canvas, runtime.windowRef)
      );
      const controlRecorder = new RunProtocolRecorder('control');
      controlRecorder.note(
        `This section is the NEGATIVE CONTROL: ${gesture}, after the game was put back to the main run's starting state by ${isolation.method}. Its readings are what the same predicates saw with the control untouched, so compare them against sections[0] frame for frame.`
      );
      recorders.push(controlRecorder);
      controlResult = await this.runSession(runtime.runner, deps =>
        runGameTestLoop(
          {
            ...deps,
            protocol: controlRecorder,
            beforeFrame: frame => feeder.before(frame),
            onBaseline: baseline => {
              controlBaseline = baseline;
            },
          },
          controlSpec
        )
      );
    }

    const judgement = judgeNegativeControl({
      isolation,
      until: spec.until,
      mainBaseline: mainBaseline ?? emptyBaseline(),
      controlBaseline,
      controlOutcome: toControlOutcome(controlResult?.outcome),
      mainFrameBudget: main.outcome.frame,
      controlFrameBudget: controlResult?.outcome?.frame ?? 0,
    });

    main.control = {
      verdict: judgement.verdict,
      ...(judgement.reason ? { reason: judgement.reason } : {}),
      note: judgement.note,
      isolation,
      gesture,
      frames: { main: main.outcome.frame, control: controlResult?.outcome?.frame ?? 0 },
      ...(judgement.differences ? { differences: judgement.differences } : {}),
      ...(controlResult?.outcome ? { outcome: controlResult.outcome } : {}),
    };
    if (!runtime) {
      main.notes = [
        ...(main.notes ?? []),
        'The negative control could not run: play mode ended (or the runtime detached) while the game was being put back to its starting state.',
      ];
    }
    return markControlStrength(main, { usedScreenControl: true, judgement, passed: true });
  }

  /**
   * Does this run judge something that is operated on screen?
   *
   * Detected from the assertions' own node names against the live control listing,
   * because the thing that caused the effect (a `game_input` tap in an earlier
   * call) happened outside this loop and cannot be observed from inside it. The
   * cost of the heuristic is a WEAK marker on a run whose cause was actually a
   * dispatched command; the cost of not having it is a PASS on a dead button, which
   * is the failure this harness exists for.
   *
   * Monkey runs are exempt: the loop knows every channel it drove, and none of them
   * synthesizes a pointer press — a semantic `invoke` never raises `Action_Primary`,
   * so there is no "tapped somewhere else" to compare against and a marker here
   * would only teach everyone to ignore the marker.
   */
  private async assertsAboutScreenControl(spec: NormalizedRunSpec): Promise<boolean> {
    const names = assertionNodeNames([...spec.until, ...spec.fail]);
    if (names.length === 0) return false;
    const listing = await this.gameInput.listControls();
    if (!listing.ok || !listing.controls) return false;
    const wanted = new Set(names);
    return listing.controls.some(control => wanted.has(control.name) || wanted.has(control.nodeId));
  }

  /**
   * The world a monkey run presses: the live listing for what is there, and the
   * three channels for pressing it.
   *
   * Keys go through synthesized DOM events — the real player path, the same sink a
   * trace replays through — while interactions and commands are the semantic
   * channels of §5.6/§5.8. Held actions are released on a frame schedule rather
   * than a timer, for the same reason the whole loop is frame-denominated: in
   * `manual` time a wall-clock release may never happen at all.
   */
  private buildMonkeyWorld(runtime: {
    runner: SceneRunner;
    canvas: HTMLCanvasElement;
    windowRef: Window;
  }): MonkeyWorld {
    const sink = new DomTraceInputSink(runtime.canvas, runtime.windowRef);
    let holds: Array<{ frame: number; release: () => void }> = [];
    const holdUntil = (frame: number, release: () => void): void => {
      holds.push({ frame, release });
    };
    return {
      inventory: async () => {
        const listing = await this.gameInput.listControls();
        const registry = findCommandRegistry(runtime.runner);
        const declared = readDeclaredActions();
        return {
          controls: listing.controls ?? [],
          commands: [
            ...new Set([
              ...(registry?.list() ?? []).map(command => command.name),
              ...declared.commands,
            ]),
          ],
          actions: declared.inputActions,
        };
      },
      execute: (action, frame) =>
        executeMonkeyAction(runtime.runner, sink, holdUntil, action, frame),
      releaseDue: frame => {
        const due = holds.filter(hold => hold.frame <= frame);
        holds = holds.filter(hold => hold.frame > frame);
        for (const hold of due) release(hold);
      },
      releaseAll: () => {
        const all = holds;
        holds = [];
        for (const hold of all) release(hold);
      },
    };
  }

  /**
   * The world a policy senses and actuates through (§5.3).
   *
   * Composed here, next to the monkey's world and the routine's, because the
   * *editor-side* readers a bot shares with them live here — `resolveLiveInput`,
   * `findInteractionOwner`, `readGameState`, `keyCodeOf`. The geometry (node views,
   * ray-versus-box, the joystick deflection) is in `game-bot-world.ts` instead, for
   * one reason: it is the part a spec can hold to account without a browser, and it is
   * the part where being subtly wrong produces a policy that "does not work" with
   * nothing in the report to point at.
   *
   * The channel decides the actuators and nothing else: both channels sense
   * identically, because what a policy can *see* is not what a run proves.
   */
  private buildBotWorld(
    runtime: { runner: SceneRunner; canvas: HTMLCanvasElement; windowRef: Window },
    channel: BotActuatorChannel
  ): BotWorld {
    const { runner } = runtime;
    const sink = new DomTraceInputSink(runtime.canvas, runtime.windowRef);
    const scene = runner as unknown as BotSceneHandle;
    const sticks = new PhysicalAxisDriver(scene, runtime.canvas, sink);
    /** Keys/buttons the world put down, so `releaseAll` can be exhaustive. */
    const heldKeys = new Set<string>();
    const heldButtons = new Set<string>();
    const openTaps = new Map<string, { nx: number; ny: number }>();

    /**
     * Credit the reachability journal for a tap this policy drove, at the same moment a
     * `game_input` tap does it: while the finger is still down, so the control has already ticked
     * and its own bounds check is the witness. Only the physical channel earns it — `direct-action`
     * calls the interaction and touches no pixels, which is precisely what it does not prove.
     */
    const noteTapReach = (target: string): void => {
      if (channel !== 'physical-input') return;
      this.gameInput.noteExternalPhysicalReach(runtime, target);
    };

    return {
      channel,

      findNodes: (query, max) => collectBotNodeViews(scene, query, max),
      nearestOfType: (type, from) => nearestBotNode(scene, type, from),
      raycast: (from, dir) => raycastBotNodes(scene, from, dir),
      gameState: () => readGameState()?.snapshot ?? null,

      pressAction: action => {
        const code = keyCodeOf(action) ?? keyCodeOf(`Key_${action}`);
        if (channel === 'physical-input') {
          if (!code) {
            // `Action_Primary` is the honest exception: it is raised by ANY pointer
            // press, so the physical gesture for it is a press somewhere — and a
            // press "somewhere" is the false-positive machine the negative control
            // exists to catch. Refusing it by name is better than synthesizing a tap
            // into empty space and letting the run claim the button works.
            return `"${action}" is not a key, so there is no keystroke that raises it. On \`physical-input\` a named action has to come from a control the player can touch: tap("${action}") if it is a node, or press a key the game binds. (\`Action_Primary\` in particular is raised by a press ANYWHERE, so pressing it directly would prove nothing about any button.)`;
          }
          sink.key('down', code);
          heldKeys.add(code);
          return null;
        }
        const input = resolveLiveInput(runner);
        if (!input) {
          return `no live InputService could be reached to set "${action}" directly (is the scene still running?).`;
        }
        const name =
          action.startsWith('Key_') || action.startsWith('Action_') ? action : `Key_${action}`;
        input.setButton(name, true);
        heldButtons.add(name);
        return null;
      },

      releaseAction: action => {
        const code = keyCodeOf(action) ?? keyCodeOf(`Key_${action}`);
        if (channel === 'physical-input') {
          if (!code) return null;
          sink.key('up', code);
          heldKeys.delete(code);
          return null;
        }
        const input = resolveLiveInput(runner);
        if (!input) return null;
        const name =
          action.startsWith('Key_') || action.startsWith('Action_') ? action : `Key_${action}`;
        input.setButton(name, false);
        heldButtons.delete(name);
        return null;
      },

      tapDown: target => {
        const node = runner.getLiveNodeById(target) ?? runner.findLiveNodeByName(target);
        if (!node) {
          return `no live node named or with id "${target}" in the running scene.`;
        }
        if (!node.visible) {
          return `"${target}" has visible:false, so it is not on screen and cannot be tapped. Show it first (or fix whatever should have).`;
        }
        if (channel === 'direct-action') {
          const owner = findInteractionOwner(node, 'click');
          if (!owner) {
            return `"${target}" declares no "click" interaction, so the direct channel has nothing to call. game_controls lists what each node offers; on \`physical-input\` this same call would be a real pointer press instead.`;
          }
          return owner.invokeInteraction('click')
            ? null
            : `"${target}" refused "click" — the control is disabled, or an ancestor scroll container holds the pointer.`;
        }
        const backing = runner.projectNodeToCanvas(node);
        if (!backing) {
          return `"${target}" could not be projected to the canvas (no camera, or a zero-sized canvas).`;
        }
        const at = toCanvasFraction(runtime.canvas, backing);
        if (!at) return 'the game canvas has no size yet.';
        openTaps.set(target, at);
        sink.pointer('down', at.nx, at.ny, BOT_POINTER_ID);
        return null;
      },

      tapUp: target => {
        const at = openTaps.get(target);
        if (!at) return;
        openTaps.delete(target);
        noteTapReach(target);
        if (channel === 'physical-input') sink.pointer('up', at.nx, at.ny, BOT_POINTER_ID);
      },

      setAxisValue: (name, value) => {
        if (channel === 'physical-input') return sticks.steer(name, value);
        const input = resolveLiveInput(runner) as {
          setAxis?: (n: string, v: number) => void;
        } | null;
        if (typeof input?.setAxis !== 'function') {
          return `no live InputService could be reached to set axis "${name}" directly.`;
        }
        input.setAxis(name, value);
        return null;
      },

      pointAt: point => {
        const at = projectToCanvasFraction(scene, runtime.canvas, point.x, point.y);
        if (!at) {
          return `the world point (${point.x}, ${point.y}) could not be projected to the canvas.`;
        }
        // A move, not a press: this is aim/hover. A policy that wants a press says
        // `tap`, and keeping the two apart is what lets a hover-gated control (a
        // floating joystick, a tooltip) be exercised at all.
        sink.pointer('move', at.nx, at.ny, BOT_POINTER_ID);
        return null;
      },

      releaseAll: () => {
        for (const code of heldKeys) sink.key('up', code);
        heldKeys.clear();
        const input = resolveLiveInput(runner);
        for (const name of heldButtons) input?.setButton(name, false);
        heldButtons.clear();
        for (const [target, at] of openTaps) {
          noteTapReach(target);
          sink.pointer('up', at.nx, at.ny, BOT_POINTER_ID);
        }
        openTaps.clear();
        sticks.releaseAll();
      },
    };
  }

  /**
   * Record a run's input as a frame-denominated trace (§5.2 "Трассы").
   *
   * Two things happen alongside the ordinary loop: every input event the game
   * receives is stamped with the frame it was delivered before, and the
   * nondeterminism probe watches each tick, so the stored trace states whether a
   * strict replay comparison is even applicable. `feed` supplies the input to
   * record — frame-denominated events driven through the loop's inter-tick gap,
   * which is the delivery `game_input` cannot provide in `'manual'` time mode.
   * Without it the recording captures whatever else drives the game (a human at
   * the keyboard while the loop yields, an agent's `game_input` in another
   * call).
   */
  async recordTrace(
    spec: GameRunSpec,
    options: { name: string; seed?: number | null; feed?: readonly TraceEvent[] }
  ): Promise<GameTraceRecordResult> {
    const preflight = this.preflight(spec);
    if ('error' in preflight) return { ok: false, error: preflight.error };
    const { runtime, spec: normalized } = preflight;
    const path = traceFilePath(options.name);

    const recorded = await this.runSession(runtime.runner, deps =>
      recordTraceRun(deps, normalized, {
        name: options.name,
        source: new DomTraceEventSource(runtime.canvas, runtime.windowRef),
        sink: new DomTraceInputSink(runtime.canvas, runtime.windowRef),
        env: this.envelopeSeed(runtime.canvas, options.seed),
        ...(options.feed ? { feed: options.feed } : {}),
      })
    );
    await this.traceStore.save(path, recorded.trace);
    // Deliberately NO run-protocol artifact here, nor in `replayTrace`. A trace
    // already IS a project file, and it carries the run's events, outcome, metrics
    // and determinism evidence — a second file describing the same run would be one
    // more thing to rotate and one more path for the agent to guess between. (The
    // document's `determinism` field is where a future caller that does want both
    // would put the probe's report.)
    return { ...recorded.result, trace: recorded.trace, tracePath: path };
  }

  /**
   * Replay a stored trace and compare the two runs.
   *
   * Diagnostic by construction: the comparison judges `outcome.kind` and metrics
   * within tolerance, and a trace the probe marked `nondeterministic` is compared
   * by thresholds only — a fact the verdict states rather than leaves implied.
   */
  async replayTrace(
    nameOrPath: string,
    spec?: GameRunSpec,
    options?: CompareTraceOptions
  ): Promise<GameTraceReplayResult> {
    const path = traceFilePath(nameOrPath);
    let trace: GameInputTrace | null;
    try {
      trace = await this.traceStore.load(path);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!trace) {
      const known = await this.traceStore.list();
      return {
        ok: false,
        error: `No trace stored at ${path}.${known.length ? ` Known traces: ${known.join(', ')}.` : ' Record one first with a game_run record call.'}`,
      };
    }
    // The trace's own tick length is part of what makes a replay comparable, so
    // it wins over the default unless the caller deliberately overrides it.
    const effective: GameRunSpec = {
      until: spec?.until ?? [{ kind: 'frames', n: Math.max(1, trace.metrics.frames) }],
      ...(spec ?? {}),
      fixedDeltaSec: spec?.fixedDeltaSec ?? trace.env.fixedDeltaSec,
    };
    const preflight = this.preflight(effective);
    if ('error' in preflight) return { ok: false, error: preflight.error };
    const { runtime, spec: normalized } = preflight;
    const replayEnv = this.envelopeSeed(runtime.canvas, null);

    const replayed = await this.runSession(runtime.runner, deps =>
      replayTraceRun(deps, trace, normalized, {
        sink: new DomTraceInputSink(runtime.canvas, runtime.windowRef),
        compare: {
          ...options,
          // Deliberately without `seed`: the replay's seed is whatever the game
          // rolled this time and is not known here, and claiming it differs
          // would block strict comparison on no evidence.
          env: {
            runtimeVersion: replayEnv.runtimeVersion,
            viewport: replayEnv.viewport,
            sceneId: replayEnv.sceneId,
            fixedDeltaSec: normalized.fixedDeltaSec,
            ...options?.env,
          },
        },
        ...(spec ? {} : { noAssertions: true }),
      })
    );
    return { ...replayed.result, replay: replayed.comparison, tracePath: path };
  }

  /** Swap in a persistent backend — see {@link TraceStore} for the file seam. */
  setTraceStore(store: TraceStore): void {
    this.traceStore = store;
  }

  getTraceStore(): TraceStore {
    return this.traceStore;
  }

  /** Swap in the project-file routine store — same seam, same reason as the traces. */
  setRoutineStore(store: RoutineStore): void {
    this.routineStore = store;
  }

  getRoutineStore(): RoutineStore {
    return this.routineStore;
  }

  /**
   * Swap in the project-file policy store — same seam, same reason as the two above.
   * Delegated to the host rather than held here: the host is what reads a policy, and
   * two owners of one store is how a run ends up compiling last project's file.
   */
  setBotStore(store: BotStore): void {
    this.botHost.setStore(store);
  }

  getBotStore(): BotStore {
    return this.botHost.getStore();
  }

  /** Swap in the project-file report store — same seam, same reason as the two above. */
  setProtocolStore(store: RunProtocolStore | null): void {
    this.protocolStore = store;
  }

  getProtocolStore(): RunProtocolStore | null {
    return this.protocolStore;
  }

  /**
   * Execute a stored routine (§5.7): one tool call for a scenario that would
   * otherwise be re-typed as fifteen input steps in every iteration.
   *
   * Everything about *how* a routine behaves lives in `game-routines.ts` and is
   * unit-tested against a fake world; this method's whole job is to supply the live
   * world — the running scene's nodes, its command registry, its debug provider,
   * the real input path — and to refuse cleanly when there is nothing to run
   * against.
   *
   * The live world is handed to the driver through {@link recordRoutineWorld}, so
   * every reading it took lands in the artifact: a routine's reply carries the
   * outcome snapshot and a scalar diff, and the baseline snapshot it was diffed
   * against — the one a reader needs to disagree with the verdict — is only in the
   * file.
   */
  async runRoutine(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<RoutineRunResult & { artifact?: RunArtifactReport }> {
    if (!appState.ui.isPlaying) {
      return {
        ok: false,
        error:
          'The game is not running, and a routine drives the LIVE game. Call play_start first, then game_run {routine}.',
      };
    }
    const runtime = this.playSession.getActiveRuntime();
    if (!runtime) {
      return {
        ok: false,
        error: 'Play mode is starting but the runtime is not attached yet; retry in a moment.',
      };
    }

    let routine: GameRoutine | null;
    try {
      routine = await this.routineStore.load(name);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!routine) {
      const known = await this.routineStore
        .loadAll()
        .catch(() => ({ routines: [] as GameRoutine[], broken: [] }));
      return {
        ok: false,
        error: `No routine called "${name}" in ${ROUTINE_DIRECTORY}/. ${describeAvailableRoutines(known.routines)}`,
      };
    }

    const startedAt = new Date().toISOString();
    const reads: ProtocolRoutineRead[] = [];
    const world = this.buildRoutineWorld(runtime.runner);
    let result: RoutineRunResult;
    try {
      result = await runRoutine(recordRoutineWorld(world.world, reads), routine, args);
    } finally {
      world.dispose();
    }
    // A ROUTINE STALE refusal executed nothing, so there is no protocol — same rule
    // as `run()`'s `ok: false`.
    if (!result.ok) return result;

    // The verdict slug is derived from the report's own fields rather than parsed off
    // the verdict LINE: the wording is a sentence written for a human and rewording
    // it must not silently rename every file this writes.
    const verdict = result.routine?.macro
      ? 'macro'
      : (result.expectations ?? []).every(expectation => expectation.met)
        ? 'pass'
        : 'fail';
    const artifact = await saveRunProtocol(
      this.protocolStore,
      buildRunProtocolDocument({
        kind: 'routine',
        subject: `routine-${routine.name}`,
        startedAt,
        editorVersion: CURRENT_EDITOR_VERSION.version,
        sceneId: appState.scenes.activeSceneId,
        reply: protocolReply(result),
        // No frame loop ran, so there is no per-frame section: a routine's evidence is
        // the readings its driver took, and inventing an empty `main` section would
        // suggest a timeline that was never collected.
        sections: [],
        routine: { reads },
      }),
      { subject: `routine-${routine.name}`, verdict, frame: result.frames }
    );
    return { ...result, artifact };
  }

  /**
   * The live implementation of {@link RoutineWorld}.
   *
   * Two details are load-bearing. The **tick counter** is a `subscribeFrameStats`
   * subscription rather than a wall-clock estimate, so the report's `frames` is
   * what the game actually executed (a background tab throttles rAF, and a routine
   * that ran 3 ticks must not read as one that ran 180). And the **axis read** is
   * taken outside any poll-recording window: the runtime records `getAxis` names
   * only while `game_input` holds a window open, so sampling here — after the input
   * batch returned — cannot pollute `observedPolls`, the one field that separates
   * "the key was never pressed" from "the game never asks".
   */
  private buildRoutineWorld(runner: SceneRunner): { world: RoutineWorld; dispose: () => void } {
    let frames = 0;
    const frameSource = runner as unknown as {
      subscribeFrameStats?: (listener: () => void) => () => void;
    };
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe =
        typeof frameSource.subscribeFrameStats === 'function'
          ? frameSource.subscribeFrameStats(() => {
              frames += 1;
            })
          : null;
    } catch {
      unsubscribe = null;
    }

    const world: RoutineWorld = {
      nodeExists: query =>
        (runner.getLiveNodeById(query) ?? runner.findLiveNodeByName(query)) !== null,
      runInput: async (steps: RoutineInputStep[]) => {
        const result = await this.gameInput.run(steps);
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
      },
      dispatchCommand: (commandName, commandArgs) => {
        const registry = findCommandRegistry(runner);
        if (!registry) return null;
        try {
          return registry.dispatch(commandName, commandArgs)
            ? { ok: true }
            : {
                ok: false,
                error: `no registered handler took "${commandName}" — check it against the intents the scene registers (the game's debug provider lists them as actions).`,
              };
        } catch (error) {
          return {
            ok: false,
            error: `the "${commandName}" handler threw: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
      sampleGameState: (): RoutineGameSample | null => {
        const sample = readGameState();
        if (!sample || sample.snapshot === undefined) return null;
        return { name: sample.provider, snapshot: sample.snapshot };
      },
      errorCount: () => capturedErrors().length,
      errorsSince: from =>
        capturedErrors()
          .slice(from)
          .map(entry => ({ source: entry.source, message: entry.message })),
      snapshotNode: query => snapshotLiveNode(runner, query),
      readNodeProperty: (query, path) => readLiveNodeProperty(runner, query, path),
      countNodesOfType: type => countLiveNodesOfType(runner, type),
      readAxis: name => readLiveAxis(runner, name),
      readCommandJournal: () => {
        const registry = findCommandRegistry(runner);
        return registry ? { entries: registry.log, dropped: registry.droppedLogEntries } : null;
      },
      watchSignals: specs => new LiveSignalWatcher(() => runner.getLiveRootNodes(), specs),
      framesElapsed: () => frames,
      // `GameInputService` already waits its own settle window after each batch; this
      // is the extra breath a command step (which goes straight into the registry,
      // with no settle of its own) needs before the outcome frame is read.
      settle: () => new Promise<void>(resolve => setTimeout(resolve, ROUTINE_SETTLE_MS)),
    };

    return {
      world,
      dispose: () => {
        try {
          unsubscribe?.();
        } catch {
          /* a host that cannot unsubscribe must not fail the routine's report */
        }
      },
    };
  }

  /** Shared entry checks for every mode of the tool. */
  private preflight(spec: GameRunSpec):
    | {
        runtime: { runner: SceneRunner; canvas: HTMLCanvasElement; windowRef: Window };
        spec: NormalizedRunSpec;
      }
    | { error: string } {
    if (!appState.ui.isPlaying) {
      return { error: 'The game is not running. Call play_start first, then game_run.' };
    }
    const runtime = this.playSession.getActiveRuntime();
    if (!runtime) {
      return {
        error: 'Play mode is starting but the runtime is not attached yet; retry in a moment.',
      };
    }
    const validation = validateSpec(spec);
    if ('error' in validation) return { error: validation.error };
    return { runtime, spec: validation.spec };
  }

  /**
   * Run one loop under the host-pause discipline documented at the top of this
   * file, then re-check `leftPaused` against reality. Shared by every mode so a
   * recording or a replay cannot quietly skip the part that keeps the outcome
   * frame inspectable.
   */
  private async runSession<T extends { result: GameRunResult }>(
    runner: SceneRunner,
    execute: (deps: GameRunLoopDeps) => Promise<T>
  ): Promise<T>;
  private async runSession(
    runner: SceneRunner,
    execute: (deps: GameRunLoopDeps) => Promise<GameRunResult>
  ): Promise<GameRunResult>;
  private async runSession(
    runner: SceneRunner,
    execute: (deps: GameRunLoopDeps) => Promise<GameRunResult | { result: GameRunResult }>
  ): Promise<GameRunResult | { result: GameRunResult }> {
    const deps = this.buildDeps(runner);
    this.playSession.setFocusPauseSuppressed(true);
    let outcome: GameRunResult | { result: GameRunResult };
    try {
      outcome = await execute(deps);
    } finally {
      // Dropping the suppression makes the host re-evaluate the pause decision,
      // which is exactly the moment the outcome pause used to be lost. It cannot
      // be lost any more (the pause is host-owned now), but the report is
      // re-checked against reality afterwards regardless — this seam is where a
      // future resumer would appear, and it must show up as a note, not as a
      // quietly wrong `leftPaused`.
      this.playSession.setFocusPauseSuppressed(false);
    }
    const result = 'result' in outcome ? outcome.result : outcome;
    if (result.time && result.time.leftPaused !== runner.paused) {
      result.time.leftPaused = runner.paused;
      result.notes = [
        ...(result.notes ?? []),
        runner.paused
          ? 'The game ended up paused after the run despite the report, so what you observe is the outcome frame.'
          : 'The game was paused on the outcome frame but the editor resumed it as the run handed control back — what you observe now is a LATER state.',
      ];
    }
    return outcome;
  }

  /**
   * The half of the environment envelope the editor knows: version, canvas size,
   * active scene, and the seed if the caller supplied one. The rest (tick length,
   * provider name, the seed a game exposes itself) is filled in by the recorder
   * from the run.
   */
  private envelopeSeed(
    canvas: HTMLCanvasElement,
    seed: number | null | undefined
  ): TraceEnvelopeSeed {
    return {
      seed: seed ?? null,
      runtimeVersion: CURRENT_EDITOR_VERSION.version,
      viewport: {
        width: canvas.width || Math.round(canvas.getBoundingClientRect().width),
        height: canvas.height || Math.round(canvas.getBoundingClientRect().height),
      },
      sceneId: appState.scenes.activeSceneId,
    };
  }

  /**
   * Parse a raw tool payload into a spec. Kept on the service so the tool
   * registration stays a thin pass-through and the shape lives with the code that
   * understands it.
   */
  static parseSpec(raw: unknown): { spec: GameRunSpec & { input?: unknown } } | { error: string } {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { error: 'game_run takes an object: {until: [...], fail?: [...], maxFrames?: n}.' };
    }
    const record = raw as Record<string, unknown>;
    const until = parseAssertions(record.until, 'until');
    if ('error' in until) return { error: until.error };
    const fail = parseAssertions(record.fail, 'fail');
    if ('error' in fail) return { error: fail.error };
    const watch = Array.isArray(record.watch)
      ? record.watch.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : undefined;
    let monkey: NormalizedMonkeySpec | undefined;
    if (record.monkey !== undefined) {
      const parsed = parseMonkeySpec(record.monkey);
      if ('error' in parsed) return { error: parsed.error };
      monkey = parsed.spec;
    }
    let control: NegativeControlSpec | undefined;
    if (record.control !== undefined) {
      const parsed = parseNegativeControlSpec(record.control);
      if ('error' in parsed) return { error: parsed.error };
      control = parsed.spec;
    }
    let bot: NormalizedBotSpec | undefined;
    if (record.bot !== undefined) {
      const parsed = parseBotSpec(record.bot);
      if ('error' in parsed) return { error: parsed.error };
      bot = parsed.spec;
    }
    return {
      spec: {
        until: until.assertions,
        fail: fail.assertions,
        ...(watch?.length ? { watch } : {}),
        ...(monkey ? { monkey } : {}),
        ...(control ? { control } : {}),
        ...(bot ? { bot } : {}),
        ...(typeof record.maxFrames === 'number' ? { maxFrames: record.maxFrames } : {}),
        ...(typeof record.fixedDeltaSec === 'number'
          ? { fixedDeltaSec: record.fixedDeltaSec }
          : {}),
        ...(typeof record.maxWallMs === 'number' ? { maxWallMs: record.maxWallMs } : {}),
        ...(typeof record.pauseOnOutcome === 'boolean'
          ? { pauseOnOutcome: record.pauseOnOutcome }
          : {}),
        ...(record.input !== undefined ? { input: record.input } : {}),
      },
    };
  }

  private buildDeps(runner: SceneRunner): GameRunLoopDeps {
    return {
      runner: runner as unknown as TestableRunner,
      sampleGameState: readGameState,
      errorCount: () => capturedErrors().length,
      errorsSince: from =>
        capturedErrors()
          .slice(from)
          .map(entry => ({ source: entry.source, message: entry.message })),
      nodeExists: query =>
        (runner.getLiveNodeById(query) ?? runner.findLiveNodeByName(query)) !== null,
      // The four per-predicate readers, the same live functions the routine world is
      // built from (`buildRoutineWorld`) — one definition of "where the node is",
      // "what that property reads", "how many of that type are alive" and "what the
      // axis says", used by both the frame loop and the routine driver.
      snapshotNode: query => snapshotLiveNode(runner, query),
      readNodeProperty: (query, path) => readLiveNodeProperty(runner, query, path),
      countNodesOfType: type => countLiveNodesOfType(runner, type),
      readAxis: name => readLiveAxis(runner, name),
      readCommandJournal: () => {
        const registry = findCommandRegistry(runner);
        return registry ? { entries: registry.log, dropped: registry.droppedLogEntries } : null;
      },
      watchSignals: specs => new LiveSignalWatcher(() => runner.getLiveRootNodes(), specs),
      setHostPaused: paused => this.playSession.setPauseRequested(paused),
      now: () => performance.now(),
      // A macrotask, not a microtask: a microtask queue drain never lets the host
      // paint or deliver events, so the editor would still look frozen.
      yieldToHost: () => new Promise<void>(resolve => setTimeout(resolve, 0)),
    };
  }
}

/**
 * The running scene's command registry, reached the only way the editor can: the
 * runner keeps its `SceneService` private, but every live node carries it
 * (`node.scene`, injected into each root at start and inherited by children), so
 * any root is a handle on the registry the scripts dispatch through.
 */
function findCommandRegistry(runner: SceneRunner): LiveCommandRegistry | null {
  for (const root of runner.getLiveRootNodes()) {
    const commands = root.scene?.commands;
    if (commands) return commands;
  }
  return null;
}

/**
 * The slice of the scene's command registry the loop uses: the journal for the
 * `command` predicate, and list/dispatch for a monkey run. Structural so the loop's
 * spec can fake it, and narrow so nothing else of the registry leaks in here.
 */
interface LiveCommandRegistry {
  readonly log: readonly GameCommandLogEntry[];
  readonly droppedLogEntries: number;
  list(): Array<{ name: string }>;
  dispatch(name: string, args?: Record<string, unknown>): boolean;
}

// ---------------------------------------------------------------------------
// Monkey execution: the three channels
// ---------------------------------------------------------------------------

/** Action names that mean *input* rather than an intent, per §5.5's vocabulary. */
const INPUT_ACTION_NAME = /^(Key_|Action_|Axis_)/;

/**
 * What the game declares through its debug provider, split by what the name means.
 *
 * `actions()` is documented to answer from the command registry, so most of what
 * comes back is intents — but the same channel is where a game states the input
 * actions it reads, and the two are pressed completely differently. Splitting on the
 * `Key_`/`Action_`/`Axis_` prefix keeps a game from having to choose.
 */
function readDeclaredActions(): { commands: string[]; inputActions: string[] } {
  let declared: readonly string[] = [];
  try {
    declared = getGameDebug()?.actions?.() ?? [];
  } catch {
    // A provider that throws while listing its own actions must not end the run;
    // the monkey simply has fewer candidates, and the scene listing still stands.
    declared = [];
  }
  const commands: string[] = [];
  const inputActions: string[] = [];
  for (const name of declared) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (INPUT_ACTION_NAME.test(name)) inputActions.push(name);
    else commands.push(name);
  }
  return { commands, inputActions };
}

function executeMonkeyAction(
  runner: SceneRunner,
  sink: TraceInputSink,
  holdUntil: (frame: number, release: () => void) => void,
  action: MonkeyAction,
  frame: number
): MonkeyExecution {
  switch (action.kind) {
    case 'interaction': {
      const node = runner.getLiveNodeById(action.node) ?? runner.findLiveNodeByName(action.node);
      if (!node) {
        return { status: 'refused', note: `no live node named "${action.node}" any more` };
      }
      const owner = findInteractionOwner(node, action.interaction);
      if (!owner) {
        return {
          status: 'refused',
          note: `"${action.node}" no longer offers "${action.interaction}"`,
        };
      }
      return owner.invokeInteraction(action.interaction, action.args)
        ? { status: 'sent' }
        : {
            status: 'refused',
            note: 'the control itself refused it (disabled, or an argument it would not take)',
          };
    }
    case 'command': {
      const registry = findCommandRegistry(runner);
      if (!registry) {
        return { status: 'refused', note: 'the scene no longer exposes a command registry' };
      }
      return registry.dispatch(action.name)
        ? { status: 'sent' }
        : { status: 'refused', note: 'no registered handler took it' };
    }
    case 'action': {
      const code = keyCodeOf(action.name);
      if (code) {
        sink.key('down', code);
        holdUntil(frame + action.frames, () => sink.key('up', code));
        return { status: 'sent' };
      }
      // Not a key: there is no physical gesture that raises an arbitrary named
      // action, so it is set on the input service directly. That is the
      // `direct-action` channel of §5.3 — it exercises the game logic and proves
      // nothing about a binding, which is why the log says so.
      const input = resolveLiveInput(runner);
      if (!input) {
        return {
          status: 'refused',
          note: `"${action.name}" is not a Key_* action and no live InputService could be reached to set it directly`,
        };
      }
      input.setButton(action.name, true);
      holdUntil(frame + action.frames, () => input.setButton(action.name, false));
      return { status: 'sent', note: 'set directly on the input service, not as a real gesture' };
    }
    default:
      return { status: 'refused', note: 'unknown action shape' };
  }
}

/**
 * Who answers to this interaction on this node — the node itself (an engine
 * control) or one of its script components. Resolved per press rather than cached,
 * because a monkey run outlives the nodes it presses.
 */
function findInteractionOwner(node: NodeBase, interaction: string): Interactive | null {
  const offers = (candidate: unknown): Interactive | null => {
    if (!isInteractive(candidate)) return null;
    try {
      return candidate.getInteractions().some(entry => entry.name === interaction)
        ? candidate
        : null;
    } catch {
      return null;
    }
  };
  const own = offers(node);
  if (own) return own;
  for (const component of node.components ?? []) {
    const found = offers(component);
    if (found) return found;
  }
  return null;
}

/** The live `InputService`, reached the same way the listing reaches it: through a root node. */
function resolveLiveInput(
  runner: SceneRunner
): { setButton(name: string, pressed: boolean): void } | null {
  for (const root of runner.getLiveRootNodes()) {
    const input = (root as { input?: unknown }).input as
      | { setButton?: (name: string, pressed: boolean) => void }
      | undefined;
    if (input && typeof input.setButton === 'function') {
      return input as { setButton(name: string, pressed: boolean): void };
    }
  }
  return null;
}

/**
 * `Key_ArrowLeft` → `ArrowLeft`. A single character is expanded to its
 * `KeyboardEvent.code` (`Key_A` → `KeyA`, `Key_1` → `Digit1`) because the runtime
 * raises BOTH `Key_${code}` and `Key_${key.toUpperCase()}`, so a game may well have
 * been observed polling the short form — and dispatching `code: 'A'` would be a
 * code no keyboard produces.
 */
function keyCodeOf(action: string): string | null {
  if (!action.startsWith('Key_')) return null;
  const rest = action.slice(4);
  if (rest.length === 0) return null;
  if (rest.length === 1) {
    if (/[A-Za-z]/.test(rest)) return `Key${rest.toUpperCase()}`;
    if (/[0-9]/.test(rest)) return `Digit${rest}`;
  }
  return rest;
}

/** Backing-store pixels to canvas-box fractions, or null when the canvas has no size. */
function toCanvasFraction(
  canvas: HTMLCanvasElement,
  backing: { x: number; y: number }
): { nx: number; ny: number } | null {
  const rect = canvas.getBoundingClientRect();
  const width = canvas.width > 0 ? canvas.width : rect.width;
  const height = canvas.height > 0 ? canvas.height : rect.height;
  if (!(width > 0) || !(height > 0)) return null;
  return { nx: backing.x / width, ny: backing.y / height };
}

/** A release that throws must not take the rest of the holds (or the run) with it. */
function release(hold: { release: () => void }): void {
  try {
    hold.release();
  } catch {
    // The game is being handed back either way; a stuck key is reported by the
    // run's own error channel if it matters.
  }
}

// ---------------------------------------------------------------------------
// Negative control: the loop's half of `game-control.ts`
// ---------------------------------------------------------------------------

/**
 * The game's own `reset(seed)`, when it has one.
 *
 * Duck-typed on purpose: `reset` is an optional part of the test manifest (§5.5)
 * that a game may carry ahead of the runtime's own type, and the alternative —
 * guessing at a command name like `restart` — is exactly the name-hunting the
 * declared contract exists to end. No `reset` simply means the fallback (a scene
 * restart) is used and *named* in the report.
 */
function resolveGameReset(): ((seed?: number) => void | Promise<void>) | null {
  const provider = getGameDebug() as
    | { reset?: (seed?: number) => void | Promise<void> }
    | null
    | undefined;
  if (!provider || typeof provider.reset !== 'function') return null;
  const reset = provider.reset.bind(provider);
  return seed => reset(seed);
}

/** The negative gesture as frame-stamped events: down before frame 1, up when the hold ends. */
function controlGestureEvents(control: NegativeControlSpec): TraceEvent[] {
  const { nx, ny } = control.tap;
  return [
    { frame: 1, kind: 'pointer', phase: 'down', nx, ny },
    { frame: 1 + control.holdFrames, kind: 'pointer', phase: 'up', nx, ny },
  ];
}

/** The outcome kinds `game-control.ts` judges; everything else is `error` to it. */
const CONTROL_OUTCOME_KINDS = new Set<GameRunOutcomeKind>([
  'until',
  'fail',
  'timeout',
  'error',
  'precondition-already-met',
]);

/** Translate the loop's outcome into the vocabulary the judgement speaks. */
function toControlOutcome(outcome: GameRunOutcome | undefined): ControlRunOutcome | null {
  if (!outcome) return null;
  return {
    // The driven-mode kinds cannot occur here: a control run carries neither a monkey
    // nor a policy (both are deleted from its spec, because the control's meaning is
    // that nothing else touched the game). Mapping them to `error` rather than
    // widening the judgement's vocabulary keeps its three-valued promise if one ever
    // does arrive — an unrecognised kind must read as "could not decide", never as a
    // control that passed.
    kind: CONTROL_OUTCOME_KINDS.has(outcome.kind)
      ? (outcome.kind as ControlRunOutcome['kind'])
      : 'error',
    frame: outcome.frame,
    ...(outcome.index !== undefined ? { index: outcome.index } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  };
}

/**
 * Stand-in for a main baseline that never arrived (a loop that threw before frame
 * 0). Every fingerprint drawn from it is "(not measured)", so the comparison
 * reports drift rather than silently agreeing with an empty control baseline.
 */
function emptyBaseline(): AssertionBaseline {
  return { frame: 0, gameTimeMs: 0, gameState: null, presentNodes: new Set(), newErrorCount: 0 };
}

/**
 * Put the control's finding on the line that gets read (§6 rule 6).
 *
 * A passed control is stated as plainly as a failed one: the reader's next action
 * differs for each of the four cases, and only the verdict line is guaranteed to be
 * read at all.
 */
function markControlStrength(result: GameRunResult, input: ControlStrengthInput): GameRunResult {
  const strength = assessControlStrength(input);
  if (!result.verdict) return result;
  if (strength.marker) {
    result.verdict = `${result.verdict} ${strength.marker}: ${strength.note ?? ''}`.trim();
  } else if (input.judgement?.verdict === 'passed') {
    result.verdict = `${result.verdict} NEGATIVE CONTROL PASSED: ${input.judgement.note}.`;
  }
  return result;
}

/** Mutable half of a {@link SignalObservation}; `observations()` publishes copies. */
interface SignalRecord {
  spec: SignalWatchSpec;
  count: number;
  firstFrame: number;
  lastFrame: number;
  emitters: Set<string>;
  emitterOverflow: boolean;
  attached: Set<NodeBase>;
  everAttached: boolean;
  attachOverflow: boolean;
}

/**
 * Subscribes to the signals a run asserts on, for exactly the run.
 *
 * Three details are load-bearing:
 *
 * 1. **Per-node listeners, deduped by us.** `NodeBase.connect` dedupes on
 *    `(target, method)` identity, and a listener has to close over its node to
 *    report who emitted — so a fresh closure per sweep would silently attach a
 *    second listener and double every count. The `attached` set is what makes
 *    re-sweeping safe.
 * 2. **Re-sweeping at all** is what lets `signal('died')` hear an enemy that did
 *    not exist at the baseline. It costs a scene walk, so it is skipped entirely
 *    once every watch is scoped to a node that has already resolved — the checkbox
 *    case, which is the common one.
 * 3. **Disposal is not optional.** Every listener holds a node reference and would
 *    keep recording into a finished run's records; the loop's `finally` calls
 *    `dispose()` before it restores the time mode, so nothing can be heard after
 *    the last frame.
 */
export class LiveSignalWatcher implements SignalWatcher {
  private readonly records = new Map<string, SignalRecord>();
  private readonly connections: Array<{
    node: NodeBase;
    name: string;
    method: (...args: unknown[]) => void;
  }> = [];
  private frame = 0;
  private disposed = false;

  constructor(
    private readonly roots: () => readonly NodeBase[],
    specs: readonly SignalWatchSpec[]
  ) {
    for (const spec of specs) {
      this.records.set(signalWatchKey(spec), {
        spec,
        count: 0,
        firstFrame: 0,
        lastFrame: 0,
        emitters: new Set(),
        emitterOverflow: false,
        attached: new Set(),
        everAttached: false,
        attachOverflow: false,
      });
    }
    this.sweep(0);
  }

  sweep(frame: number): void {
    if (this.disposed) return;
    this.frame = frame;
    const pending = [...this.records.values()].filter(
      record => record.spec.node === undefined || record.attached.size === 0
    );
    if (pending.length === 0) return;

    let visited = 0;
    const stack: NodeBase[] = [...this.roots()];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (visited >= MAX_SIGNAL_SWEEP_NODES) {
        for (const record of pending) record.attachOverflow = true;
        return;
      }
      visited += 1;
      for (const record of pending) {
        const scope = record.spec.node;
        if (scope !== undefined && node.name !== scope && node.nodeId !== scope) continue;
        this.attach(record, node);
      }
      for (const child of node.children) {
        if (child instanceof NodeBase) stack.push(child);
      }
    }
  }

  observations(): ReadonlyMap<string, SignalObservation> {
    const out = new Map<string, SignalObservation>();
    for (const [key, record] of this.records) {
      out.set(key, {
        count: record.count,
        firstFrame: record.firstFrame,
        lastFrame: record.lastFrame,
        emitters: [...record.emitters],
        ...(record.emitterOverflow ? { emitterOverflow: true } : {}),
        attached: record.attached.size,
        everAttached: record.everAttached,
        ...(record.attachOverflow ? { attachOverflow: true } : {}),
      });
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { node, name, method } of this.connections) {
      node.disconnect(name, this, method);
    }
    this.connections.length = 0;
    for (const record of this.records.values()) record.attached.clear();
  }

  private attach(record: SignalRecord, node: NodeBase): void {
    if (record.attached.has(node)) return;
    record.attached.add(node);
    record.everAttached = true;
    const method = (): void => this.record(record, node);
    node.connect(record.spec.name, this, method);
    this.connections.push({ node, name: record.spec.name, method });
  }

  private record(record: SignalRecord, node: NodeBase): void {
    if (this.disposed) return;
    record.count += 1;
    if (record.count === 1) record.firstFrame = this.frame;
    record.lastFrame = this.frame;
    const who = node.name || node.nodeId;
    if (record.emitters.has(who)) return;
    if (record.emitters.size >= MAX_SIGNAL_EMITTERS) {
      record.emitterOverflow = true;
      return;
    }
    record.emitters.add(who);
  }
}

// ---------------------------------------------------------------------------
// Live-node readers for routine expectations
// ---------------------------------------------------------------------------

/** The live node a query names, by id first (unique) and then by name. */
function findLiveNode(runner: SceneRunner, query: string): NodeBase | null {
  return runner.getLiveNodeById(query) ?? runner.findLiveNodeByName(query) ?? null;
}

/**
 * The transform snapshot `nodeMoved` measures displacement from.
 *
 * Only the fields the predicate reads are meaningful here (`worldPosition` is the
 * one it uses); the rest of {@link LiveNodeSnapshot} is filled from the node so the
 * record is the same shape the input layer produces and no second "where is a node"
 * struct enters the codebase.
 */
function snapshotLiveNode(runner: SceneRunner, query: string): LiveNodeSnapshot | null {
  const node = findLiveNode(runner, query);
  if (!node) return null;
  const world = node.getWorldPosition(new Vector3());
  const children = node.children.filter((child): child is NodeBase => child instanceof NodeBase);
  return {
    nodeId: node.nodeId,
    name: node.name,
    type: node.type,
    visible: node.visible,
    position: { x: node.position.x, y: node.position.y, z: node.position.z },
    worldPosition: { x: world.x, y: world.y, z: world.z },
    rotationZ: node.rotation.z,
    scale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
    childCount: children.length,
    visibleChildCount: children.filter(child => child.visible).length,
  };
}

/**
 * A dot path into a live node's own properties (`checked`, `visible`, `position.x`).
 *
 * Read straight off the node rather than through the property schema: a routine's
 * post-condition is about the state the game is in, and the schema's `getValue`
 * closures are an editor-side projection of that state which a headless expectation
 * has no business depending on. `undefined` means "no node, or no such property" —
 * the predicate turns those two into different sentences using `presentNodes`.
 */
function readLiveNodeProperty(runner: SceneRunner, query: string, path: string): Json | undefined {
  const node = findLiveNode(runner, query);
  if (!node) return undefined;
  let current: unknown = node;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined || typeof current === 'function') return undefined;
  // Serialized with the same depth cap as every other agent-facing reading, so a
  // path that happens to land on a Three.js object cannot dump a scene graph.
  return safeSerialize(current, 2);
}

/** Live nodes whose `type` matches — the pooling-proof reading of `nodeAppeared`. */
function countLiveNodesOfType(runner: SceneRunner, type: string): number {
  let count = 0;
  const visit = (node: NodeBase): void => {
    if (node.type === type) count += 1;
    for (const child of node.children) {
      if (child instanceof NodeBase) visit(child);
    }
  };
  for (const root of runner.getLiveRootNodes()) visit(root);
  return count;
}

/**
 * One input-axis reading, taken **outside** any poll-recording window.
 *
 * `InputService.getAxis` records the names it is asked for while a harness window is
 * open, and that recording is `input.observedPolls` — the one field that separates
 * "the key was never pressed" from "the game never asks". Windows are opened and
 * closed inside `GameInputService`'s own methods, so neither the frame loop (which
 * refuses input steps) nor a routine (which samples after its input batch returned)
 * has one open, and this read cannot pollute the diagnostic. Anything that starts
 * sampling axes *while* a window is open has to bypass `getAxis`, not reuse this.
 */
function readLiveAxis(runner: SceneRunner, name: string): number | undefined {
  const input = resolveLiveInput(runner) as { getAxis?: (name: string) => number } | null;
  try {
    const value = input?.getAxis?.(name);
    return typeof value === 'number' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** One reading of the registered GameDebugProvider (null when the game registered none). */
function readGameState(): GameStateSample | null {
  const provider = getGameDebug();
  if (!provider?.snapshot) return null;
  try {
    return {
      provider: provider.name,
      snapshot: safeSerialize(provider.snapshot(), GAME_SNAPSHOT_DEPTH),
    };
  } catch (err) {
    return { provider: provider.name, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Traces: record and replay (§5.2)
// ---------------------------------------------------------------------------

/** The envelope fields the editor supplies; the recorder fills in the rest. */
export type TraceEnvelopeSeed = Pick<
  TraceEnvelope,
  'seed' | 'runtimeVersion' | 'viewport' | 'sceneId'
>;

export interface GameTraceRecordResult extends GameRunResult {
  trace?: GameInputTrace;
  tracePath?: string;
}

export interface GameTraceReplayResult extends GameRunResult {
  replay?: TraceComparison;
  tracePath?: string;
}

export interface RecordTraceOptions {
  name: string;
  env: TraceEnvelopeSeed;
  /** Where recorded events are heard. */
  source: TraceEventSource;
  /** Frame-denominated events to drive while recording (optional). */
  feed?: readonly TraceEvent[];
  /** Where `feed` events are dispatched. Required when `feed` is given. */
  sink?: TraceInputSink;
  /** Injected in specs; defaults to `globalThis`. */
  probeTarget?: ProbeTarget;
  now?: () => Date;
}

/**
 * Run the loop while recording input in frames and watching for nondeterminism.
 *
 * The probe is installed around the *whole* run and disposed in a `finally`, so
 * neither an assertion throw nor a runner that stops mid-run can leave the
 * wrappers installed. Arming happens per tick (`beforeFrame`/`afterFrame`), which
 * is what keeps the harness's own clock reads out of the counts.
 */
export async function recordTraceRun(
  deps: GameRunLoopDeps,
  spec: NormalizedRunSpec,
  options: RecordTraceOptions
): Promise<{ result: GameRunResult; trace: GameInputTrace }> {
  const recorder = new TraceRecorder(options.source);
  const probe: NondeterminismProbe = installNondeterminismProbe(options.probeTarget);
  const feed = options.feed ?? [];
  const feeder = feed.length && options.sink ? makeTraceFeeder(feed, options.sink) : null;
  const notes: string[] = [];
  let ticksPerFrame = 1;

  let result: GameRunResult;
  try {
    recorder.start();
    result = await runGameTestLoop(
      {
        ...deps,
        beforeFrame: frame => {
          // Order matters: stamp first so anything the feeder dispatches is
          // recorded on this frame, arm last so the dispatch itself (harness
          // work) is not counted as the game's.
          recorder.markFrame(frame);
          if (frame === 1) ticksPerFrame = deps.runner.getTimeMode().ticksPerFrame;
          feeder?.before(frame);
          probe.beginTick();
        },
        afterFrame: () => probe.endTick(),
      },
      spec
    );
  } finally {
    // Both are idempotent, and both must happen even when the loop throws: a
    // probe left installed would keep counting into a finished run, and a
    // recorder left started would keep DOM listeners alive for the session.
    probe.dispose();
    recorder.stop();
  }

  const captured = recorder.stop();
  let events = captured.events;
  if (feeder && events.length === 0 && feeder.dispatched > 0) {
    // The events were dispatched but nothing heard them — a canvas with no
    // layout box (headless/hidden host) drops pointers on the floor. Store what
    // was driven rather than an empty trace, and say which one this is: a trace
    // whose events the game may never have received will diverge on replay, and
    // that divergence has to be attributable.
    events = [...feed];
    notes.push(
      `Nothing was heard on the recording channel although ${feeder.dispatched} event(s) were dispatched — the events stored here are the ones DRIVEN, not the ones observed reaching the game. Usually the game canvas has no layout box yet.`
    );
  } else if (feeder && events.length !== feeder.dispatched) {
    notes.push(
      `Recorded ${events.length} event(s) while ${feeder.dispatched} were dispatched (pointer moves are collapsed to one per frame, and events from outside this run's canvas are not heard).`
    );
  }
  if (captured.dropped > 0) {
    notes.push(
      `${captured.dropped} event(s) exceeded the recording cap and were dropped; the trace is incomplete after that point.`
    );
  }

  const determinism = probe.report();
  const trace = buildTraceFromRun({
    name: options.name,
    env: {
      ...options.env,
      seed: options.env.seed ?? readSeed(result.game?.snapshot),
      fixedDeltaSec: spec.fixedDeltaSec,
      ticksPerFrame,
      gameProvider: result.game?.provider ?? null,
    },
    events,
    ...(captured.dropped ? { droppedEvents: captured.dropped } : {}),
    result,
    determinism,
    ...(options.now ? { now: options.now } : {}),
    notes,
  });
  return { result, trace };
}

export interface ReplayTraceOptions {
  sink: TraceInputSink;
  compare?: CompareTraceOptions;
  /**
   * Set when the caller supplied no assertions and the replay is only
   * reproducing the recorded frame budget — the comparison then says so instead
   * of reporting an outcome mismatch the caller could not have avoided.
   */
  noAssertions?: boolean;
}

/** Replay a trace frame by frame and compare the run against the recording. */
export async function replayTraceRun(
  deps: GameRunLoopDeps,
  trace: GameInputTrace,
  spec: NormalizedRunSpec,
  options: ReplayTraceOptions
): Promise<{ result: GameRunResult; comparison: TraceComparison }> {
  const feeder = makeTraceFeeder(trace.events, options.sink);
  const result = await runGameTestLoop(
    { ...deps, beforeFrame: frame => feeder.before(frame) },
    spec
  );
  const comparison = compareTraceToRun(trace, result, options.compare);
  const undelivered = feeder.pending(result.outcome?.frame ?? 0);
  if (undelivered > 0) {
    comparison.notes.push(
      `The run ended on frame ${result.outcome?.frame ?? 0} with ${undelivered} trace event(s) still unplayed — the rest of the trace was never delivered.`
    );
  }
  if (options.noAssertions) {
    comparison.notes.push(
      'No `until`/`fail` predicates were supplied, so the replay only reproduced the recorded frame budget: the outcome kinds are compared but nothing was asserted about the game.'
    );
  }
  return { result, comparison };
}

/** A `seed` scalar the game exposes in its debug snapshot, if any. */
function readSeed(snapshot: Json | undefined): number | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const value = (snapshot as { [key: string]: Json }).seed;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

/** A spec with every budget resolved and clamped. */
export interface NormalizedRunSpec {
  until: GameAssertion[];
  fail: GameAssertion[];
  watch: string[];
  maxFrames: number;
  fixedDeltaSec: number;
  maxWallMs: number;
  pauseOnOutcome: boolean;
  monkey?: NormalizedMonkeySpec;
  control?: NegativeControlSpec;
  bot?: NormalizedBotSpec;
}

export function validateSpec(spec: GameRunSpec): { spec: NormalizedRunSpec } | { error: string } {
  // A bot run supplies its own terminator — the policy's `done()` — so `until`
  // becomes the budget rather than the experiment, and the frame budget is already
  // spelled `maxFrames`. Filling it in here instead of demanding it from the caller
  // keeps the two from being written twice with different numbers, which is the one
  // way a run can end for a reason nobody chose.
  if (spec.bot && (!Array.isArray(spec.until) || spec.until.length === 0)) {
    const budget = clampInt(spec.maxFrames, DEFAULT_MAX_FRAMES, 1, MAX_MAX_FRAMES);
    spec = { ...spec, until: [{ kind: 'frames', n: budget }] };
  }
  if (spec.bot && spec.monkey) {
    return {
      error:
        'game_run cannot combine `bot` with `monkey`: one is a written policy and the other is random input, and a run driven by both could not attribute a single finding to either. Run them separately — the monkey first, as the zero test, then the policy.',
    };
  }
  if (!Array.isArray(spec.until) || spec.until.length === 0) {
    return {
      error:
        'game_run needs at least one `until` assertion — the condition whose arrival ends the run. Use {kind: "frames", n: 300} if you only want to run for a while.',
    };
  }
  if (spec.fixedDeltaSec !== undefined) {
    if (!Number.isFinite(spec.fixedDeltaSec) || spec.fixedDeltaSec <= 0) {
      return { error: '`fixedDeltaSec` must be a finite number greater than 0.' };
    }
  }
  const fail = spec.fail ?? [];
  // The names the ASSERTIONS mention come first, and the caller's `watch` fills what
  // is left of the cap: a `watch` entry is timeline decoration, whereas a name a
  // predicate is judged on decides the verdict. Ordered the other way round, eight
  // decorative names would push `nodeGone: 'Player'` out of `presentNodes` and the
  // predicate would report the player as absent every frame.
  const watch = [
    ...new Set([...assertionNodeNames([...spec.until, ...fail]), ...(spec.watch ?? [])]),
  ]
    .filter(name => name.length > 0)
    .slice(0, MAX_TRACKED_NODES);
  return {
    spec: {
      until: spec.until,
      fail,
      watch,
      maxFrames: clampInt(spec.maxFrames, DEFAULT_MAX_FRAMES, 1, MAX_MAX_FRAMES),
      fixedDeltaSec: spec.fixedDeltaSec ?? DEFAULT_FIXED_DELTA_SEC,
      maxWallMs: clampInt(spec.maxWallMs, DEFAULT_MAX_WALL_MS, 100, MAX_MAX_WALL_MS),
      pauseOnOutcome: spec.pauseOnOutcome !== false,
      ...(spec.monkey ? { monkey: spec.monkey } : {}),
      ...(spec.control ? { control: spec.control } : {}),
      ...(spec.bot ? { bot: spec.bot } : {}),
    },
  };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Drive the runner frame by frame until the first outcome.
 *
 * Exported separately from the service so it can be tested against a fake runner
 * — the loop is the phase-2 deliverable, and a test of it must not need a scene,
 * a renderer or DI.
 */
export async function runGameTestLoop(
  deps: GameRunLoopDeps,
  spec: NormalizedRunSpec
): Promise<GameRunResult> {
  const { runner } = deps;
  const previousMode = runner.getTimeMode();
  const wasPaused = runner.paused;
  const startedAt = deps.now();
  const errorsBefore = deps.errorCount();
  const notes: string[] = [];

  let core: LoopCore;
  let leftPaused = wasPaused;
  let signalWatcher: SignalWatcher | null = null;
  try {
    runner.setTimeMode({
      mode: 'manual',
      fixedDeltaSec: spec.fixedDeltaSec,
      muteAudio: true,
    });
    // `stepFrames` returns 0 on a paused runner, so a run that started while the
    // focus-pause rule (or a previous run's `pauseOnOutcome`) had the game paused
    // would otherwise report a dead game. Resuming is safe: manual mode schedules
    // no animation frame, so nothing advances except our own steps. Release the
    // host-held pause first — otherwise the host re-applies it at the next focus
    // event and the run dies halfway through.
    if (runner.paused) {
      deps.setHostPaused?.(false);
      if (runner.paused) runner.resume();
      notes.push('The game was paused when the run started; it was resumed to step frames.');
    }
    // Open the signal window before the first tick, so a run's first frame is
    // already being listened to.
    const signalSpecs = assertionSignalWatches([...spec.until, ...spec.fail]);
    if (signalSpecs.length > 0) {
      if (deps.watchSignals) {
        signalWatcher = deps.watchSignals(signalSpecs);
      } else {
        notes.push(
          'This runtime cannot subscribe to signals, so every `signal` predicate will report that it was never listening.'
        );
      }
    }
    core = await drive(deps, spec, errorsBefore, startedAt, notes, signalWatcher);
  } finally {
    // Let go of anything the monkey was still holding, BEFORE the game is left
    // paused on the outcome frame: a key left down would be part of the state the
    // caller then inspects, and would keep driving the game the moment it resumes.
    deps.monkey?.releaseAll();
    // Same rule for the policy, and it also runs its `end` hook here — so a policy
    // that logs a summary gets to log it whatever ended the run, including a crash.
    deps.bot?.dispose();
    // Close the signal window FIRST. Restoring the time mode below can put the
    // game back into realtime, and an emission after the run's last frame that
    // still landed in a record would silently widen the window the report claims
    // to describe.
    signalWatcher?.dispose();
    // Pause BEFORE restoring the mode: in `manual` nothing can tick between the
    // two, whereas restoring realtime first would let the game run on for however
    // long the pause call takes to land.
    const shouldLeavePaused = spec.pauseOnOutcome || wasPaused;
    // Route it through the host when there is one: the host owns the pause
    // decision and re-applies it on every focus event, so a pause it does not
    // know about does not survive the end of this call.
    deps.setHostPaused?.(shouldLeavePaused);
    if (shouldLeavePaused && !runner.paused) runner.pause();
    runner.setTimeMode(previousMode);
    // The FACT, never the intent: if something resumed the game anyway, the
    // report has to say so — a run whose report lies about the frame the caller
    // is inspecting is worse than one that admits it could not hold it.
    leftPaused = runner.paused;
    if (shouldLeavePaused && !leftPaused) {
      notes.push(
        'pauseOnOutcome asked to leave the game paused on the outcome frame, but something resumed it — what you observe now is a LATER state, not the outcome frame.'
      );
    }
  }

  const wallMs = Math.round(deps.now() - startedAt);
  const newErrors = deps.errorsSince(errorsBefore);
  const time: GameRunTimeReport = {
    ranIn: 'manual',
    fixedDeltaSec: spec.fixedDeltaSec,
    restoredMode: previousMode.mode,
    leftPaused,
  };
  // Read AFTER the teardown above, so a summary the policy logs from its `end` hook
  // is in the report. `done()` cannot arrive that late — the session refuses a
  // verdict once teardown has begun, because a verdict after the outcome could not
  // have decided it, and a report whose `done` disagreed with `outcome.kind` would be
  // exactly the lie this whole layer is built to avoid.
  const botReport = deps.bot?.report();
  const outcome = resolveBotOutcome(resolveMonkeyOutcome(core.outcome, core.monkey), botReport);

  return {
    ok: true,
    verdict: composeVerdict(outcome, spec, core.unmetNotes, newErrors.length, botReport),
    outcome,
    metrics: {
      frames: outcome.frame,
      gameTimeMs: outcome.gameTimeMs,
      wallMs,
      newErrors: newErrors.length,
      framesPerSecond: wallMs > 0 ? Math.round((outcome.frame / wallMs) * 1000) : 0,
    },
    ...(core.game ? { game: core.game } : {}),
    ...(core.timeline.length ? { timeline: core.timeline } : {}),
    ...(core.timelineTruncated ? { timelineTruncated: true } : {}),
    time,
    newErrors,
    assertions: {
      until: spec.until.map(describeAssertion),
      fail: spec.fail.map(describeAssertion),
    },
    ...(core.notes.length ? { notes: core.notes } : {}),
    ...(core.monkey ? { monkey: core.monkey } : {}),
    ...(botReport ? { bot: botReport } : {}),
  };
}

/**
 * The slug that names the report file. It answers "which run was this" from an
 * `fs_list` alone, so a bot run says which policy played rather than just `run` —
 * three reports of three policies against the same scene are otherwise
 * indistinguishable until each is opened.
 */
function runSubject(spec: NormalizedRunSpec): string {
  if (spec.bot) return `bot-${spec.bot.name}`;
  return spec.monkey ? 'monkey' : 'run';
}

/**
 * Has the policy ended the run, and how?
 *
 * A crash is checked before a verdict: a policy that threw *after* calling `done`
 * still reached a verdict, but a policy that threw *while* deciding has produced an
 * unfinished thought, and reporting the throw is the only honest reading of it.
 *
 * The frame is deliberately NOT taken from the bot's own counter. The counter starts
 * when the session attaches and the outcome's frame is the loop's — they normally
 * agree, and when they do not (a tick between attach and the first loop frame) the
 * `gameTimeMs` of the outcome has to be derived from the same frame it reports. The
 * policy's own frame stays in the report, where the two can be compared.
 */
function readBotEnd(
  hooks: BotRunHooks | undefined
): Pick<GameRunOutcome, 'kind' | 'assertion' | 'detail'> | null {
  if (!hooks?.finished) return null;
  const crash = hooks.crash;
  if (crash) {
    return {
      kind: 'bot-error',
      assertion: 'bot policy threw',
      detail: `the policy threw at its own frame ${crash.frame}: ${crash.message}. This is a fault in the POLICY, not in the game — nothing about the game is claimed by this run`,
    };
  }
  const verdict = hooks.outcome;
  if (!verdict) return null;
  return {
    kind: verdict.pass ? 'bot-pass' : 'bot-fail',
    assertion: `bot done(${verdict.pass ? 'pass' : 'fail'})`,
    detail: `the policy ended the run at its own frame ${verdict.frame}: ${verdict.reason}`,
  };
}

/**
 * The `monkey-empty` rule, applied to a written policy: a bot that delivered no
 * actuator at all played no game, so a positive outcome cannot stand as one.
 *
 * The *finding* channels are left exactly as they are, same as for the monkey — a
 * crash, a tripped `fail` predicate or the policy's own `done(false)` is worth
 * reporting whoever caused it. What is rewritten is the PASS and the TIMEOUT, because
 * those two are precisely what an untouched game produces, and neither says whether a
 * single button was pressed. A `done(true)` from a policy that drove nothing is the
 * most dangerous of the three: it is a claim, in words, about a game it never played.
 */
function resolveBotOutcome(outcome: GameRunOutcome, bot: BotReport | undefined): GameRunOutcome {
  if (!bot || bot.sent > 0) return outcome;
  if (outcome.kind !== 'until' && outcome.kind !== 'timeout' && outcome.kind !== 'bot-pass') {
    return outcome;
  }
  const claimed =
    outcome.kind === 'bot-pass' && bot.done
      ? ` The policy did call done(pass) — "${bot.done.reason}" — but it never drove anything, so the claim rests on a game it did not play.`
      : outcome.kind === 'until'
        ? ` The run did end on until[${outcome.index}] ${outcome.assertion} at frame ${outcome.frame} (${outcome.detail}) — but nothing the policy did caused it, because the policy did nothing.`
        : '';
  return {
    kind: 'bot-idle',
    frame: outcome.frame,
    gameTimeMs: outcome.gameTimeMs,
    detail: `the policy "${bot.name}" actuated NOTHING over ${bot.frames} tick(s)${
      bot.refused > 0
        ? ` (all ${bot.refused} attempt(s) were refused — the reasons are in \`bot.log\`)`
        : ''
    }.${claimed}`,
  };
}

/**
 * One verdict line, and the bot's own sentence wins whenever the bot decided.
 *
 * Two shapes rather than a concatenation of both: when the policy ended the run its
 * verdict IS the finding (with the reason, the frame and the channel the criterion
 * asks for), and when something else ended it the policy is context — a clause, not a
 * competing headline. Two full verdicts in one line would leave the reader deciding
 * which of them to believe.
 */
function composeVerdict(
  outcome: GameRunOutcome,
  spec: NormalizedRunSpec,
  unmetNotes: string[],
  newErrorCount: number,
  bot: BotReport | undefined
): string {
  if (bot && outcome.kind.startsWith('bot-')) {
    return buildBotVerdict(bot, newErrorCount);
  }
  const base = buildVerdict(outcome, spec, unmetNotes, newErrorCount);
  if (!bot) return base;
  const unproven =
    bot.channel === 'direct-action'
      ? ' Actuated on direct-action, so no input binding is proven by this run.'
      : '';
  return `${base} The policy "${bot.name}" [${bot.channel}] drove ${bot.sent} action(s) over ${bot.frames} tick(s) and never reached a verdict of its own.${unproven}`;
}

/**
 * A monkey run that pressed nothing must not be reported as a pass (rule 3 of the
 * monkey module). The *finding* channels are left exactly as they are — a crash or
 * a tripped invariant is worth reporting whoever caused it — but a PASS or a
 * TIMEOUT becomes `monkey-empty`, because those two are precisely what a clean
 * 600-frame monkey run looks like, and nothing in them says whether a single
 * button was ever pressed.
 */
function resolveMonkeyOutcome(
  outcome: GameRunOutcome,
  monkey: MonkeyReport | undefined
): GameRunOutcome {
  if (!monkey?.note || (outcome.kind !== 'until' && outcome.kind !== 'timeout')) return outcome;
  const fired =
    outcome.kind === 'until'
      ? ` The run did end on until[${outcome.index}] ${outcome.assertion} at frame ${outcome.frame} (${outcome.detail}) — but nothing the monkey did caused it, because the monkey did nothing.`
      : '';
  return {
    kind: 'monkey-empty',
    frame: outcome.frame,
    gameTimeMs: outcome.gameTimeMs,
    detail: `${monkey.note}${fired}`,
  };
}

interface LoopCore {
  outcome: GameRunOutcome;
  game?: GameRunGameReport;
  timeline: GameRunTimelineEntry[];
  timelineTruncated: boolean;
  /** Present on monkey runs: seed, counts and the press log. */
  monkey?: MonkeyReport;
  notes: string[];
  /** Evidence for each `until` that never fired — the body of a TIMEOUT verdict. */
  unmetNotes: string[];
}

async function drive(
  deps: GameRunLoopDeps,
  spec: NormalizedRunSpec,
  errorsBefore: number,
  startedAt: number,
  notes: string[],
  signalWatcher: SignalWatcher | null = null
): Promise<LoopCore> {
  const { runner } = deps;
  const all = [...spec.until, ...spec.fail];
  // Predicates that read game state force a sample every frame; when none do, the
  // snapshot is only sampled occasionally, purely to give the timeline content.
  const stateEveryFrame = assertionsNeedGameState(all);
  const timeline = new Timeline();

  // -- what this run's predicates need collected, and nothing else --------------
  //
  // Every list here comes from the assertions themselves via the selectors in
  // `game-assertions.ts` — the same ones the routine driver uses — so the cost of a
  // reading is paid only by a run that asked for it. A `frames`-only run collects
  // none of the four and walks the scene zero times; a `nodeMoved` run pays for one
  // world-matrix snapshot per frame and still not for a type count.
  //
  // Where a reading is asked for and the host cannot take it, the loop says so in
  // `notes` once, up front. Without that the predicate's own "harness bug" sentence
  // would be the only clue, and it names the predicate rather than the missing
  // capability.
  const askedSnapshots = assertionSnapshotNames(all);
  const askedProperties = assertionPropertyReads(all);
  const askedTypeCounts = assertionTypeQueries(all);
  const askedAxes = assertionAxisNames(all);
  if (askedSnapshots.length > 0 && !deps.snapshotNode) {
    notes.push(
      'This runtime cannot capture node transforms, so every `nodeMoved` predicate reports that instead of a displacement.'
    );
  }
  if (askedProperties.length > 0 && !deps.readNodeProperty) {
    notes.push(
      'This runtime cannot read live node properties, so every `nodeProperty` predicate reports that instead of a value.'
    );
  }
  if (askedTypeCounts.length > 0 && !deps.countNodesOfType) {
    notes.push(
      'This runtime cannot count live nodes by type, so `nodeAppeared` falls back to its by-name reading and a pooled or duplicate spawn stays invisible.'
    );
  }
  if (askedAxes.length > 0 && !deps.readAxis) {
    notes.push(
      'This runtime cannot sample input axes, so every `axis` predicate reports that instead of a value.'
    );
  }
  const snapshotNames = deps.snapshotNode ? askedSnapshots : [];
  const propertyReads = deps.readNodeProperty ? askedProperties : [];
  const typeQueries = deps.countNodesOfType ? askedTypeCounts : [];
  const axisNames = deps.readAxis ? askedAxes : [];

  // -- monkey mode -------------------------------------------------------------
  let monkey: MonkeySession | null = null;
  if (spec.monkey) {
    if (deps.monkey) {
      monkey = new MonkeySession(deps.monkey, spec.monkey, deps.protocol);
    } else {
      notes.push(
        'A monkey run was asked for, but this runtime supplies no way to list or press the scene’s controls, so NOTHING was pressed — read the outcome as "the game ran untouched", not as a clean monkey run.'
      );
    }
  }

  const gameTimeMsAt = (frame: number): number =>
    Math.round(frame * spec.fixedDeltaSec * 1000 * 1000) / 1000;

  let sample = deps.sampleGameState();
  if (!sample) {
    notes.push(
      'No GameDebugProvider is registered by the running game, so no game state could be read. Register one with registerGameDebug() to make state assertions possible.'
    );
  }
  const baselineSample = sample;

  // -- command journal windowing ----------------------------------------------
  //
  // The journal is a ring buffer shared with the whole scene, so "since the
  // baseline" is a *position*, not a filter: `entries.length + dropped` is a
  // monotone count of everything ever pushed, and the difference between two
  // readings of it is exactly how many lines appeared during the run. Frame stamps
  // would be the wrong key — several dispatches share a frame, and the stamp comes
  // from the engine's frame counter, which did not start at this run's baseline.
  const needCommands = assertionsNeedCommands(all);
  const readJournal = needCommands ? deps.readCommandJournal : undefined;
  const baseReading = readJournal?.() ?? null;
  const baseTotal = baseReading ? baseReading.entries.length + baseReading.dropped : 0;
  // Copied, not referenced: the ring shifts, and a dispatching entry is amended in
  // place if its handler throws.
  const beforeWindow = (baseReading?.entries ?? [])
    .slice(-MAX_PRE_WINDOW_ENTRIES)
    .map(entry => ({ ...entry }));
  if (needCommands && !baseReading) {
    notes.push(
      'The running scene exposes no command registry, so no `command` predicate can match. A game opts in by registering intents from a script: scene.commands.register("open-menu", …), dispatched by the control handler.'
    );
  }

  // Mutable because a mid-run `clear()` (scene stopped or changed) restarts both
  // counters at zero. The rebase has to be *sticky*: without it the watermark
  // climbs back past the old baseline a few dispatches later and the window
  // silently starts excluding entries that are in fact in it.
  let commandBase = baseTotal;
  let commandReset = false;

  const commandWindow = (): CommandWindow | undefined => {
    if (!readJournal) return undefined;
    const reading = readJournal();
    if (!reading) return { entries: [], dropped: 0, available: false };
    const total = reading.entries.length + reading.dropped;
    if (total < commandBase) {
      commandReset = true;
      commandBase = 0;
    }
    const appended = total - commandBase;
    const kept = Math.min(appended, reading.entries.length);
    return {
      entries: reading.entries.slice(reading.entries.length - kept),
      // In-window lines the ring threw away before we read them. Surfaced so an
      // overflow can never read as "the command was never dispatched".
      dropped: appended - kept,
      available: true,
      ...(commandReset ? { reset: true } : {}),
      ...(beforeWindow.length ? { beforeWindow } : {}),
    };
  };

  const buildFrame = (frame: number, currentSample: GameStateSample | null): AssertionFrame => {
    const commands = commandWindow();
    // Each map is built only from the list its predicates put there, and is left
    // OFF the frame entirely when nothing asked — an absent map is what tells
    // `nodeMoved`/`nodeProperty`/`axis` "nobody collected this" (a harness fault)
    // apart from an empty one ("we looked and the node is not there"), which is a
    // real result about the game.
    const nodes = new Map<string, LiveNodeSnapshot>();
    for (const name of snapshotNames) {
      const snapshot = deps.snapshotNode?.(name) ?? null;
      if (snapshot) nodes.set(name, snapshot);
    }
    const nodeProperties = new Map<string, Json | undefined>();
    for (const read of propertyReads) {
      nodeProperties.set(read.key, deps.readNodeProperty?.(read.name, read.path));
    }
    const typeCounts = new Map<string, number>();
    for (const query of typeQueries) {
      typeCounts.set(query, deps.countNodesOfType?.(query) ?? 0);
    }
    const axes = new Map<string, number>();
    for (const name of axisNames) {
      const value = deps.readAxis?.(name);
      if (value !== undefined) axes.set(name, value);
    }
    return {
      frame,
      gameTimeMs: gameTimeMsAt(frame),
      gameState: currentSample?.snapshot ?? null,
      presentNodes: new Set(spec.watch.filter(name => deps.nodeExists(name))),
      newErrorCount: deps.errorCount() - errorsBefore,
      ...(commands ? { commands } : {}),
      ...(signalWatcher ? { signals: signalWatcher.observations() } : {}),
      // Keyed by the query the assertion used, not by nodeId: a node that dies and
      // is replaced by a same-named one is the same subject to a test. Attached
      // whenever a snapshot was ASKED for, even if it came back empty — an empty map
      // means "we looked and no node answers that name", which `nodeMoved` reports as
      // a name to check, whereas an absent map is a harness fault. Gating on
      // `nodes.size` would turn every misspelled name into the wrong sentence.
      ...(snapshotNames.length ? { nodes } : {}),
      // Same rule, and here it also carries the third state: a key present with an
      // `undefined` value is "read, and the node has no such property".
      ...(propertyReads.length ? { nodeProperties } : {}),
      ...(typeQueries.length ? { typeCounts } : {}),
      // Axes are the one exception: a reader that returns `undefined` did not manage
      // to sample, which is exactly what the predicate's "not sampled" branch is for.
      ...(axes.size ? { axes } : {}),
    };
  };

  const baseline: AssertionBaseline = buildFrame(0, baselineSample);
  // Handed out before the first tick: the negative control compares the two runs'
  // frame-0 records, and a baseline captured later would not be one.
  deps.onBaseline?.(baseline);
  // The recorder's first frame establishes its "previous" values and emits nothing;
  // feeding it the same record the predicates are judged against is what keeps the
  // artifact's deltas measured from the frame the report calls frame 0.
  deps.protocol?.frame(baseline);

  const finish = (outcome: GameRunOutcome, unmetNotes: string[] = []): LoopCore => {
    if (monkey) notes.push(...monkey.notes());
    return finishCore(outcome, unmetNotes);
  };

  const finishCore = (outcome: GameRunOutcome, unmetNotes: string[]): LoopCore => {
    // Re-read the provider at the outcome frame rather than reusing whatever the
    // loop last happened to sample. Without a state predicate the loop only
    // samples every STATE_SAMPLE_EVERY_FRAMES frames, so a run that ends on frame
    // 9 would otherwise diff the baseline against itself and report "nothing
    // changed" — a report that says the game did nothing because the harness did
    // not look is worse than no report.
    //
    // Read into a local and handed to BOTH consumers: the reply and the artifact
    // must never be able to describe different frames, and a second
    // `sampleGameState()` for the protocol would be exactly that.
    const outcomeSample = outcome.frame === 0 ? baselineSample : deps.sampleGameState();
    deps.protocol?.outcome({
      frame: outcome.frame,
      provider: outcomeSample?.provider ?? baselineSample?.provider ?? null,
      baseline: baselineSample?.snapshot ?? null,
      snapshot: outcomeSample?.snapshot ?? null,
    });
    return {
      ...(monkey ? { monkey: monkey.report() } : {}),
      outcome,
      ...(buildGameReport(baselineSample, outcomeSample) ?? {}),
      timeline: timeline.entries,
      timelineTruncated: timeline.truncated,
      notes,
      unmetNotes,
    };
  };

  // -- baseline rule (§5.2): decide BEFORE running -----------------------------
  //
  // A predicate that already holds on frame 0 proves nothing about the game: the
  // run would "pass" against a board that was already dirty. Reporting it as its
  // own outcome makes that structural instead of a heuristic the model has to
  // remember.
  const untilAtBaseline = firstMetAssertion(spec.until, baseline, baseline);
  if (untilAtBaseline) {
    return finish({
      kind: 'precondition-already-met',
      index: untilAtBaseline.index,
      channel: 'until',
      frame: 0,
      gameTimeMs: 0,
      assertion: describeAssertion(untilAtBaseline.assertion),
      detail: untilAtBaseline.outcome.detail,
    });
  }
  const failAtBaseline = firstMetAssertion(spec.fail, baseline, baseline);
  if (failAtBaseline) {
    // Symmetric to the rule above and for the same reason: a `fail` that is true
    // before the first tick makes every run fail on frame 1 without telling you
    // anything about the game. §5.2 spells the rule out only for `until`.
    return finish({
      kind: 'precondition-already-met',
      index: failAtBaseline.index,
      channel: 'fail',
      frame: 0,
      gameTimeMs: 0,
      assertion: describeAssertion(failAtBaseline.assertion),
      detail: failAtBaseline.outcome.detail,
    });
  }

  // -- the frame loop ----------------------------------------------------------
  let previousSample = baselineSample;
  let previousErrorCount = 0;
  let previousPresent = baseline.presentNodes;
  let frame = 0;

  while (frame < spec.maxFrames) {
    // Attach to anything that has spawned, and stamp what the coming frame emits
    // with that frame's number.
    signalWatcher?.sweep(frame + 1);
    // The monkey presses in the same gap the traces feed input through, and for the
    // same reason: an event dispatched here is polled by the game on exactly the
    // coming frame, whereas a wall-clock hold would deliver down and up with zero
    // ticks in between. Awaited because the inventory comes from the live control
    // listing — safe here, since `manual` time schedules no frame of its own.
    if (monkey) await monkey.before(frame + 1);
    // The inter-tick gap: input for the coming frame is dispatched here, and the
    // determinism probe is armed here, so everything counted between the two
    // hooks belongs to the tick and nothing of the harness can slip in (the loop
    // is synchronous — its own timers only run once the tick returns).
    deps.beforeFrame?.(frame + 1);
    let executed: number;
    try {
      executed = runner.stepFrames(1);
    } finally {
      deps.afterFrame?.(frame + 1);
    }
    if (executed !== 1) {
      return finish({
        kind: 'error',
        frame,
        gameTimeMs: gameTimeMsAt(frame),
        detail: runner.running
          ? `the runner stopped advancing at frame ${frame} (stepFrames returned ${executed}) — the game was paused or the call re-entered a tick`
          : `the runner stopped at frame ${frame} (the scene is no longer running)`,
      });
    }
    frame += 1;

    if (stateEveryFrame || frame % STATE_SAMPLE_EVERY_FRAMES === 0) {
      sample = deps.sampleGameState();
    }
    const current = buildFrame(frame, sample);

    // Hoisted out of the two calls below: `errorsSince` copies and slices the whole
    // captured-error ring, and the timeline and the protocol want the SAME first new
    // error — two reads could disagree about it if an error landed between them.
    const firstNewError = deps.errorsSince(errorsBefore + previousErrorCount)[0];
    recordTimeline(timeline, frame, {
      previousSample,
      sample,
      previousErrorCount,
      errorCount: current.newErrorCount,
      previousPresent,
      present: current.presentNodes,
      newError: firstNewError,
    });
    deps.protocol?.frame(current, firstNewError);
    previousSample = sample;
    previousErrorCount = current.newErrorCount;
    previousPresent = current.presentNodes;

    // `fail` is checked first: when a frame satisfies both channels, the run that
    // also threw an error (or lost the player) is the one worth reporting — a PASS
    // that quietly coincided with a crash is exactly the false green this harness
    // exists to prevent.
    const failed = firstMetAssertion(spec.fail, current, baseline);
    if (failed) {
      return finish({
        kind: 'fail',
        index: failed.index,
        channel: 'fail',
        frame,
        gameTimeMs: current.gameTimeMs,
        assertion: describeAssertion(failed.assertion),
        detail: failed.outcome.detail,
      });
    }
    // Invariants sit between the two channels on purpose. After `fail`, because an
    // explicit predicate is the author's own statement about this game and reads
    // better in a report; before `until`, because a run that crashed or froze must
    // never be reported as a PASS that happened to coincide with it.
    const violation = monkey?.check(current, baseline);
    if (violation) {
      return finish({
        kind: 'fail',
        frame,
        gameTimeMs: current.gameTimeMs,
        assertion: `monkey invariant: ${violation.kind}`,
        detail: violation.detail,
      });
    }
    // The policy's own verdict sits here for the same reason the monkey's invariants
    // do, one rung further in: after `fail`, because a crash predicate the caller
    // wrote for THIS run is stronger evidence than a stored policy's opinion; before
    // `until`, because a policy that has just declared the hero dead must not be
    // overruled by a predicate that happened to hold on the same frame.
    const botEnd = readBotEnd(deps.bot);
    if (botEnd) {
      return finish({ ...botEnd, frame, gameTimeMs: current.gameTimeMs });
    }
    const passed = firstMetAssertion(spec.until, current, baseline);
    if (passed) {
      return finish({
        kind: 'until',
        index: passed.index,
        channel: 'until',
        frame,
        gameTimeMs: current.gameTimeMs,
        assertion: describeAssertion(passed.assertion),
        detail: passed.outcome.detail,
      });
    }

    if (frame % YIELD_EVERY_FRAMES === 0) {
      if (deps.now() - startedAt > spec.maxWallMs) {
        return finish(
          {
            kind: 'timeout',
            frame,
            gameTimeMs: current.gameTimeMs,
            detail: `wall-clock budget of ${spec.maxWallMs}ms spent after ${frame} of ${spec.maxFrames} frames — the game is slower than real time under stepping, or the budget is too small`,
          },
          unmetDetails(spec.until, current, baseline)
        );
      }
      await deps.yieldToHost();
    }
  }

  const last = buildFrame(frame, sample);
  return finish(
    {
      kind: 'timeout',
      frame,
      gameTimeMs: last.gameTimeMs,
      detail: `no until predicate fired within the ${spec.maxFrames}-frame budget`,
    },
    unmetDetails(spec.until, last, baseline)
  );
}

// ---------------------------------------------------------------------------
// Monkey mode: the loop's half of `game-monkey.ts`
// ---------------------------------------------------------------------------

/**
 * Binds the seeded driver, the invariant monitor and the world to one run.
 *
 * It holds no policy of its own — every decision is the driver's and every
 * judgement is the monitor's. What it owns is the *ordering* the two need from a
 * frame loop: press in the gap before the frame the press belongs to, judge the
 * frame after it ran, and count the two ways a decision can come to nothing so the
 * report can tell them apart.
 */
class MonkeySession {
  private readonly driver: MonkeyDriver;
  private readonly monitor: MonkeyInvariantMonitor;
  /** Decision points where the scene offered nothing at all. */
  private empty = 0;
  /** Decision points where controls existed but none could be given valid arguments. */
  private undecided = 0;

  constructor(
    private readonly world: MonkeyWorld,
    spec: NormalizedMonkeySpec,
    /**
     * Where the COMPLETE press log goes. The driver's own log keeps a head and a
     * tail (20 + 40) because the reply has a context budget; the artifact has none,
     * and the presses in the dropped middle are exactly the ones a reproduction of
     * a late crash needs.
     */
    private readonly protocol?: RunProtocolSink
  ) {
    this.driver = new MonkeyDriver(spec);
    this.monitor = new MonkeyInvariantMonitor(spec.invariants);
  }

  /** Decide and press in the gap before `frame`; end any hold whose frames ran out. */
  async before(frame: number): Promise<void> {
    this.world.releaseDue(frame);
    if (!this.driver.shouldAct(frame)) return;
    const inventory = await this.world.inventory();
    const action = this.driver.decide(inventory);
    if (!action) {
      if (monkeyInventoryIsEmpty(inventory)) this.empty += 1;
      else this.undecided += 1;
      return;
    }
    let execution: MonkeyExecution;
    try {
      execution = await this.world.execute(action, frame);
    } catch (error) {
      execution = { status: 'error', note: error instanceof Error ? error.message : String(error) };
    }
    this.driver.log(frame, action, execution.status, execution.note);
    // Recorded as DATA, not as the driver's formatted line: that formatter is
    // private to `game-monkey.ts`, and a second copy of it here would give the file
    // and the reply two spellings of the same press.
    this.protocol?.monkeyAction({
      frame,
      action: protocolJson(action),
      status: execution.status,
      ...(execution.note ? { note: execution.note } : {}),
    });
  }

  /** Judge the frame that just ran. Returns the violation that ends the run, or null. */
  check(frame: AssertionFrame, baseline: AssertionBaseline) {
    return this.monitor.check(frame, baseline, this.driver.actionsSent);
  }

  report(): MonkeyReport {
    return this.driver.report();
  }

  /**
   * Caveats about the *pressing*, not about the game. The `undecided` one matters
   * more than it looks: a scene whose only controls need an argument the monkey has
   * no vocabulary for looks identical to a quiet game from the outside.
   */
  notes(): string[] {
    const notes: string[] = [];
    if (this.undecided > 0) {
      notes.push(
        `At ${this.undecided} decision point(s) the monkey could not build a usable action from the listed controls — every candidate interaction required an argument with no options, range or default to draw from. Those frames ran untouched.`
      );
    }
    if (this.empty > 0 && this.driver.actionsSent > 0) {
      notes.push(
        `At ${this.empty} decision point(s) the scene offered nothing pressable (a splash, a transition, or a screen whose controls are hidden), so those frames ran untouched.`
      );
    }
    return notes;
  }
}

/**
 * "Nothing to press" in the same terms the driver uses, so the loop's early notes
 * and the driver's own {@link MonkeyReport.note} can never disagree about it.
 */
function monkeyInventoryIsEmpty(inventory: MonkeyInventory): boolean {
  return (
    usableControls(inventory.controls).length === 0 &&
    inventory.commands.filter(name => name.length > 0).length === 0 &&
    inventory.actions.filter(name => name.length > 0).length === 0
  );
}

/** Evidence for every `until` that never fired — the body of a TIMEOUT verdict. */
function unmetDetails(
  assertions: readonly GameAssertion[],
  frame: AssertionFrame,
  baseline: AssertionBaseline
): string[] {
  return assertions.map(
    (assertion, index) =>
      `until[${index}] ${describeAssertion(assertion)} — ${evaluateAssertion(assertion, frame, baseline).detail}`
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

class Timeline {
  readonly entries: GameRunTimelineEntry[] = [];
  truncated = false;
  /** Dedup key of the last entry, so a value that ticks every frame folds into one row. */
  private lastKey: string | null = null;

  add(entry: GameRunTimelineEntry, key: string): void {
    if (this.lastKey === key && this.entries.length > 0) {
      const last = this.entries[this.entries.length - 1];
      last.count = (last.count ?? 1) + 1;
      last.note = entry.note;
      return;
    }
    if (this.entries.length >= MAX_TIMELINE_ENTRIES) {
      this.truncated = true;
      return;
    }
    this.entries.push(entry);
    this.lastKey = key;
  }
}

function recordTimeline(
  timeline: Timeline,
  frame: number,
  ctx: {
    previousSample: GameStateSample | null;
    sample: GameStateSample | null;
    previousErrorCount: number;
    errorCount: number;
    previousPresent: ReadonlySet<string>;
    present: ReadonlySet<string>;
    newError?: { source: string; message: string };
  }
): void {
  if (ctx.errorCount > ctx.previousErrorCount) {
    timeline.add(
      {
        frame,
        kind: 'error',
        note: (ctx.newError?.message ?? 'runtime error').slice(0, 120),
      },
      'error'
    );
  }
  for (const name of ctx.previousPresent) {
    if (!ctx.present.has(name)) timeline.add({ frame, kind: 'gone', note: name }, `gone:${name}`);
  }
  for (const name of ctx.present) {
    if (!ctx.previousPresent.has(name)) {
      timeline.add({ frame, kind: 'appeared', note: name }, `appeared:${name}`);
    }
  }
  if (
    ctx.previousSample?.snapshot !== undefined &&
    ctx.sample?.snapshot !== undefined &&
    ctx.previousSample !== ctx.sample
  ) {
    const changed = diffJsonPaths(ctx.previousSample.snapshot, ctx.sample.snapshot);
    let recorded = 0;
    for (const [path, [before, after]] of Object.entries(changed)) {
      if (recorded >= MAX_TIMELINE_PATHS_PER_FRAME) break;
      recorded += 1;
      timeline.add(
        { frame, kind: 'state', note: `${path} ${fmtScalar(before)}→${fmtScalar(after)}` },
        `state:${path}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function buildGameReport(
  baseline: GameStateSample | null,
  last: GameStateSample | null
): { game: GameRunGameReport } | null {
  if (!last) return null;
  const report: GameRunGameReport = { provider: last.provider, snapshot: last.snapshot ?? null };
  if (last.error) {
    report.error = last.error;
    return { game: report };
  }
  if (
    baseline &&
    !baseline.error &&
    baseline.snapshot !== undefined &&
    last.snapshot !== undefined
  ) {
    const changed = diffJsonPaths(baseline.snapshot, last.snapshot);
    if (Object.keys(changed).length) report.changed = changed;
  }
  return { game: report };
}

/**
 * The one line a model reads first (§6 rule 1): what happened, which predicate
 * decided it, on which frame, with the evidence. Every other field is detail it
 * can ask for.
 */
function buildVerdict(
  outcome: GameRunOutcome,
  spec: NormalizedRunSpec,
  unmetNotes: string[],
  newErrorCount: number
): string {
  const at = `frame ${outcome.frame}, ${(outcome.gameTimeMs / 1000).toFixed(2)}s game`;
  const errs = newErrorCount > 0 ? ` ${newErrorCount} new runtime error(s).` : '';
  const slot =
    outcome.index !== undefined && outcome.channel
      ? `${outcome.channel}[${outcome.index}] ${outcome.assertion}`
      : '';
  switch (outcome.kind) {
    case 'until':
      return `PASS ${slot} (${at}) — ${outcome.detail}.${errs}`;
    case 'fail':
      return `FAIL ${slot} (${at}) — ${outcome.detail}.${errs}`;
    case 'precondition-already-met':
      return `PRECONDITION ALREADY MET: ${slot} is ALREADY TRUE at frame 0 — ${outcome.detail}. The run never started and nothing was proven: the board was already in the state you were testing for. Reset the game (restart play mode), pick a condition that is false at the start, or assert the change instead of the value (gameStateChanged).`;
    case 'timeout':
      return `TIMEOUT after ${outcome.frame} frames (${(outcome.gameTimeMs / 1000).toFixed(2)}s game): ${outcome.detail}. ${unmetNotes.join('; ')}.${errs} Raise maxFrames (cap ${MAX_MAX_FRAMES}) if the event needs longer, or check that the game does what the predicate expects — nothing in \`fail\` fired either.`;
    case 'error':
      return `ERROR: ${outcome.detail} (${at}).${errs} The run was abandoned; ${spec.until.length} until predicate(s) were never decided.`;
    case 'monkey-empty':
      return `NOTHING TESTED (${at}): ${outcome.detail}${errs}`;
    default:
      return `UNKNOWN OUTCOME (${at}) — ${outcome.detail}.`;
  }
}

const isPlainObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fmtScalar = (value: Json): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');

/**
 * Dot-path diff between two Json snapshots down to `depth` object levels; scalar
 * leaves that differ become `path -> [before, after]`. Capped so a big snapshot
 * cannot blow up the payload (the same discipline as `MAX_GAME_DIFF_PATHS` in
 * `GameInputService`, deliberately duplicated rather than shared — that file is
 * the input harness, not a utility module).
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
