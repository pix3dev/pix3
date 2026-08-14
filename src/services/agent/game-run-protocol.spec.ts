import { describe, expect, it, vi } from 'vitest';

import type { Json } from '@/core/agent-introspection';
import {
  buildRunProtocolDocument,
  MAX_PROTOCOL_ENTRIES,
  MAX_STORED_REPORTS,
  nextReportName,
  planRotation,
  protocolReply,
  recordRoutineWorld,
  REPORT_DIRECTORY,
  RunProtocolRecorder,
  saveRunProtocol,
  type ProtocolRoutineRead,
  type RunProtocolDocument,
  type RunProtocolStore,
} from './game-run-protocol';
import type { AssertionFrame } from './game-assertions';
import type { RoutineWorld } from './game-routines';
import type { LiveNodeSnapshot } from './GameInputService';

/** An in-memory {@link RunProtocolStore}: names → text, exactly what the file backend stores. */
function makeStore(existing: string[] = []): RunProtocolStore & { files: Map<string, string> } {
  const files = new Map<string, string>(existing.map(name => [name, '{}']));
  return {
    files,
    list: async () => [...files.keys()].sort(),
    save: async (name, text) => {
      files.set(name, text);
    },
    delete: async name => {
      files.delete(name);
    },
  };
}

const makeDoc = (over: Partial<RunProtocolDocument> = {}): RunProtocolDocument => ({
  ...buildRunProtocolDocument({
    kind: 'game_run',
    subject: 'run',
    startedAt: '2026-01-01T00:00:00.000Z',
    editorVersion: '1.3.0',
    sceneId: 'scenes/main.pix3scene',
    reply: { ok: true, verdict: 'PASS' },
    sections: [
      {
        label: 'main',
        timeline: [{ frame: 3, kind: 'state', note: 'score 0→1' }],
        observed: [
          { frame: 3, channel: 'transform', key: 'Player.worldPosition.x', from: 0, to: 1 },
        ],
        outcomeState: { frame: 3, provider: 'demo', baseline: null, snapshot: null, changed: {} },
      },
    ],
  }),
  ...over,
});

/** A frame as the loop feeds it; only the fields a case is about are spelled out. */
const makeFrame = (over: Partial<AssertionFrame> & { frame: number }): AssertionFrame => ({
  gameTimeMs: over.frame * 16,
  gameState: null,
  presentNodes: new Set<string>(),
  newErrorCount: 0,
  ...over,
});

/** A live node reading, at rest unless a case moves it. */
const makeNodeSnapshot = (over: Partial<LiveNodeSnapshot> = {}): LiveNodeSnapshot => ({
  nodeId: 'n1',
  name: 'Player',
  type: 'Sprite2D',
  visible: true,
  position: { x: 0, y: 0, z: 0 },
  worldPosition: { x: 0, y: 0, z: 0 },
  rotationZ: 0,
  scale: { x: 1, y: 1, z: 1 },
  childCount: 0,
  visibleChildCount: 0,
  ...over,
});

describe('report file names', () => {
  it('numbers from the directory, so the names sort chronologically without a clock in them', () => {
    const name = nextReportName(['0001-run-pass-f5.json', '0004-monkey-fail-f9.json'], {
      subject: 'run',
      verdict: 'timeout',
      frame: 600,
    });
    expect(name).toBe('0005-run-timeout-f600.json');

    // And the number is what makes an ascending sort chronological: the second run of
    // a session sorts after the first whatever its subject or verdict is called.
    const first = nextReportName([], { subject: 'zebra', verdict: 'pass', frame: 1 });
    const second = nextReportName([first], { subject: 'aardvark', verdict: 'fail', frame: 2 });
    expect([second, first].sort()).toEqual([first, second]);
  });

  it('slugs the subject and the verdict, and clips a runaway subject', () => {
    expect(
      nextReportName([], { subject: 'Routine: Menu → Play!', verdict: 'PASS', frame: 74 })
    ).toBe('0001-routine-menu-play-pass-f74.json');
    // 40 characters of subject, and never a trailing dash from the clip — a name
    // ending in `--fail` reads as a missing field.
    const long = nextReportName([], { subject: 'a'.repeat(60), verdict: 'fail' });
    expect(long).toBe(`0001-${'a'.repeat(40)}-fail.json`);
  });

  it('ignores files that carry no counter rather than restarting the numbering', () => {
    // A human's own notes.json in the directory must not make the next run overwrite 0001.
    expect(
      nextReportName(['notes.json', '0009-run-pass-f5.json'], { subject: 'run', verdict: 'pass' })
    ).toBe('0010-run-pass.json');
  });
});

describe('rotation', () => {
  it('keeps the newest and returns the oldest, oldest first', () => {
    const names = ['0001-a.json', '0002-b.json', '0003-c.json', '0004-d.json'];
    expect(planRotation(names, 2)).toEqual(['0001-a.json', '0002-b.json']);
    expect(planRotation(names, 10)).toEqual([]);
  });

  it('deletes the oldest beyond the cap and NAMES them, so a lost report is never silent', async () => {
    const existing = Array.from(
      { length: MAX_STORED_REPORTS + 1 },
      (_unused, index) => `${String(index + 1).padStart(4, '0')}-run-pass-f5.json`
    );
    const store = makeStore(existing);

    const artifact = await saveRunProtocol(store, makeDoc(), {
      subject: 'run',
      verdict: 'pass',
      frame: 7,
    });

    expect(artifact.written).toBe(true);
    if (!artifact.written) return;
    expect(artifact.path).toBe(`${REPORT_DIRECTORY}/0022-run-pass-f7.json`);
    // Two over the cap once the new one is counted, and the two named are the oldest.
    expect(artifact.pruned).toEqual(['0001-run-pass-f5.json', '0002-run-pass-f5.json']);
    expect(artifact.note).toContain(`newest ${MAX_STORED_REPORTS}`);
    expect(store.files.has('0001-run-pass-f5.json')).toBe(false);
    // The file just written is never the one pruned.
    expect(store.files.has('0022-run-pass-f7.json')).toBe(true);
  });

  it('writes pretty-printed JSON, because fs_read pages by LINES', async () => {
    const store = makeStore();
    const artifact = await saveRunProtocol(store, makeDoc(), { subject: 'run', verdict: 'pass' });

    expect(artifact.written).toBe(true);
    if (!artifact.written) return;
    const text = store.files.get('0001-run-pass.json')!;
    expect(text.split('\n').length).toBeGreaterThan(20);
    expect(artifact.bytes).toBe(new TextEncoder().encode(text).length);
    expect(artifact.contains).toMatch(/fs_read \{offset, limit\}/);
    // The outline is the first thing in the file for the same reason: a 40-line read
    // has to be enough to decide which slice is worth a second one.
    expect(JSON.parse(text).outline.join(' ')).toContain('1 timeline event(s)');
  });
});

describe('a protocol that could not be written', () => {
  it('says a project must be open AND that the data is gone, rather than failing quietly', async () => {
    const artifact = await saveRunProtocol(null, makeDoc(), { subject: 'run', verdict: 'pass' });

    expect(artifact.written).toBe(false);
    if (artifact.written) return;
    expect(artifact.reason).toMatch(/No project is open/);
    expect(artifact.reason).toMatch(/is gone when this reply is compacted/);
    expect(artifact.reason).toContain(REPORT_DIRECTORY);
  });

  it('reports a storage failure with its message instead of failing the run that produced it', async () => {
    const store = makeStore();
    store.save = vi.fn(async () => {
      throw new Error('The user revoked write permission');
    });

    const artifact = await saveRunProtocol(store, makeDoc(), { subject: 'run', verdict: 'pass' });

    expect(artifact.written).toBe(false);
    if (artifact.written) return;
    expect(artifact.reason).toMatch(/Could not write.*revoked write permission/);
    expect(artifact.reason).toMatch(/run itself is unaffected/);
  });

  it('does not fail the save when a rotation delete throws — the report is already on disk', async () => {
    const existing = Array.from(
      { length: MAX_STORED_REPORTS + 1 },
      (_unused, index) => `${String(index + 1).padStart(4, '0')}-run-pass-f5.json`
    );
    const store = makeStore(existing);
    store.delete = vi.fn(async () => {
      throw new Error('locked by another process');
    });

    const artifact = await saveRunProtocol(store, makeDoc(), { subject: 'run', verdict: 'pass' });

    expect(artifact.written).toBe(true);
    if (!artifact.written) return;
    expect(artifact.pruned).toBeUndefined();
    expect(artifact.note).toMatch(/Could not delete.*locked by another process/);
  });
});

/**
 * The recorder's whole job is to hold what the REPLY throws away, so most cases
 * below name the reply cap they exist to survive: the reply folds a value that ticks
 * every frame into one row (`Timeline.add` dedups on the last key), keeps 20 entries
 * and 3 changed paths per frame, slices an error message to 120 characters, keeps
 * only a head and a tail of the monkey log, and carries no per-frame
 * node/property/axis reading at all.
 */
describe('RunProtocolRecorder', () => {
  const frameAt = (frame: number, over: Partial<AssertionFrame> = {}): AssertionFrame =>
    makeFrame({ frame, ...over });

  /** The same node at `x`, on both the local and the world axis. */
  const snapshotAt = (x: number): LiveNodeSnapshot =>
    makeNodeSnapshot({ position: { x, y: 0, z: 0 }, worldPosition: { x, y: 0, z: 0 } });

  it('emits nothing for the first frame it is fed — there is no "before" for a baseline', () => {
    const recorder = new RunProtocolRecorder('main');
    recorder.frame(
      frameAt(0, { gameState: { score: 0 }, nodes: new Map([['Player', snapshotAt(0)]]) })
    );
    const section = recorder.section();
    // Inventing a "before" from zeros would report the whole game as having changed
    // on frame 0, which is the one frame nothing has happened on yet.
    expect(section.timeline).toEqual([]);
    expect(section.observed).toEqual([]);
  });

  it('reports a node entering or leaving the map as a delta with null on the missing side', () => {
    const recorder = new RunProtocolRecorder('main');
    recorder.frame(frameAt(0, { nodes: new Map(), typeCounts: new Map([['Enemy2D', 0]]) }));
    recorder.frame(
      frameAt(1, {
        nodes: new Map([['Player', snapshotAt(5)]]),
        typeCounts: new Map([['Enemy2D', 2]]),
      })
    );
    recorder.frame(frameAt(2, { nodes: new Map(), typeCounts: new Map([['Enemy2D', 2]]) }));

    const observed = recorder.section().observed;
    // A spawn and a death are visible in the delta channel, not only in the timeline's
    // name-based view — which is the only reading a pooled node cannot fake.
    expect(observed.find(delta => delta.frame === 1 && delta.key === 'Player.position.x')).toEqual({
      frame: 1,
      channel: 'transform',
      key: 'Player.position.x',
      from: null,
      to: 5,
    });
    expect(observed.find(delta => delta.frame === 2 && delta.key === 'Player.position.x')).toEqual({
      frame: 2,
      channel: 'transform',
      key: 'Player.position.x',
      from: 5,
      to: null,
    });
    expect(observed.find(delta => delta.channel === 'typeCount')).toEqual({
      frame: 1,
      channel: 'typeCount',
      key: 'Enemy2D',
      from: 0,
      to: 2,
    });
  });

  it('rounds transforms and axes, so renderer noise is not recorded as movement', () => {
    const recorder = new RunProtocolRecorder('main');
    recorder.frame(
      frameAt(0, {
        nodes: new Map([['Player', snapshotAt(1)]]),
        axes: new Map([['Horizontal', 0]]),
      })
    );
    recorder.frame(
      frameAt(1, {
        // A world-matrix wobble below the 4-decimal precision, and the same for the axis.
        nodes: new Map([['Player', snapshotAt(1 + 1e-9)]]),
        axes: new Map([['Horizontal', 1e-9]]),
      })
    );
    expect(recorder.section().observed).toEqual([]);

    recorder.frame(
      frameAt(2, {
        nodes: new Map([['Player', snapshotAt(1.5)]]),
        axes: new Map([['Horizontal', 0]]),
      })
    );
    expect(recorder.section().observed.map(delta => delta.key)).toEqual([
      'Player.position.x',
      'Player.worldPosition.x',
    ]);
  });

  it('names the array and the frame when a cap bites, and stops only that array', () => {
    const recorder = new RunProtocolRecorder('main');
    // 1 000 changing scalars per frame: the timeline overflows in 21 frames while the
    // transform channel is nowhere near its own cap.
    const wide = (frame: number): Json =>
      Object.fromEntries(Array.from({ length: 1_000 }, (_unused, index) => [`v${index}`, frame]));
    for (let frame = 0; frame <= 25; frame += 1) {
      recorder.frame(
        frameAt(frame, {
          gameState: wide(frame),
          nodes: new Map([['Player', snapshotAt(frame)]]),
        })
      );
    }

    const section = recorder.section();
    expect(section.timeline).toHaveLength(MAX_PROTOCOL_ENTRIES);
    expect(section.truncated).toHaveLength(1);
    expect(section.truncated?.[0]).toMatch(
      new RegExp(`timeline array hit its ${MAX_PROTOCOL_ENTRIES}-entry cap at frame \\d+`)
    );
    // Truncating both would throw away the cheap half of the evidence to protect the
    // expensive one: 25 frames × 2 moved leaves, all of them still here.
    expect(section.observed).toHaveLength(50);
  });

  it('records EVERY state change, frame by frame, where the reply folds them into one row', () => {
    const recorder = new RunProtocolRecorder('main');
    for (let frame = 0; frame <= 3; frame += 1) {
      recorder.frame(frameAt(frame, { gameState: { score: frame } }));
    }

    // Three changes, three entries. The reply shows ONE row reading `score 2→3` with
    // `count: 3`, which can no longer answer "on which frame did it first tick".
    expect(recorder.section().timeline).toEqual([
      { frame: 1, kind: 'state', note: 'score 0→1' },
      { frame: 2, kind: 'state', note: 'score 1→2' },
      { frame: 3, kind: 'state', note: 'score 2→3' },
    ]);
  });

  it('records every changed path of one frame, where the reply keeps three', () => {
    const recorder = new RunProtocolRecorder('main');
    const state = (n: number): Json => ({ a: n, b: n, c: n, d: n, e: n, nested: { f: n } });
    recorder.frame(frameAt(0, { gameState: state(0) }));
    recorder.frame(frameAt(1, { gameState: state(1) }));

    // Six, not three: a frame that changed six things at once is exactly the frame
    // worth reading whole, and the reply's per-frame cap is what hides half of it.
    expect(recorder.section().timeline.map(entry => entry.note)).toEqual([
      'a 0→1',
      'b 0→1',
      'c 0→1',
      'd 0→1',
      'e 0→1',
      'nested.f 0→1',
    ]);
  });

  it('keeps the FULL error message, not the reply 120-character slice', () => {
    const recorder = new RunProtocolRecorder('main');
    const message = `TypeError: cannot read x of undefined${' at Player.update'.repeat(20)}`;
    recorder.frame(frameAt(0));
    recorder.frame(frameAt(4, { newErrorCount: 1 }), { source: 'user:Player.ts', message });

    const [entry] = recorder.section().timeline;
    expect(entry).toEqual({ frame: 4, kind: 'error', note: `user:Player.ts: ${message}` });
    // The argument for the whole file in one assertion: a stack-carrying error is
    // unreadable at 120 characters, and re-running the game to see the rest is the
    // cost this report removes.
    expect(entry.note.length).toBeGreaterThan(120);
  });

  it('records an error count that rose without a message, rather than dropping the frame', () => {
    const recorder = new RunProtocolRecorder('main');
    recorder.frame(frameAt(0));
    recorder.frame(frameAt(2, { newErrorCount: 1 }));

    expect(recorder.section().timeline).toEqual([
      { frame: 2, kind: 'error', note: 'runtime error' },
    ]);
  });

  it('reports a node leaving and appearing under the name the test used', () => {
    const recorder = new RunProtocolRecorder('main');
    recorder.frame(frameAt(0, { presentNodes: new Set(['Player', 'Boss']) }));
    recorder.frame(frameAt(9, { presentNodes: new Set(['Player', 'Coin']) }));

    expect(recorder.section().timeline).toEqual([
      { frame: 9, kind: 'gone', note: 'Boss' },
      { frame: 9, kind: 'appeared', note: 'Coin' },
    ]);
  });

  it('records the node leaves a movement never touches, which the reply omits entirely', () => {
    const recorder = new RunProtocolRecorder('main');
    recorder.frame(frameAt(0, { nodes: new Map([['Player', makeNodeSnapshot()]]) }));
    recorder.frame(
      frameAt(1, {
        nodes: new Map([
          ['Player', makeNodeSnapshot({ visible: false, childCount: 2, visibleChildCount: 1 })],
        ]),
      })
    );

    // Visibility and child counts are readings no timeline entry carries and the reply
    // has no channel for at all — a pool that stopped recycling shows up here first.
    expect(recorder.section().observed).toEqual([
      { frame: 1, channel: 'transform', key: 'Player.visible', from: true, to: false },
      { frame: 1, channel: 'transform', key: 'Player.childCount', from: 0, to: 2 },
      { frame: 1, channel: 'transform', key: 'Player.visibleChildCount', from: 0, to: 1 },
    ]);
  });

  it('records property readings, keyed by the query, and a count that fell', () => {
    const properties = (text: string) =>
      new Map([
        ['Score.text', text],
        // Looked at and absent: `has(key) === true` with an undefined value. The
        // protocol keeps it as `null`, because the sentence that separates a harness
        // fault from a typo is the reply's job, not this file's.
        ['Hud.missing', undefined],
      ]);
    const recorder = new RunProtocolRecorder('main');
    recorder.frame(
      frameAt(0, { nodeProperties: properties('Score: 0'), typeCounts: new Map([['Enemy2D', 3]]) })
    );
    recorder.frame(
      frameAt(6, { nodeProperties: properties('Score: 1'), typeCounts: new Map([['Enemy2D', 2]]) })
    );

    expect(recorder.section().observed).toEqual([
      { frame: 6, channel: 'property', key: 'Score.text', from: 'Score: 0', to: 'Score: 1' },
      { frame: 6, channel: 'typeCount', key: 'Enemy2D', from: 3, to: 2 },
    ]);
  });

  it('keeps the whole monkey log, and the seed even when nothing was pressed', () => {
    const recorder = new RunProtocolRecorder('main', 42);
    for (let frame = 1; frame <= 40; frame += 1) {
      recorder.monkeyAction({ frame, action: { kind: 'key', code: 'Space' }, status: 'sent' });
    }
    recorder.monkeyAction({
      frame: 41,
      action: { kind: 'tap', target: 'Buy' },
      status: 'refused',
      note: 'disabled',
    });

    const monkey = recorder.section().monkey;
    // The reply keeps a head and a tail; the middle is where a monkey run's story
    // usually is, since the press that broke it is rarely in the first or last five.
    expect(monkey?.actions).toHaveLength(41);
    expect(monkey?.actions[40]).toEqual({
      frame: 41,
      action: { kind: 'tap', target: 'Buy' },
      status: 'refused',
      note: 'disabled',
    });
    expect(monkey?.seed).toBe(42);

    // A monkey that pressed NOTHING still records which seed produced that nothing:
    // a finding nobody can re-run is an anecdote.
    expect(new RunProtocolRecorder('main', 7).section().monkey).toEqual({ seed: 7, actions: [] });
    // …and a run with no monkey at all claims no seed rather than reporting `null`.
    expect(new RunProtocolRecorder('main').section().monkey).toBeUndefined();
  });

  it('records the outcome frame with the FULL baseline→outcome diff', () => {
    const recorder = new RunProtocolRecorder('main');
    recorder.outcome({
      frame: 120,
      provider: 'demo',
      baseline: { score: 0, lives: { count: 3 }, combo: 1 },
      snapshot: { score: 9, lives: { count: 2 }, combo: 1 },
    });

    const outcome = recorder.section().outcomeState;
    expect(outcome?.frame).toBe(120);
    expect(outcome?.changed).toEqual({ score: [0, 9], 'lives.count': [3, 2] });
    // Both snapshots verbatim next to the diff: the reply carries a capped diff, and a
    // diff cannot answer a question about a field that did NOT change.
    expect(outcome?.baseline).toEqual({ score: 0, lives: { count: 3 }, combo: 1 });
    expect(outcome?.snapshot).toEqual({ score: 9, lives: { count: 2 }, combo: 1 });
  });

  it('treats a missing snapshot on either side as a diff against nothing', () => {
    const recorder = new RunProtocolRecorder('main');
    recorder.outcome({ frame: 3, provider: null, baseline: null, snapshot: { score: 4 } });

    const outcome = recorder.section().outcomeState;
    expect(outcome?.provider).toBeNull();
    expect(outcome?.changed).toEqual({ score: [null, 4] });
  });

  it('hands the notes to the document and labels the section', () => {
    const recorder = new RunProtocolRecorder('control');
    recorder.note('This section is the NEGATIVE CONTROL.');

    expect([...recorder.notes()]).toEqual(['This section is the NEGATIVE CONTROL.']);
    // The label is what lets a reader compare sections[0] against sections[1]; the note
    // explaining the second one belongs to the document, which owns both.
    expect(recorder.section().label).toBe('control');
    expect(recorder.section()).not.toHaveProperty('notes');
  });
});

describe('protocolReply', () => {
  it('drops the artifact pointer, which rotation would make stale', () => {
    const reply = protocolReply({
      ok: true,
      verdict: 'PASS',
      artifact: { written: true, path: 'design/tests/reports/0001-run-pass-f5.json' },
    }) as Record<string, unknown>;
    expect(reply).toEqual({ ok: true, verdict: 'PASS' });
  });

  it('trims nothing else, so the embedded reply really is verbatim', () => {
    const timeline = Array.from({ length: 150 }, (_unused, index) => ({ frame: index }));
    const reply = protocolReply({ ok: true, timeline }) as Record<string, unknown>;

    // 150, not 100: a file that claims to hold the reply *verbatim* must not go through
    // the depth-limited serialiser, which caps arrays at 100 entries and objects at 60.
    expect(reply.timeline).toHaveLength(150);
  });

  it('does not fail the run when the reply cannot be JSON-copied', () => {
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;

    // The protocol is evidence about a run, never a reason for one to fail.
    expect(() => protocolReply(cyclic)).not.toThrow();
    expect(protocolReply(cyclic)).not.toBeNull();
  });
});

describe('recordRoutineWorld', () => {
  const snapshot: LiveNodeSnapshot = {
    nodeId: 'n1',
    name: 'Player',
    type: 'Sprite2D',
    visible: true,
    position: { x: 1, y: 2, z: 3 },
    worldPosition: { x: 1, y: 2, z: 3 },
    rotationZ: 0,
    scale: { x: 1, y: 1, z: 1 },
    childCount: 0,
    visibleChildCount: 0,
  };
  const gameState = { name: 'demo', snapshot: { score: 3, nested: { lives: 2 } } as Json };

  const makeWorld = (): RoutineWorld => ({
    nodeExists: vi.fn(() => true),
    runInput: vi.fn(async () => ({ ok: true })),
    dispatchCommand: vi.fn(() => ({ ok: true })),
    sampleGameState: vi.fn(() => gameState),
    errorCount: vi.fn(() => 0),
    errorsSince: vi.fn(() => []),
    snapshotNode: vi.fn(() => snapshot),
    readNodeProperty: vi.fn(() => 'Score: 3'),
    countNodesOfType: vi.fn(() => 4),
    readAxis: vi.fn(() => -0.5),
    framesElapsed: vi.fn(() => 12),
    settle: vi.fn(async () => {}),
  });

  it('passes every reading through unchanged — a proxy that reshaped one would falsify the run', async () => {
    const raw = makeWorld();
    const reads: ProtocolRoutineRead[] = [];
    const wrapped = recordRoutineWorld(raw, reads);

    expect(wrapped.nodeExists('Player')).toBe(raw.nodeExists('Player'));
    // Identity, not equality: the driver's `nodeMoved` measures displacement off this
    // very object, so a copy here would already be a different reading.
    expect(wrapped.snapshotNode('Player')).toBe(snapshot);
    expect(wrapped.readNodeProperty('ScoreLabel', 'text')).toBe('Score: 3');
    expect(wrapped.countNodesOfType('Enemy2D')).toBe(4);
    expect(wrapped.readAxis?.('Horizontal')).toBe(-0.5);
    expect(wrapped.sampleGameState()).toBe(gameState);
    expect(wrapped.dispatchCommand('shop.buy', { slot: 2 })).toEqual({ ok: true });
    await expect(wrapped.runInput([{ type: 'tap', target: 'Buy' }])).resolves.toEqual({ ok: true });
    expect(raw.readNodeProperty).toHaveBeenCalledWith('ScoreLabel', 'text');
  });

  it('records the full sampleGameState snapshots the reply only carries a diff of', () => {
    const reads: ProtocolRoutineRead[] = [];
    const wrapped = recordRoutineWorld(makeWorld(), reads);

    wrapped.sampleGameState();
    wrapped.readAxis?.('Horizontal');

    expect(reads).toEqual([
      { seq: 1, call: 'sampleGameState', value: gameState },
      { seq: 2, call: 'readAxis', args: { name: 'Horizontal' }, value: -0.5 },
    ]);
    // The nested object is there in full: the reply flattens the snapshot to scalars
    // and keeps 20 of them, and this is where the rest of it lives.
    expect(
      (reads[0].value as { snapshot: { nested: { lives: number } } }).snapshot.nested.lives
    ).toBe(2);
  });

  it('leaves an optional member the world does not have absent', () => {
    const world = makeWorld();
    delete world.readAxis;
    const wrapped = recordRoutineWorld(world, []);
    // Wrapping it anyway would turn "this runtime cannot sample axes" into "it can,
    // and it answers undefined" — a different sentence in every predicate that reads it.
    expect(wrapped.readAxis).toBeUndefined();
    expect(wrapped.framesElapsed?.()).toBe(12);
  });
});
