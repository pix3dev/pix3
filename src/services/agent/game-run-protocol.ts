import { safeSerialize, type Json } from '@/core/agent-introspection';
import type { AssertionFrame } from '@/services/agent/game-assertions';
import { flattenScalars } from '@/services/agent/game-traces';
import type { LiveNodeSnapshot } from '@/services/agent/GameInputService';
import type { RoutineWorld } from '@/services/agent/game-routines';

/**
 * The FULL protocol of one `game_run`, written to a project file, so the tool
 * reply can stay compact and only point at it (§6 rule 3 of
 * `.plans/agent-gameplay-testing.md`: "survives compaction, does not burn
 * context" — the same argument `design/source/` makes for the GDD).
 *
 * The reply a run returns is a *summary* by construction: the timeline is deduped
 * and capped at 20 entries with at most 3 changed paths per frame, the monkey log
 * keeps a head and a tail, error messages are sliced to 120 characters, and the
 * per-frame node/property/axis readings the loop collected are not in it at all.
 * Every one of those caps exists so a run does not eat the model's context — and
 * every one of them destroys the evidence a second look would need. This module
 * is where the destroyed half goes.
 *
 * ## Why the file name looks like that
 *
 * `NNNN-<subject>-<verdict>[-f<frame>].json` — `0007-monkey-fail-f142.json`. The
 * name has to answer "which run was this and how did it end" from an `fs_list`
 * alone; a name that does not (a timestamp, a uuid, `report.json`) costs the agent
 * one `fs_read` per stored report just to find the one it wants, which is the
 * context spend this whole feature exists to avoid. The counter is derived from
 * the directory rather than from a clock, so the names sort chronologically
 * without a clock in them, and the wall clock lives inside the file as
 * `startedAt`. The listing that yields the counter is the same listing rotation
 * needs, so it costs nothing extra.
 *
 * ## Why the JSON is pretty-printed
 *
 * `fs_read` pages by LINES. A one-line JSON blob can therefore only ever be read
 * whole, which is exactly the failure this feature is trying to prevent — so the
 * document is written with two-space indentation on purpose, and `contains` tells
 * the reader to slice it with `{offset, limit}`.
 */

/** Where reports live in a project. Next to the traces and routines, for the same reason. */
export const REPORT_DIRECTORY = 'design/tests/reports';

export const REPORT_FORMAT_VERSION = 1;

/** Reports kept in the directory; older ones are deleted on every write. */
export const MAX_STORED_REPORTS = 20;

/** Safety ceiling per array — a runaway run must not write a 100 MB file. */
export const MAX_PROTOCOL_ENTRIES = 20_000;

/**
 * Snapshot flattening for the protocol: deeper and far wider than the reply's
 * diff (depth 2, 20 paths), because a file nobody has to read whole can afford
 * the whole snapshot and the reply cannot.
 */
const PROTOCOL_STATE_DEPTH = 6;
const PROTOCOL_STATE_PATHS = 2_000;

/**
 * Float rounding for transform/axis deltas — raw floats would record renderer
 * noise (a 1e-16 world-matrix wobble) as a change, and a protocol whose every
 * frame "changed" is as useless as one with no deltas at all.
 */
const DELTA_PRECISION = 4;

/**
 * Serialization depth for a recorded routine reading. Deep enough that a game's
 * debug snapshot lands whole (`safeSerialize`'s own key/array caps still apply,
 * and they are far above anything a snapshot has), because the point of
 * recording the reads is that the reply carries only the outcome snapshot.
 */
const PROTOCOL_READ_DEPTH = 8;

// ---------------------------------------------------------------------------
// Document shape
// ---------------------------------------------------------------------------

export interface ProtocolTimelineEntry {
  frame: number;
  kind: 'state' | 'error' | 'gone' | 'appeared';
  note: string;
}

export interface ProtocolObservedDelta {
  frame: number;
  channel: 'transform' | 'property' | 'typeCount' | 'axis';
  /**
   * The reading's key exactly as the run asked for it: `Player.worldPosition.x`,
   * `ScoreLabel.text`, `Enemy2D`, `Horizontal`. Keyed by the query rather than by
   * nodeId for the same reason the loop is: a node that dies and is replaced by a
   * same-named one is the same subject to a test.
   *
   * For a `property` channel, `null` is both "the node has no such property" and
   * "the property reads null" — the distinction lives in the reply's predicate
   * detail, which is where it decides something.
   */
  key: string;
  from: Json;
  to: Json;
}

export interface ProtocolMonkeyAction {
  frame: number;
  /**
   * The decided action as data, NOT a formatted line: `game-monkey`'s formatter is
   * private to that module and duplicating it here would give the file and the
   * reply two spellings of the same press.
   */
  action: Json;
  status: 'sent' | 'refused' | 'error';
  note?: string;
}

export interface ProtocolSection {
  /** `main` is the run itself; `control` is the negative-control run (§5.4.4). */
  label: 'main' | 'control';
  /** Complete timeline: no dedup, no 20-entry cap, no 3-paths-per-frame cap, full error messages. */
  timeline: ProtocolTimelineEntry[];
  /** Every change of every reading the run collected. The reply carries none of these. */
  observed: ProtocolObservedDelta[];
  monkey?: { seed: number | null; actions: ProtocolMonkeyAction[] };
  /** The state slice at the outcome frame, with the FULL baseline→outcome diff. */
  outcomeState?: {
    frame: number;
    provider: string | null;
    baseline: Json | null;
    snapshot: Json | null;
    changed: Record<string, [Json, Json]>;
  };
  /** One line per array that hit {@link MAX_PROTOCOL_ENTRIES}. Never silent. */
  truncated?: string[];
}

export interface ProtocolRoutineRead {
  seq: number;
  /** The world method the driver called: `sampleGameState`, `readNodeProperty`, … */
  call: string;
  /** Its arguments, as data. */
  args?: Json;
  /** What the live world answered — uncapped, so the routine's own baseline snapshot is here in full. */
  value: Json;
}

export interface RunProtocolDocument {
  formatVersion: number;
  kind: 'game_run' | 'routine';
  /** Slug that also names the file: `run`, `monkey`, `routine-menu-play`. */
  subject: string;
  /** Wall-clock start, ISO. The clock belongs HERE, not in the file name. */
  startedAt: string;
  editorVersion: string;
  sceneId: string | null;
  /**
   * A cheap map of what is below, so an agent can read the first ~40 lines with
   * `fs_read {limit}` and know which line range is worth a second read.
   */
  outline: string[];
  /** The tool reply verbatim minus its own `artifact` pointer, so the file is self-contained. */
  reply: Json;
  sections: ProtocolSection[];
  routine?: { reads: ProtocolRoutineRead[] };
  notes: string[];
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

/**
 * What the frame loop feeds. Structural so the loop stays testable without
 * storage, and so a loop run with no sink behaves identically — the loop records
 * into it and never decides anything from it.
 */
export interface RunProtocolSink {
  frame(frame: AssertionFrame, newError?: { source: string; message: string }): void;
  monkeyAction(entry: ProtocolMonkeyAction): void;
  outcome(input: {
    frame: number;
    provider: string | null;
    baseline: Json | null;
    snapshot: Json | null;
  }): void;
  note(text: string): void;
}

/** The transform leaves a node delta is measured on, in the order they are reported. */
const NODE_LEAVES = [
  'position.x',
  'position.y',
  'position.z',
  'worldPosition.x',
  'worldPosition.y',
  'worldPosition.z',
  'rotationZ',
  'scale.x',
  'scale.y',
  'scale.z',
  'visible',
  'childCount',
  'visibleChildCount',
] as const;

/**
 * Accumulates one run's full protocol from the frames the loop feeds it.
 *
 * It diffs consecutive frames rather than storing them: a 600-frame run with
 * eight watched nodes would be ~60 000 readings, of which the interesting ones
 * are the handful that moved. The FIRST fed frame (the baseline, frame 0)
 * therefore only establishes the previous values and emits nothing — there is no
 * "before" for it, and inventing one from zeros would report the whole game as
 * having changed on frame 0.
 */
export class RunProtocolRecorder implements RunProtocolSink {
  private readonly timeline: ProtocolTimelineEntry[] = [];
  private readonly observed: ProtocolObservedDelta[] = [];
  private readonly monkeyActions: ProtocolMonkeyAction[] = [];
  private readonly truncated: string[] = [];
  private readonly collectedNotes: string[] = [];
  /** Arrays that already reported an overflow, so `truncated` says it once. */
  private readonly overflowed = new Set<string>();

  private seenFrame = false;
  private previousState: Record<string, Json> | null = null;
  private previousPresent: ReadonlySet<string> = new Set();
  private previousErrorCount = 0;
  private previousNodes = new Map<string, Record<string, Json>>();
  private previousProperties = new Map<string, Json>();
  private previousTypeCounts = new Map<string, number>();
  private previousAxes = new Map<string, number>();
  private outcomeState: ProtocolSection['outcomeState'];

  constructor(
    private readonly label: 'main' | 'control',
    /**
     * The monkey seed of the run, when it had one. It comes from the spec rather
     * than from the fed actions because a monkey run that pressed nothing still
     * has to record which seed produced that nothing — a finding nobody can
     * re-run is an anecdote (rule 1 of the monkey module).
     */
    private readonly monkeySeed: number | null = null
  ) {}

  frame(frame: AssertionFrame, newError?: { source: string; message: string }): void {
    const state =
      frame.gameState === null
        ? null
        : flattenScalars(frame.gameState, PROTOCOL_STATE_DEPTH, PROTOCOL_STATE_PATHS);

    if (!this.seenFrame) {
      this.seenFrame = true;
      this.adopt(frame, state);
      return;
    }

    if (state && this.previousState) {
      for (const path of union(Object.keys(this.previousState), Object.keys(state))) {
        const before = this.previousState[path] ?? null;
        const after = state[path] ?? null;
        if (sameJson(before, after)) continue;
        this.append(this.timeline, 'timeline', frame.frame, {
          frame: frame.frame,
          kind: 'state',
          note: `${path} ${formatScalar(before)}→${formatScalar(after)}`,
        });
      }
    }

    if (frame.newErrorCount > this.previousErrorCount) {
      // The FULL message, unlike the reply's 120-character slice: a stack-carrying
      // TypeError is unreadable at 120 characters and re-running the game to see the
      // rest is the cost this file exists to remove.
      this.append(this.timeline, 'timeline', frame.frame, {
        frame: frame.frame,
        kind: 'error',
        note: newError ? `${newError.source}: ${newError.message}` : 'runtime error',
      });
    }

    for (const name of this.previousPresent) {
      if (!frame.presentNodes.has(name)) {
        this.append(this.timeline, 'timeline', frame.frame, {
          frame: frame.frame,
          kind: 'gone',
          note: name,
        });
      }
    }
    for (const name of frame.presentNodes) {
      if (!this.previousPresent.has(name)) {
        this.append(this.timeline, 'timeline', frame.frame, {
          frame: frame.frame,
          kind: 'appeared',
          note: name,
        });
      }
    }

    if (frame.nodes) {
      const current = nodeLeafMap(frame.nodes);
      for (const query of union([...this.previousNodes.keys()], [...current.keys()])) {
        const before = this.previousNodes.get(query);
        const after = current.get(query);
        for (const leaf of NODE_LEAVES) {
          // A node that entered or left the map is a delta with `null` on the missing
          // side, which is what makes a spawn and a death visible in the same channel
          // as a movement instead of only in the timeline's name-based view.
          const from = before?.[leaf] ?? null;
          const to = after?.[leaf] ?? null;
          if (sameJson(from, to)) continue;
          this.observe(frame.frame, 'transform', `${query}.${leaf}`, from, to);
        }
      }
      this.previousNodes = current;
    }

    if (frame.nodeProperties) {
      const current = new Map<string, Json>();
      for (const [key, value] of frame.nodeProperties) current.set(readableKey(key), value ?? null);
      for (const key of union([...this.previousProperties.keys()], [...current.keys()])) {
        const from = this.previousProperties.get(key) ?? null;
        const to = current.get(key) ?? null;
        if (sameJson(from, to)) continue;
        this.observe(frame.frame, 'property', key, from, to);
      }
      this.previousProperties = current;
    }

    if (frame.typeCounts) {
      for (const key of union([...this.previousTypeCounts.keys()], [...frame.typeCounts.keys()])) {
        const from = this.previousTypeCounts.get(key) ?? null;
        const to = frame.typeCounts.get(key) ?? null;
        if (from === to) continue;
        this.observe(frame.frame, 'typeCount', key, from, to);
      }
      this.previousTypeCounts = new Map(frame.typeCounts);
    }

    if (frame.axes) {
      const current = new Map<string, number>();
      for (const [key, value] of frame.axes) current.set(key, round(value));
      for (const key of union([...this.previousAxes.keys()], [...current.keys()])) {
        const from = this.previousAxes.get(key) ?? null;
        const to = current.get(key) ?? null;
        if (from === to) continue;
        this.observe(frame.frame, 'axis', key, from, to);
      }
      this.previousAxes = current;
    }

    this.previousState = state ?? this.previousState;
    this.previousPresent = frame.presentNodes;
    this.previousErrorCount = frame.newErrorCount;
  }

  monkeyAction(entry: ProtocolMonkeyAction): void {
    this.append(this.monkeyActions, 'monkey actions', entry.frame, entry);
  }

  outcome(input: {
    frame: number;
    provider: string | null;
    baseline: Json | null;
    snapshot: Json | null;
  }): void {
    const before =
      input.baseline === null
        ? {}
        : flattenScalars(input.baseline, PROTOCOL_STATE_DEPTH, PROTOCOL_STATE_PATHS);
    const after =
      input.snapshot === null
        ? {}
        : flattenScalars(input.snapshot, PROTOCOL_STATE_DEPTH, PROTOCOL_STATE_PATHS);
    const changed: Record<string, [Json, Json]> = {};
    for (const path of union(Object.keys(before), Object.keys(after))) {
      const from = before[path] ?? null;
      const to = after[path] ?? null;
      if (!sameJson(from, to)) changed[path] = [from, to];
    }
    this.outcomeState = {
      frame: input.frame,
      provider: input.provider,
      baseline: input.baseline,
      snapshot: input.snapshot,
      changed,
    };
  }

  note(text: string): void {
    this.collectedNotes.push(text);
  }

  /** Notes the loop handed over; the document carries them, a section does not. */
  notes(): readonly string[] {
    return this.collectedNotes;
  }

  section(): ProtocolSection {
    return {
      label: this.label,
      timeline: this.timeline,
      observed: this.observed,
      ...(this.monkeySeed !== null || this.monkeyActions.length > 0
        ? { monkey: { seed: this.monkeySeed, actions: this.monkeyActions } }
        : {}),
      ...(this.outcomeState ? { outcomeState: this.outcomeState } : {}),
      ...(this.truncated.length ? { truncated: this.truncated } : {}),
    };
  }

  private adopt(frame: AssertionFrame, state: Record<string, Json> | null): void {
    this.previousState = state;
    this.previousPresent = frame.presentNodes;
    this.previousErrorCount = frame.newErrorCount;
    if (frame.nodes) this.previousNodes = nodeLeafMap(frame.nodes);
    if (frame.nodeProperties) {
      for (const [key, value] of frame.nodeProperties) {
        this.previousProperties.set(readableKey(key), value ?? null);
      }
    }
    if (frame.typeCounts) this.previousTypeCounts = new Map(frame.typeCounts);
    if (frame.axes) {
      for (const [key, value] of frame.axes) this.previousAxes.set(key, round(value));
    }
  }

  private observe(
    frame: number,
    channel: ProtocolObservedDelta['channel'],
    key: string,
    from: Json,
    to: Json
  ): void {
    this.append(this.observed, 'observed deltas', frame, { frame, channel, key, from, to });
  }

  /**
   * Append under the cap, and say so ONCE per array when the cap bites. Stopping
   * only the array that overflowed matters: a chaotic 3600-frame run fills
   * `observed` long before `timeline`, and truncating both would throw away the
   * cheap half of the evidence to protect the expensive one.
   */
  private append<T>(target: T[], label: string, frame: number, entry: T): void {
    if (target.length >= MAX_PROTOCOL_ENTRIES) {
      if (!this.overflowed.has(label)) {
        this.overflowed.add(label);
        this.truncated.push(
          `The ${label} array hit its ${MAX_PROTOCOL_ENTRIES}-entry cap at frame ${frame}; nothing after that frame was recorded in it (the other arrays are complete).`
        );
      }
      return;
    }
    target.push(entry);
  }
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the document, including the `outline` a reader uses to decide which
 * slice to read. The outline is built here rather than by the caller so it can
 * never disagree with the sections it describes.
 */
export function buildRunProtocolDocument(input: {
  kind: RunProtocolDocument['kind'];
  subject: string;
  startedAt: string;
  editorVersion: string;
  sceneId: string | null;
  reply: Json;
  sections: ProtocolSection[];
  determinism?: Json;
  routine?: { reads: ProtocolRoutineRead[] };
  notes?: string[];
}): RunProtocolDocument {
  const outline: string[] = [
    '`reply` — the tool reply verbatim (already summarised; read the sections for what it cut).',
  ];
  input.sections.forEach((section, index) => {
    outline.push(
      `sections[${index}] "${section.label}" — ${section.timeline.length} timeline event(s), ${section.observed.length} observed delta(s)${
        section.monkey ? `, ${section.monkey.actions.length} monkey action(s)` : ''
      }${section.outcomeState ? ', outcome-frame state slice with the full diff' : ''}${
        section.truncated ? ', TRUNCATED (see section.truncated)' : ''
      }.`
    );
  });
  if (input.routine) {
    outline.push(
      `\`routine.reads\` — ${input.routine.reads.length} live-world reading(s) the driver took, in call order, values uncapped.`
    );
  }
  if (input.determinism) {
    outline.push("`determinism` — the nondeterminism probe's full evidence for this run.");
  }
  return {
    formatVersion: REPORT_FORMAT_VERSION,
    kind: input.kind,
    subject: input.subject,
    startedAt: input.startedAt,
    editorVersion: input.editorVersion,
    sceneId: input.sceneId,
    outline,
    reply: input.reply,
    sections: input.sections,
    ...(input.determinism !== undefined ? { determinism: input.determinism } : {}),
    ...(input.routine ? { routine: input.routine } : {}),
    notes: input.notes ?? [],
  };
}

/**
 * The reply as the document carries it: everything the tool returned except the
 * `artifact` pointer, which would go stale the moment rotation renames nothing
 * and deletes something.
 *
 * Copied through `JSON` rather than through `safeSerialize` on purpose: the
 * serialiser caps arrays at 100 entries and objects at 60 keys, and a file that
 * claims to hold the reply *verbatim* must not silently trim it. The reply is a
 * plain report object with no cycles, so the copy is exact.
 */
export function protocolReply(result: object): Json {
  const { artifact: _artifact, ...rest } = result as Record<string, unknown> & {
    artifact?: unknown;
  };
  return protocolJson(rest);
}

/** A Json copy of a plain data value; falls back to the depth-limited serialiser. */
export function protocolJson(value: unknown): Json {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as Json;
  } catch {
    // A value with a cycle or a throwing `toJSON` must not fail the run whose
    // protocol it belongs to — record whatever the safe serialiser can reach.
    return safeSerialize(value, PROTOCOL_READ_DEPTH);
  }
}

// ---------------------------------------------------------------------------
// Naming, rotation, saving
// ---------------------------------------------------------------------------

/**
 * The storage seam. Narrow on purpose: the service must not depend on
 * `ProjectStorageService` (see `ProjectTraceStore`), and a spec fakes three
 * methods instead of a project.
 */
export interface RunProtocolStore {
  /** File NAMES (not paths) already stored, sorted ascending. */
  list(): Promise<string[]>;
  save(name: string, text: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export type RunArtifactReport =
  | {
      written: true;
      path: string;
      bytes: number;
      contains: string;
      pruned?: string[];
      note?: string;
    }
  | { written: false; reason: string };

export function reportFilePath(name: string): string {
  return `${REPORT_DIRECTORY}/${name}`;
}

/** Longest a subject may be in a file name — a name nobody can read in an `fs_list` column is no better than a uuid. */
const MAX_SUBJECT_SLUG = 40;

export function nextReportName(
  existing: readonly string[],
  parts: { subject: string; verdict: string; frame?: number }
): string {
  let highest = 0;
  for (const name of existing) {
    const match = /^(\d{4})-/.exec(name);
    if (!match) continue;
    highest = Math.max(highest, Number(match[1]));
  }
  const counter = String(highest + 1).padStart(4, '0');
  const subject = slug(parts.subject).slice(0, MAX_SUBJECT_SLUG).replace(/-+$/, '') || 'run';
  const verdict = slug(parts.verdict) || 'unknown';
  const frame = parts.frame !== undefined ? `-f${Math.max(0, Math.round(parts.frame))}` : '';
  return `${counter}-${subject}-${verdict}${frame}.json`;
}

/** Names to delete, oldest first — everything beyond the newest `keep`. */
export function planRotation(
  existing: readonly string[],
  keep: number = MAX_STORED_REPORTS
): string[] {
  const sorted = [...existing].sort();
  return sorted.slice(0, Math.max(0, sorted.length - Math.max(0, keep)));
}

export async function saveRunProtocol(
  store: RunProtocolStore | null,
  doc: RunProtocolDocument,
  parts: { subject: string; verdict: string; frame?: number }
): Promise<RunArtifactReport> {
  if (!store) {
    return {
      written: false,
      reason:
        'No project is open, so the full protocol was NOT written: everything beyond the caps in this reply — the undeduped timeline, the node deltas, the full monkey log — is gone when this reply is compacted. Open a project and re-run to keep it in design/tests/reports/.',
    };
  }

  let name: string;
  let text: string;
  let existing: string[];
  try {
    existing = await store.list();
    name = nextReportName(existing, parts);
    // Two spaces, not zero: `fs_read` pages by LINES, so a one-line document could
    // only be read whole — the exact thing this file exists to make unnecessary.
    text = JSON.stringify(doc, null, 2);
    await store.save(name, text);
  } catch (error) {
    return {
      written: false,
      reason: `Could not write the full protocol to ${REPORT_DIRECTORY}/: ${describeError(error)}. The run itself is unaffected — this reply is all there is of it, so read it now.`,
    };
  }

  // Rotation is computed against the listing INCLUDING the file just written, so
  // the newest report is never the one that gets pruned.
  const pruned: string[] = [];
  const failures: string[] = [];
  for (const stale of planRotation([...existing, name])) {
    try {
      await store.delete(stale);
      pruned.push(stale);
    } catch (error) {
      failures.push(`${stale} (${describeError(error)})`);
    }
  }

  const bytes = byteLength(text);
  let note = `${REPORT_DIRECTORY}/ keeps the newest ${MAX_STORED_REPORTS} report(s); anything older is deleted on the next write, so copy a finding you want to keep.`;
  if (failures.length > 0) {
    // A failed delete must not fail the save: the report is already on disk and is
    // the only copy of the evidence.
    note += ` Could not delete ${failures.join(', ')} — the directory holds more than ${MAX_STORED_REPORTS} reports until that clears.`;
  }
  return {
    written: true,
    path: reportFilePath(name),
    bytes,
    contains: describeContents(doc, bytes),
    ...(pruned.length ? { pruned } : {}),
    note,
  };
}

/** The one line that tells a reader whether opening the file is worth it — built from the real counts. */
function describeContents(doc: RunProtocolDocument, bytes: number): string {
  let timeline = 0;
  let observed = 0;
  let monkey = 0;
  let outcomeStates = 0;
  for (const section of doc.sections) {
    timeline += section.timeline.length;
    observed += section.observed.length;
    monkey += section.monkey?.actions.length ?? 0;
    if (section.outcomeState) outcomeStates += 1;
  }
  // A routine writes no sections (no frame loop ran), and "0 timeline event(s)"
  // would read as a run that recorded nothing rather than as a different shape.
  const parts =
    doc.sections.length > 0
      ? [
          `${timeline} timeline event(s) (the reply shows at most 20, deduped)`,
          `${observed} observed node/property/axis delta(s) the reply carries none of`,
        ]
      : [];
  if (monkey > 0) parts.push(`${monkey} monkey action(s)`);
  if (doc.routine) parts.push(`${doc.routine.reads.length} recorded live-world reading(s)`);
  if (outcomeStates > 0) {
    parts.push(
      `the outcome-frame state slice with the complete baseline→outcome diff${doc.sections.length > 1 ? ` (${doc.sections.length} sections: ${doc.sections.map(section => section.label).join(' + ')})` : ''}`
    );
  }
  return `full protocol: ${parts.join(', ')}. Read it with fs_read {offset, limit} — it is ${Math.max(1, Math.round(bytes / 1024))} KB, do not read it whole.`;
}

// ---------------------------------------------------------------------------
// Routine recording
// ---------------------------------------------------------------------------

/**
 * Wrap a {@link RoutineWorld} so every reading it answers is recorded.
 *
 * The value is passed through **unchanged**: a proxy that rounded or clipped a
 * reading would falsify the very run it is supposed to record, and the routine's
 * expectations are judged on what this returns. Only the recorded *copy* is
 * serialized. `framesElapsed`, `settle`, `errorCount`, `errorsSince`,
 * `readCommandJournal` and `watchSignals` are forwarded untouched — the first two
 * are clocks (recording them would be recording the harness), and the last three
 * already reach the reply in full.
 *
 * Optional members stay optional: wrapping one the world does not have would turn
 * "this runtime cannot sample axes" into "it can, and it answers undefined",
 * which is a different sentence in every predicate that reads it.
 */
export function recordRoutineWorld(
  world: RoutineWorld,
  reads: ProtocolRoutineRead[]
): RoutineWorld {
  const record = <T>(call: string, args: Json | undefined, value: T): T => {
    if (reads.length < MAX_PROTOCOL_ENTRIES) {
      reads.push({
        seq: reads.length + 1,
        call,
        ...(args !== undefined ? { args } : {}),
        value: protocolJson(value),
      });
    }
    return value;
  };

  return {
    ...world,
    nodeExists: query => record('nodeExists', { query }, world.nodeExists(query)),
    snapshotNode: query => record('snapshotNode', { query }, world.snapshotNode(query)),
    readNodeProperty: (query, path) =>
      record('readNodeProperty', { query, path }, world.readNodeProperty(query, path)),
    countNodesOfType: type => record('countNodesOfType', { type }, world.countNodesOfType(type)),
    sampleGameState: () => record('sampleGameState', undefined, world.sampleGameState()),
    dispatchCommand: (name, args) =>
      record(
        'dispatchCommand',
        { name, ...(args ? { args } : {}) },
        world.dispatchCommand(name, args)
      ),
    runInput: async steps => {
      const result = await world.runInput(steps);
      return record('runInput', protocolJson(steps), result);
    },
    ...(world.readAxis
      ? { readAxis: (name: string) => record('readAxis', { name }, world.readAxis?.(name)) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const round = (value: number): number =>
  Number.isFinite(value) ? Number(value.toFixed(DELTA_PRECISION)) : value;

/**
 * The leaves of one frame's node snapshots, rounded so renderer noise is not a
 * delta. Built per frame rather than kept as the snapshots themselves: the
 * snapshot objects are live captures and comparing them structurally would
 * re-round on every comparison.
 */
function nodeLeafMap(
  nodes: ReadonlyMap<string, LiveNodeSnapshot>
): Map<string, Record<string, Json>> {
  const out = new Map<string, Record<string, Json>>();
  for (const [query, snapshot] of nodes) {
    out.set(query, {
      'position.x': round(snapshot.position.x),
      'position.y': round(snapshot.position.y),
      'position.z': round(snapshot.position.z),
      'worldPosition.x': round(snapshot.worldPosition.x),
      'worldPosition.y': round(snapshot.worldPosition.y),
      'worldPosition.z': round(snapshot.worldPosition.z),
      rotationZ: round(snapshot.rotationZ),
      'scale.x': round(snapshot.scale.x),
      'scale.y': round(snapshot.scale.y),
      'scale.z': round(snapshot.scale.z),
      visible: snapshot.visible,
      childCount: snapshot.childCount,
      visibleChildCount: snapshot.visibleChildCount,
    });
  }
  return out;
}

/**
 * A property reading's map key, made readable.
 *
 * `nodePropertyKey` joins the node and the path with a NUL byte — the right choice
 * for an in-memory Map key that must never collide with a dotted path, and the
 * wrong one for a file: `"ScoreLabel text"` is a key nobody can quote back at
 * a tool. The dotted form is the one the spec names, and the pair is unambiguous
 * enough for evidence.
 */
const readableKey = (key: string): string => key.replace(/\0/g, '.');

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

const sameJson = (a: Json, b: Json): boolean =>
  a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const formatScalar = (value: Json): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null');

/** UTF-8 bytes, not characters: the number a caller compares against a context budget. */
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
