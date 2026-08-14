import type { Json } from '@/core/agent-introspection';
import type { GameRunOutcome, GameRunResult } from '@/services/agent/GameTestService';
import type {
  NondeterminismReport,
  NondeterminismSource,
} from '@/services/agent/nondeterminism-probe';

/**
 * Input traces: record a run's input in **frames**, replay it frame by frame,
 * and compare the two runs honestly (§5.2 of `.plans/agent-gameplay-testing.md`,
 * phase 6).
 *
 * Three decisions shape everything in this file.
 *
 * **1. Frames, not milliseconds.** A trace event carries the number of the frame
 * it belongs to, and the replay dispatches it *between* ticks — after frame N-1
 * has run and before frame N does. That is the delivery `GameInputService.run()`
 * structurally cannot provide: it paces steps with wall-clock `setTimeout`, and
 * in `'manual'` time mode no tick happens while those timers run, so a key hold
 * delivers keydown and keyup with zero frames in between and the game never
 * polls the key. The feeder here is driven by the frame loop itself, so "hold
 * left for 8 frames" means exactly that.
 *
 * **2. Replay is diagnostic, not deterministic.** It compares `outcome.kind` and
 * metrics *within tolerance*, never frame-for-frame identity, because the game
 * is entitled to call `Math.random`, read the clock and schedule timers. The
 * honesty mechanism is the {@link NondeterminismProbe}: a trace whose recording
 * caught such calls carries `nondeterministic`, and {@link compareTraceToRun}
 * then refuses the strict path and says so in the verdict. A report that implies
 * bit-for-bit reproducibility it cannot deliver is worse than no report.
 *
 * **3. Pointer coordinates are normalised to the canvas, not client pixels.** A
 * replay commonly runs against a canvas that moved or resized (a docked panel
 * changed width); client coordinates would then land somewhere else entirely,
 * while `nx`/`ny` in 0..1 of the canvas box survive it. What they do NOT survive
 * is a different design resolution or camera — the envelope records the viewport
 * size so the comparison can say so instead of silently drifting.
 *
 * Storage is an interface ({@link TraceStore}) with a working in-memory
 * implementation. The seam for the file backend is documented on it.
 */

/** Bumped when the on-disk shape changes incompatibly. */
export const TRACE_FORMAT_VERSION = 1;

/** Where traces live in a project (the templates already ship the directory). */
export const TRACE_DIRECTORY = 'design/tests';

/** Hard cap on recorded events, so a pointer-storm cannot produce a 40 MB file. */
export const MAX_TRACE_EVENTS = 2000;

/** Scalar leaves kept from the outcome snapshot for comparison. */
const MAX_TRACE_STATE_PATHS = 20;

/** Depth the outcome snapshot is flattened to (matches the loop's diff depth). */
const TRACE_STATE_DEPTH = 2;

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

export interface TraceKeyEvent {
  /** The frame this event is delivered before — see the module docs. */
  frame: number;
  kind: 'key';
  phase: 'down' | 'up';
  /** `KeyboardEvent.code`, e.g. `'ArrowLeft'`. */
  code: string;
}

export interface TracePointerEvent {
  frame: number;
  kind: 'pointer';
  phase: 'down' | 'move' | 'up';
  /** X in 0..1 of the canvas box (see module docs on why not client pixels). */
  nx: number;
  /** Y in 0..1 of the canvas box. */
  ny: number;
  pointerId?: number;
}

export type TraceEvent = TraceKeyEvent | TracePointerEvent;

/**
 * The environment the recording happened in. Its job is to let a replay *say*
 * what drifted rather than quietly produce a different run: every field here is
 * compared on replay and every difference becomes a note.
 */
export interface TraceEnvelope {
  /**
   * The game's RNG seed if it exposes one (a `seed` scalar in its
   * `GameDebugProvider` snapshot, or one passed to the recorder). `null` means
   * the game exposes no seed — which is itself worth reporting, since a replay
   * then cannot start from the same random stream even in principle.
   */
  seed: number | null;
  fixedDeltaSec: number;
  ticksPerFrame: number;
  /** Editor/runtime version (lockstep — see CLAUDE.md on workspace versions). */
  runtimeVersion: string;
  /** Canvas backing size at record time. */
  viewport: { width: number; height: number };
  /** `appState.scenes.activeSceneId` at record time. */
  sceneId: string | null;
  /** Name of the registered GameDebugProvider, when there was one. */
  gameProvider?: string | null;
}

/** The subset of a run outcome a trace stores (the loop's own shape, minus prose). */
export interface TraceOutcome {
  kind: GameRunOutcome['kind'];
  channel?: 'until' | 'fail';
  index?: number;
  frame: number;
  gameTimeMs: number;
  assertion?: string;
  detail?: string;
}

export interface GameInputTrace {
  formatVersion: number;
  name: string;
  /** ISO timestamp. */
  recordedAt: string;
  env: TraceEnvelope;
  events: TraceEvent[];
  /** Events the cap threw away, if any — an overflow must never read as "no input". */
  droppedEvents?: number;
  outcome: TraceOutcome;
  metrics: { frames: number; gameTimeMs: number; newErrors: number };
  /** Flattened scalars of the outcome-frame snapshot — what a replay compares against. */
  gameState?: Record<string, Json>;
  assertions?: { until: string[]; fail: string[] };
  /**
   * Present ONLY when the recording caught the game using a nondeterministic
   * source. Its presence is what switches the replay comparison from strict to
   * threshold-based (§5.2).
   */
  nondeterministic?: Partial<Record<NondeterminismSource, number>>;
  /** Full probe evidence — raw counts, engine floor, caveats. */
  determinism?: NondeterminismReport;
  notes?: string[];
}

/**
 * Path a trace is stored under. Accepts a bare name (`'snake-eats'`) or an
 * already-qualified path and normalises both to `design/tests/<name>.trace.json`.
 */
export function traceFilePath(name: string): string {
  const trimmed = name.trim();
  if (/^design\/tests\/[^/]+\.trace\.json$/i.test(trimmed)) return trimmed;
  const base = trimmed
    .replace(/^.*\//, '')
    .replace(/\.trace\.json$/i, '')
    .replace(/\.json$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${TRACE_DIRECTORY}/${base || 'trace'}.trace.json`;
}

export function serializeTrace(trace: GameInputTrace): string {
  return `${JSON.stringify(trace, null, 2)}\n`;
}

/** Parse + validate enough of a stored trace that a replay cannot start on garbage. */
export function parseTrace(text: string): { trace: GameInputTrace } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  return validateTrace(raw);
}

export function validateTrace(raw: unknown): { trace: GameInputTrace } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'A trace must be a JSON object.' };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.formatVersion !== 'number') {
    return { error: 'The trace has no `formatVersion` — it was not written by this harness.' };
  }
  if (record.formatVersion > TRACE_FORMAT_VERSION) {
    return {
      error: `The trace was written in format v${record.formatVersion}, but this build understands up to v${TRACE_FORMAT_VERSION}. Re-record it.`,
    };
  }
  if (!Array.isArray(record.events)) {
    return { error: 'The trace has no `events` array.' };
  }
  const events: TraceEvent[] = [];
  for (const [index, item] of record.events.entries()) {
    const parsed = parseTraceEvent(item);
    if ('error' in parsed) return { error: `events[${index}]: ${parsed.error}` };
    events.push(parsed.event);
  }
  const env = record.env;
  if (typeof env !== 'object' || env === null) {
    return { error: 'The trace has no environment envelope (`env`).' };
  }
  const outcome = record.outcome;
  if (typeof outcome !== 'object' || outcome === null) {
    return { error: 'The trace has no recorded `outcome` to compare a replay against.' };
  }
  const trace = { ...record, events } as unknown as GameInputTrace;
  return { trace };
}

function parseTraceEvent(raw: unknown): { event: TraceEvent } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'not an object' };
  const item = raw as Record<string, unknown>;
  const frame = item.frame;
  if (typeof frame !== 'number' || !Number.isFinite(frame) || frame < 1) {
    return { error: '`frame` must be a number >= 1 (frame 1 is the first stepped frame)' };
  }
  if (item.kind === 'key') {
    if (item.phase !== 'down' && item.phase !== 'up')
      return { error: "key `phase` is 'down'|'up'" };
    if (typeof item.code !== 'string' || !item.code) {
      return { error: '`code` must be a KeyboardEvent.code string' };
    }
    return { event: { frame: Math.round(frame), kind: 'key', phase: item.phase, code: item.code } };
  }
  if (item.kind === 'pointer') {
    if (item.phase !== 'down' && item.phase !== 'move' && item.phase !== 'up') {
      return { error: "pointer `phase` is 'down'|'move'|'up'" };
    }
    if (typeof item.nx !== 'number' || typeof item.ny !== 'number') {
      return { error: '`nx`/`ny` must be numbers in 0..1 of the canvas box' };
    }
    return {
      event: {
        frame: Math.round(frame),
        kind: 'pointer',
        phase: item.phase,
        nx: item.nx,
        ny: item.ny,
        ...(typeof item.pointerId === 'number' ? { pointerId: item.pointerId } : {}),
      },
    };
  }
  return { error: `unknown kind "${String(item.kind)}" (expected 'key' or 'pointer')` };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Where traces are kept.
 *
 * **The file seam.** The production backend writes `design/tests/*.trace.json`
 * into the open project, which means going through the project's file services
 * (`ProjectService` / `FileSystemAPIService`) and their permission handling —
 * deliberately out of this module's scope. Implement `TraceStore` against them
 * and hand it to `GameTestService.setTraceStore()`; nothing else in the record /
 * replay / compare path changes, because none of it knows how a trace is
 * persisted. Until then the default is {@link InMemoryTraceStore}, which keeps
 * traces for the lifetime of the editor session: a record → replay round trip
 * works, a reload loses them.
 */
export interface TraceStore {
  save(path: string, trace: GameInputTrace): Promise<void>;
  load(path: string): Promise<GameInputTrace | null>;
  list(): Promise<string[]>;
}

export class InMemoryTraceStore implements TraceStore {
  private readonly traces = new Map<string, string>();

  async save(path: string, trace: GameInputTrace): Promise<void> {
    // Stored serialized, so the in-memory store has the same
    // round-trip-through-JSON semantics a file backend will have and a spec
    // written against one holds for the other.
    this.traces.set(path, serializeTrace(trace));
  }

  async load(path: string): Promise<GameInputTrace | null> {
    const text = this.traces.get(path);
    if (text === undefined) return null;
    const parsed = parseTrace(text);
    if ('error' in parsed) throw new Error(`Stored trace "${path}" is unreadable: ${parsed.error}`);
    return parsed.trace;
  }

  async list(): Promise<string[]> {
    return [...this.traces.keys()].sort();
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** An event as it is heard, before the recorder stamps it with a frame. */
export type UnstampedTraceEvent = Omit<TraceKeyEvent, 'frame'> | Omit<TracePointerEvent, 'frame'>;

/**
 * Where recorded events come from. The live implementation listens on the DOM;
 * a spec hands in a fake and emits events by hand, which is what makes the
 * "arrived between tick N and N+1" assertion testable without a browser.
 */
export interface TraceEventSource {
  start(emit: (event: UnstampedTraceEvent) => void): void;
  stop(): void;
}

/**
 * Listens to the same events the game does — capture-phase, on the canvas for
 * pointers and on the editor window for keys, which is exactly where
 * `GameInputService` dispatches and where the runtime's `InputService` listens.
 * So a recording captures whatever drove the game: a human at the keyboard, the
 * agent's own `game_input`, or this module's replay feeder.
 */
export class DomTraceEventSource implements TraceEventSource {
  private emit: ((event: UnstampedTraceEvent) => void) | null = null;
  private readonly onKeyDown = (event: Event): void => this.recordKey(event, 'down');
  private readonly onKeyUp = (event: Event): void => this.recordKey(event, 'up');
  private readonly onPointerDown = (event: Event): void => this.recordPointer(event, 'down');
  private readonly onPointerMove = (event: Event): void => this.recordPointer(event, 'move');
  private readonly onPointerUp = (event: Event): void => this.recordPointer(event, 'up');

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly windowRef: Window
  ) {}

  start(emit: (event: UnstampedTraceEvent) => void): void {
    this.emit = emit;
    this.windowRef.addEventListener('keydown', this.onKeyDown, true);
    this.windowRef.addEventListener('keyup', this.onKeyUp, true);
    this.canvas.addEventListener('pointerdown', this.onPointerDown, true);
    this.canvas.addEventListener('pointermove', this.onPointerMove, true);
    this.canvas.addEventListener('pointerup', this.onPointerUp, true);
  }

  stop(): void {
    this.emit = null;
    this.windowRef.removeEventListener('keydown', this.onKeyDown, true);
    this.windowRef.removeEventListener('keyup', this.onKeyUp, true);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    this.canvas.removeEventListener('pointermove', this.onPointerMove, true);
    this.canvas.removeEventListener('pointerup', this.onPointerUp, true);
  }

  private recordKey(event: Event, phase: 'down' | 'up'): void {
    const code = (event as { code?: unknown }).code;
    if (typeof code !== 'string' || !code) return;
    this.emit?.({ kind: 'key', phase, code });
  }

  private recordPointer(event: Event, phase: 'down' | 'move' | 'up'): void {
    const source = event as { clientX?: unknown; clientY?: unknown; pointerId?: unknown };
    if (typeof source.clientX !== 'number' || typeof source.clientY !== 'number') return;
    const rect = this.canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    this.emit?.({
      kind: 'pointer',
      phase,
      nx: round4((source.clientX - rect.left) / rect.width),
      ny: round4((source.clientY - rect.top) / rect.height),
      ...(typeof source.pointerId === 'number' ? { pointerId: source.pointerId } : {}),
    });
  }
}

/**
 * Stamps heard events with the frame they belong to.
 *
 * The contract with the loop is one call per frame: {@link markFrame} is called
 * with the number of the frame that is *about to* run, so everything heard until
 * the next call belongs to that frame. Events that arrive during the tick itself
 * (a game that dispatches synthetic events from a script) land on the running
 * frame, which replays one frame early — a bounded, documented shift rather than
 * a silent reordering.
 *
 * Pointer *moves* are collapsed to the last one per frame per pointer: a mouse
 * emits dozens per frame, only the final position matters to a game that samples
 * per tick, and without the collapse the cap would be spent in two seconds.
 */
export class TraceRecorder {
  private readonly events: TraceEvent[] = [];
  private frame = 1;
  private dropped = 0;
  private started = false;

  constructor(
    private readonly source: TraceEventSource,
    private readonly maxEvents: number = MAX_TRACE_EVENTS
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.source.start(event => this.push(event));
  }

  /** Called by the loop immediately before stepping `frame`. */
  markFrame(frame: number): void {
    this.frame = frame;
  }

  stop(): { events: TraceEvent[]; dropped: number } {
    if (this.started) {
      this.source.stop();
      this.started = false;
    }
    return { events: [...this.events], dropped: this.dropped };
  }

  private push(event: UnstampedTraceEvent): void {
    if (!this.started) return;
    if (event.kind === 'pointer' && event.phase === 'move') {
      const last = this.events[this.events.length - 1];
      if (
        last &&
        last.frame === this.frame &&
        last.kind === 'pointer' &&
        last.phase === 'move' &&
        last.pointerId === event.pointerId
      ) {
        last.nx = event.nx;
        last.ny = event.ny;
        return;
      }
    }
    if (this.events.length >= this.maxEvents) {
      this.dropped += 1;
      return;
    }
    this.events.push({ ...event, frame: this.frame } as TraceEvent);
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Where replayed events go. The live implementation dispatches the same DOM
 * events `GameInputService` does — keys on the editor window (the runtime's
 * `InputService` registers there even when the game renders in a popout),
 * pointers on the game canvas — so a replay travels the real player path and not
 * a private back door into the input service.
 */
export interface TraceInputSink {
  key(phase: 'down' | 'up', code: string): void;
  pointer(phase: 'down' | 'move' | 'up', nx: number, ny: number, pointerId?: number): void;
}

/** Pointer id used by synthetic replay pointers (matches GameInputService's). */
const REPLAY_POINTER_ID = 1;

export class DomTraceInputSink implements TraceInputSink {
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly windowRef: Window
  ) {}

  key(phase: 'down' | 'up', code: string): void {
    const type = phase === 'down' ? 'keydown' : 'keyup';
    this.windowRef.dispatchEvent(
      new KeyboardEvent(type, { code, key: keyForCode(code), bubbles: true, cancelable: true })
    );
  }

  pointer(phase: 'down' | 'move' | 'up', nx: number, ny: number, pointerId?: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const type = phase === 'down' ? 'pointerdown' : phase === 'up' ? 'pointerup' : 'pointermove';
    const init = {
      pointerId: pointerId ?? REPLAY_POINTER_ID,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: rect.left + nx * rect.width,
      clientY: rect.top + ny * rect.height,
      button: 0,
      buttons: phase === 'up' ? 0 : 1,
      bubbles: true,
      cancelable: true,
    };
    // happy-dom (specs) has no PointerEvent constructor carrying pointer fields —
    // same fallback GameInputService uses.
    if (typeof PointerEvent === 'function') {
      this.canvas.dispatchEvent(new PointerEvent(type, init));
      return;
    }
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [prop, value] of Object.entries(init)) {
      Object.defineProperty(event, prop, { value });
    }
    this.canvas.dispatchEvent(event);
  }
}

/** `KeyboardEvent.key` for a code, good enough for the games this drives. */
function keyForCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return ' ';
  return code;
}

export interface TraceFeeder {
  /** Dispatch everything stamped with `frame`, immediately before that frame runs. */
  before(frame: number): void;
  /** Events dispatched so far. */
  readonly dispatched: number;
  /** Frames the trace still holds events for beyond the run's budget. */
  pending(afterFrame: number): number;
}

/**
 * Groups a trace's events by frame and hands them to the sink between ticks.
 *
 * This is the whole "frame-denominated input" mechanism: the loop calls
 * `before(N)` after frame N-1 has completed and before it steps frame N, so an
 * event stamped N is delivered in that gap — the game polls it on frame N. No
 * wall-clock timer is involved anywhere, which is precisely why it works in
 * `'manual'` mode where `GameInputService.run()` cannot.
 */
export function makeTraceFeeder(events: readonly TraceEvent[], sink: TraceInputSink): TraceFeeder {
  const byFrame = new Map<number, TraceEvent[]>();
  for (const event of events) {
    const bucket = byFrame.get(event.frame);
    if (bucket) bucket.push(event);
    else byFrame.set(event.frame, [event]);
  }
  let dispatched = 0;
  return {
    before(frame: number): void {
      const bucket = byFrame.get(frame);
      if (!bucket) return;
      for (const event of bucket) {
        if (event.kind === 'key') sink.key(event.phase, event.code);
        else sink.pointer(event.phase, event.nx, event.ny, event.pointerId);
        dispatched += 1;
      }
    },
    get dispatched() {
      return dispatched;
    },
    pending(afterFrame: number): number {
      let count = 0;
      for (const [frame, bucket] of byFrame) {
        if (frame > afterFrame) count += bucket.length;
      }
      return count;
    },
  };
}

// ---------------------------------------------------------------------------
// Building a trace from a finished run
// ---------------------------------------------------------------------------

export interface TraceBuildInput {
  name: string;
  env: TraceEnvelope;
  events: TraceEvent[];
  droppedEvents?: number;
  result: GameRunResult;
  determinism?: NondeterminismReport;
  notes?: string[];
  /** Injectable clock so a spec can assert on `recordedAt`. */
  now?: () => Date;
}

export function buildTraceFromRun(input: TraceBuildInput): GameInputTrace {
  const { result } = input;
  const outcome: TraceOutcome = result.outcome
    ? {
        kind: result.outcome.kind,
        ...(result.outcome.channel ? { channel: result.outcome.channel } : {}),
        ...(result.outcome.index !== undefined ? { index: result.outcome.index } : {}),
        frame: result.outcome.frame,
        gameTimeMs: result.outcome.gameTimeMs,
        ...(result.outcome.assertion ? { assertion: result.outcome.assertion } : {}),
        ...(result.outcome.detail ? { detail: result.outcome.detail } : {}),
      }
    : { kind: 'error', frame: 0, gameTimeMs: 0, detail: 'the run produced no outcome' };

  const gameState = result.game?.snapshot ? flattenScalars(result.game.snapshot) : undefined;
  const determinism = input.determinism;
  const notes = [...(input.notes ?? [])];
  if (input.env.seed === null) {
    notes.push(
      'The game exposes no seed, so a replay cannot start from the same random stream even in principle. Expose one as a `seed` scalar in the GameDebugProvider snapshot to make replays comparable.'
    );
  }
  if (determinism?.dirty) {
    notes.push(
      'The game used nondeterministic sources during the recording, so this trace is compared by thresholds only — never frame for frame.'
    );
  }

  return {
    formatVersion: TRACE_FORMAT_VERSION,
    name: input.name,
    recordedAt: (input.now?.() ?? new Date()).toISOString(),
    env: input.env,
    events: input.events,
    ...(input.droppedEvents ? { droppedEvents: input.droppedEvents } : {}),
    outcome,
    metrics: {
      frames: result.metrics?.frames ?? outcome.frame,
      gameTimeMs: result.metrics?.gameTimeMs ?? outcome.gameTimeMs,
      newErrors: result.metrics?.newErrors ?? 0,
    },
    ...(gameState && Object.keys(gameState).length ? { gameState } : {}),
    ...(result.assertions ? { assertions: result.assertions } : {}),
    ...(determinism?.dirty ? { nondeterministic: determinism.attributed } : {}),
    ...(determinism ? { determinism } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface TraceTolerance {
  /** Relative slack on the outcome frame (and on game time, which derives from it). */
  framePct: number;
  /** Absolute slack on the outcome frame, in frames. */
  frameAbs: number;
  /** Relative slack on a numeric game-state scalar. */
  valuePct: number;
  /** Absolute slack on a numeric game-state scalar. */
  valueAbs: number;
}

/**
 * Defaults chosen to catch a regression, not a wobble: a quarter of the recorded
 * frame count is far tighter than "the game still works" yet loose enough that
 * one extra spawn roll does not fail the run.
 */
export const DEFAULT_TRACE_TOLERANCE: TraceTolerance = Object.freeze({
  framePct: 0.25,
  frameAbs: 6,
  valuePct: 0.25,
  valueAbs: 1,
});

export interface TraceMetricDiff {
  /** `frame`, `gameTimeMs`, `newErrors`, or `state.<path>`. */
  metric: string;
  recorded: Json;
  replayed: Json;
  /** Numeric difference, when both sides are numbers. */
  delta?: number;
  /** Difference as a fraction of the recorded value, when that is meaningful. */
  deltaPct?: number;
  /** Whether the difference is acceptable under the comparison mode in force. */
  within: boolean;
  /**
   * Reported but not counted against the verdict — a non-numeric difference in
   * a nondeterministic trace, where a threshold means nothing.
   */
  soft?: boolean;
}

export interface TraceComparison {
  /** Read this first. */
  verdict: string;
  /** The replay reproduced the recorded outcome within the mode's rules. */
  matched: boolean;
  /** Outcome kind (+channel/index) matched, independently of the metrics. */
  outcomeMatched: boolean;
  /**
   * True when the trace was clean and the environment lined up, so equality was
   * required. False means thresholds were used — and the verdict says why, so a
   * "passed" replay can never be mistaken for a determinism proof.
   */
  strict: boolean;
  recorded: { outcome: TraceOutcome; metrics: GameInputTrace['metrics'] };
  replayed: { outcome?: GameRunOutcome; metrics?: GameRunResult['metrics'] };
  /** Copied from the trace when it was marked (§5.2). */
  nondeterministic?: Partial<Record<NondeterminismSource, number>>;
  tolerance: TraceTolerance;
  diffs: TraceMetricDiff[];
  notes: string[];
}

export interface CompareTraceOptions {
  tolerance?: Partial<TraceTolerance>;
  /** Envelope of the replay run, for drift detection. */
  env?: Partial<TraceEnvelope>;
}

/**
 * Compare a replay against the trace it came from.
 *
 * The rule the plan insists on: `outcome.kind` and metrics **within tolerance**,
 * never frame-for-frame identity — and a trace marked `nondeterministic` gets
 * thresholds only, with the fact stated in the verdict rather than implied by
 * its absence.
 */
export function compareTraceToRun(
  trace: GameInputTrace,
  result: GameRunResult,
  options: CompareTraceOptions = {}
): TraceComparison {
  const tolerance: TraceTolerance = { ...DEFAULT_TRACE_TOLERANCE, ...options.tolerance };
  const notes: string[] = [];
  const diffs: TraceMetricDiff[] = [];

  const envDrift = describeEnvDrift(trace.env, options.env);
  notes.push(...envDrift.notes);

  const marked = trace.nondeterministic && Object.keys(trace.nondeterministic).length > 0;
  const strict = !marked && !envDrift.blocksStrict;
  if (marked) {
    const summary = Object.entries(trace.nondeterministic ?? {})
      .map(([source, count]) => `${source}×${count}`)
      .join(', ');
    notes.push(
      `The recording caught the game using nondeterministic sources (${summary}), so strict comparison is not applicable: only thresholds are checked, and an identical run was never promised.`
    );
  }

  const replayOutcome = result.outcome;
  const outcomeMatched =
    !!replayOutcome &&
    replayOutcome.kind === trace.outcome.kind &&
    (replayOutcome.channel ?? null) === (trace.outcome.channel ?? null) &&
    (replayOutcome.index ?? null) === (trace.outcome.index ?? null);

  if (replayOutcome) {
    diffs.push(
      compareNumeric('frame', trace.outcome.frame, replayOutcome.frame, strict, {
        pct: tolerance.framePct,
        abs: tolerance.frameAbs,
      })
    );
    diffs.push(
      compareNumeric('gameTimeMs', trace.outcome.gameTimeMs, replayOutcome.gameTimeMs, strict, {
        pct: tolerance.framePct,
        abs: tolerance.frameAbs * trace.env.fixedDeltaSec * 1000,
      })
    );
  }

  // Errors are never tolerated in either mode: a replay that gained a runtime
  // error has found something, whatever the trace's determinism looked like.
  const recordedErrors = trace.metrics.newErrors;
  const replayedErrors = result.metrics?.newErrors ?? 0;
  diffs.push({
    metric: 'newErrors',
    recorded: recordedErrors,
    replayed: replayedErrors,
    delta: replayedErrors - recordedErrors,
    within: replayedErrors <= recordedErrors,
  });

  const replayState = result.game?.snapshot ? flattenScalars(result.game.snapshot) : {};
  for (const [path, recorded] of Object.entries(trace.gameState ?? {})) {
    const replayed = replayState[path];
    if (replayed === undefined) {
      diffs.push({
        metric: `state.${path}`,
        recorded,
        replayed: null,
        within: false,
      });
      notes.push(
        `The replay's snapshot has no \`${path}\` — the game's debug provider changed shape since the recording, so that value could not be compared.`
      );
      continue;
    }
    if (typeof recorded === 'number' && typeof replayed === 'number') {
      diffs.push(
        compareNumeric(`state.${path}`, recorded, replayed, strict, {
          pct: tolerance.valuePct,
          abs: tolerance.valueAbs,
        })
      );
      continue;
    }
    const equal = JSON.stringify(recorded) === JSON.stringify(replayed);
    diffs.push({
      metric: `state.${path}`,
      recorded,
      replayed,
      within: equal,
      // A non-numeric value has no threshold. Under strict comparison it must be
      // equal; in a nondeterministic trace it is reported and not counted, since
      // failing a run on a string that was never promised to repeat would make
      // every marked trace red forever.
      ...(equal || strict ? {} : { soft: true }),
    });
  }

  const hard = diffs.filter(diff => !diff.within && !diff.soft);
  const matched = outcomeMatched && hard.length === 0;
  const mode = strict ? 'strict' : 'tolerant';
  const outcomeLine = replayOutcome
    ? `${replayOutcome.kind}${replayOutcome.channel ? ` ${replayOutcome.channel}[${replayOutcome.index ?? 0}]` : ''} at frame ${replayOutcome.frame}`
    : 'no outcome';
  const recordedLine = `${trace.outcome.kind}${trace.outcome.channel ? ` ${trace.outcome.channel}[${trace.outcome.index ?? 0}]` : ''} at frame ${trace.outcome.frame}`;
  const verdict = matched
    ? `REPLAY MATCH (${mode}): ${outcomeLine}, recorded ${recordedLine}.${strict ? '' : ' Thresholds only — the recording was marked nondeterministic, so this is not proof of an identical run.'}`
    : `REPLAY DIVERGED (${mode}): replay ${outcomeLine}, recorded ${recordedLine}.${
        hard.length
          ? ` Out of tolerance: ${hard.map(diff => `${diff.metric} ${formatValue(diff.recorded)}→${formatValue(diff.replayed)}`).join('; ')}.`
          : ''
      }`;

  return {
    verdict,
    matched,
    outcomeMatched,
    strict,
    recorded: { outcome: trace.outcome, metrics: trace.metrics },
    replayed: {
      ...(replayOutcome ? { outcome: replayOutcome } : {}),
      ...(result.metrics ? { metrics: result.metrics } : {}),
    },
    ...(marked ? { nondeterministic: trace.nondeterministic } : {}),
    tolerance,
    diffs,
    notes,
  };
}

function compareNumeric(
  metric: string,
  recorded: number,
  replayed: number,
  strict: boolean,
  slack: { pct: number; abs: number }
): TraceMetricDiff {
  const delta = replayed - recorded;
  const allowed = strict ? 0 : Math.max(slack.abs, Math.abs(recorded) * slack.pct);
  return {
    metric,
    recorded,
    replayed,
    delta: round4(delta),
    ...(recorded !== 0 ? { deltaPct: round4(delta / Math.abs(recorded)) } : {}),
    within: Math.abs(delta) <= allowed,
  };
}

function describeEnvDrift(
  recorded: TraceEnvelope,
  replay: Partial<TraceEnvelope> | undefined
): { notes: string[]; blocksStrict: boolean } {
  if (!replay) return { notes: [], blocksStrict: false };
  const notes: string[] = [];
  let blocksStrict = false;
  if (replay.fixedDeltaSec !== undefined && replay.fixedDeltaSec !== recorded.fixedDeltaSec) {
    notes.push(
      `The replay ticks at ${replay.fixedDeltaSec}s but the trace was recorded at ${recorded.fixedDeltaSec}s, so frame counts are not comparable strictly.`
    );
    blocksStrict = true;
  }
  if (replay.sceneId !== undefined && replay.sceneId !== recorded.sceneId) {
    notes.push(
      `The replay ran scene "${replay.sceneId}" but the trace was recorded on "${recorded.sceneId}".`
    );
    blocksStrict = true;
  }
  if (
    replay.viewport &&
    (replay.viewport.width !== recorded.viewport.width ||
      replay.viewport.height !== recorded.viewport.height)
  ) {
    notes.push(
      `The canvas is ${replay.viewport.width}×${replay.viewport.height}, recorded at ${recorded.viewport.width}×${recorded.viewport.height}. Pointer events are normalised to the canvas box so they still land on the same relative spot, but a different aspect ratio moves what is under it.`
    );
  }
  if (replay.runtimeVersion !== undefined && replay.runtimeVersion !== recorded.runtimeVersion) {
    notes.push(
      `Runtime version differs (recorded ${recorded.runtimeVersion}, replayed ${replay.runtimeVersion}).`
    );
  }
  if (replay.seed !== undefined && replay.seed !== recorded.seed) {
    notes.push(`Seed differs (recorded ${recorded.seed}, replayed ${replay.seed}).`);
    blocksStrict = true;
  }
  return { notes, blocksStrict };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const isPlainObject = (value: Json): value is { [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Flatten a snapshot to `dot.path -> scalar`, capped like the loop's diff. */
export function flattenScalars(
  value: Json,
  depth = TRACE_STATE_DEPTH,
  cap = MAX_TRACE_STATE_PATHS
): Record<string, Json> {
  const out: Record<string, Json> = {};
  const walk = (node: Json, path: string, remaining: number): void => {
    if (Object.keys(out).length >= cap) return;
    if (remaining > 0 && isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        walk(child, path ? `${path}.${key}` : key, remaining - 1);
      }
      return;
    }
    if (Array.isArray(node)) {
      out[path || '(root)'] = node.length;
      return;
    }
    out[path || '(root)'] = node;
  };
  walk(value, '', depth);
  return out;
}

const formatValue = (value: Json): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
