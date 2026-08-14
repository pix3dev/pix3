import { describe, expect, it } from 'vitest';

import type { GameCommandLogEntry } from '@pix3/runtime';
import {
  assertionAxisNames,
  assertionNodeNames,
  assertionPropertyReads,
  assertionSignalWatches,
  assertionSnapshotNames,
  assertionTypeQueries,
  assertionsNeedCommands,
  assertionsNeedGameState,
  compareJson,
  describeAssertion,
  evaluateAssertion,
  firstMetAssertion,
  nodePropertyKey,
  parseAssertion,
  parseAssertions,
  resolveJsonPath,
  signalWatchKey,
  type AssertionFrame,
  type CommandWindow,
  type GameAssertion,
  type SignalObservation,
} from './game-assertions';
import type { LiveNodeSnapshot } from './GameInputService';

/**
 * Predicates are pure functions of two records, so every case here is a literal:
 * no runner, no scene, no clock. That is the whole point of the split from
 * `GameTestService` — the loop is expensive to fake, the predicates are not, and
 * they are what decides pass/fail.
 */

const makeFrame = (over: Partial<AssertionFrame> = {}): AssertionFrame => ({
  frame: 0,
  gameTimeMs: 0,
  gameState: null,
  presentNodes: new Set<string>(),
  newErrorCount: 0,
  ...over,
});

const logEntry = (over: Partial<GameCommandLogEntry> = {}): GameCommandLogEntry => ({
  frame: 12,
  name: 'open-menu',
  status: 'ok',
  ...over,
});

const commandWindow = (over: Partial<CommandWindow> = {}): CommandWindow => ({
  entries: [],
  dropped: 0,
  available: true,
  ...over,
});

const observation = (over: Partial<SignalObservation> = {}): SignalObservation => ({
  count: 0,
  firstFrame: 0,
  lastFrame: 0,
  emitters: [],
  attached: 1,
  everAttached: true,
  ...over,
});

const signalFrame = (
  entries: Array<[{ name: string; node?: string }, SignalObservation]>
): AssertionFrame =>
  makeFrame({
    signals: new Map(entries.map(([spec, obs]) => [signalWatchKey(spec), obs])),
  });

describe('resolveJsonPath', () => {
  it('walks nested objects', () => {
    expect(resolveJsonPath({ gun: { ammo: { mag: 3 } } }, 'gun.ammo.mag')).toBe(3);
  });

  it('indexes into arrays with numeric segments', () => {
    expect(resolveJsonPath({ waves: [{ enemies: 4 }, { enemies: 9 }] }, 'waves.1.enemies')).toBe(9);
  });

  it('distinguishes a missing path from a present null', () => {
    expect(resolveJsonPath({ score: null }, 'score')).toBeNull();
    expect(resolveJsonPath({ score: null }, 'nope')).toBeUndefined();
  });

  it('returns undefined when the path runs past a scalar or a bad index', () => {
    expect(resolveJsonPath({ score: 1 }, 'score.deeper')).toBeUndefined();
    expect(resolveJsonPath({ waves: [1] }, 'waves.5')).toBeUndefined();
    expect(resolveJsonPath(null, 'score')).toBeUndefined();
  });
});

describe('compareJson', () => {
  it('compares structurally for eq/ne', () => {
    expect(compareJson({ a: 1 }, 'eq', { a: 1 })).toBe(true);
    expect(compareJson({ a: 1 }, 'ne', { a: 2 })).toBe(true);
    expect(compareJson(undefined, 'eq', null)).toBe(true);
  });

  it('refuses to order non-numbers rather than leaning on JS coercion', () => {
    expect(compareJson('3', 'gt', 2)).toBe(false);
    expect(compareJson(3, 'gt', 2)).toBe(true);
    expect(compareJson(2, 'gte', 2)).toBe(true);
    expect(compareJson(1, 'lt', 2)).toBe(true);
    expect(compareJson(2, 'lte', 2)).toBe(true);
  });

  it('handles contains for strings and arrays', () => {
    expect(compareJson('game over', 'contains', 'over')).toBe(true);
    expect(compareJson(['a', 'b'], 'contains', 'b')).toBe(true);
    expect(compareJson(7, 'contains', '7')).toBe(false);
  });
});

describe('gameState', () => {
  const assertion: GameAssertion = { kind: 'gameState', path: 'wave', op: 'gte', value: 2 };

  it('holds when the scalar satisfies the operator', () => {
    const result = evaluateAssertion(assertion, makeFrame({ gameState: { wave: 3 } }), makeFrame());
    expect(result.met).toBe(true);
    expect(result.detail).toContain('wave = 3');
  });

  it('does not hold when the scalar is below the threshold', () => {
    expect(
      evaluateAssertion(assertion, makeFrame({ gameState: { wave: 1 } }), makeFrame()).met
    ).toBe(false);
  });

  it('reports the missing provider rather than silently failing', () => {
    const result = evaluateAssertion(assertion, makeFrame(), makeFrame());
    expect(result.met).toBe(false);
    expect(result.detail).toContain('registerGameDebug');
  });

  it('reports a missing path as its own reason', () => {
    const result = evaluateAssertion(
      assertion,
      makeFrame({ gameState: { score: 1 } }),
      makeFrame()
    );
    expect(result.met).toBe(false);
    expect(result.detail).toContain('no "wave"');
  });
});

describe('gameStateChanged', () => {
  const baseline = makeFrame({ gameState: { score: 0, label: 'idle' } });

  it('holds on any structural change when `by` is omitted', () => {
    const assertion: GameAssertion = { kind: 'gameStateChanged', path: 'label' };
    const result = evaluateAssertion(
      assertion,
      makeFrame({ frame: 5, gameState: { score: 0, label: 'playing' } }),
      baseline
    );
    expect(result.met).toBe(true);
    expect(result.detail).toContain('idle → playing');
  });

  it('requires the signed delta to be reached when `by` is given', () => {
    const assertion: GameAssertion = { kind: 'gameStateChanged', path: 'score', by: 1 };
    expect(evaluateAssertion(assertion, makeFrame({ gameState: { score: 0 } }), baseline).met).toBe(
      false
    );
    const hit = evaluateAssertion(assertion, makeFrame({ gameState: { score: 1 } }), baseline);
    expect(hit.met).toBe(true);
    expect(hit.detail).toContain('Δ+1');
  });

  it('treats a negative `by` as a drop of at least that much', () => {
    const assertion: GameAssertion = { kind: 'gameStateChanged', path: 'hp', by: -2 };
    const base = makeFrame({ gameState: { hp: 5 } });
    expect(evaluateAssertion(assertion, makeFrame({ gameState: { hp: 4 } }), base).met).toBe(false);
    expect(evaluateAssertion(assertion, makeFrame({ gameState: { hp: 3 } }), base).met).toBe(true);
    // A rise is not a drop, however large.
    expect(evaluateAssertion(assertion, makeFrame({ gameState: { hp: 50 } }), base).met).toBe(
      false
    );
  });

  it('refuses a `by` delta on a non-numeric field instead of guessing', () => {
    const assertion: GameAssertion = { kind: 'gameStateChanged', path: 'label', by: 1 };
    const result = evaluateAssertion(
      assertion,
      makeFrame({ gameState: { label: 'playing' } }),
      baseline
    );
    expect(result.met).toBe(false);
    expect(result.detail).toContain('not numeric');
  });

  it('does not hold when the path exists nowhere', () => {
    const assertion: GameAssertion = { kind: 'gameStateChanged', path: 'ghost' };
    const result = evaluateAssertion(assertion, makeFrame({ gameState: { score: 1 } }), baseline);
    expect(result.met).toBe(false);
    expect(result.detail).toContain('no "ghost"');
  });
});

describe('nodeGone', () => {
  const assertion: GameAssertion = { kind: 'nodeGone', name: 'Player' };
  const baseline = makeFrame({ presentNodes: new Set(['Player']) });

  it('holds once the node leaves the scene', () => {
    const result = evaluateAssertion(assertion, makeFrame({ frame: 12 }), baseline);
    expect(result.met).toBe(true);
    expect(result.detail).toContain('left the scene');
  });

  it('does not hold while the node is still there', () => {
    const result = evaluateAssertion(
      assertion,
      makeFrame({ presentNodes: new Set(['Player']) }),
      baseline
    );
    expect(result.met).toBe(false);
    expect(result.detail).toContain('still in the scene');
  });

  it('says so when the node was never there — a hollow pass otherwise', () => {
    const result = evaluateAssertion(assertion, makeFrame(), makeFrame());
    expect(result.met).toBe(true);
    expect(result.detail).toContain('already absent at frame 0');
  });
});

describe('newErrors', () => {
  it('defaults to one error', () => {
    const assertion: GameAssertion = { kind: 'newErrors' };
    expect(evaluateAssertion(assertion, makeFrame({ newErrorCount: 0 }), makeFrame()).met).toBe(
      false
    );
    expect(evaluateAssertion(assertion, makeFrame({ newErrorCount: 1 }), makeFrame()).met).toBe(
      true
    );
  });

  it('honours an explicit minimum', () => {
    const assertion: GameAssertion = { kind: 'newErrors', min: 3 };
    expect(evaluateAssertion(assertion, makeFrame({ newErrorCount: 2 }), makeFrame()).met).toBe(
      false
    );
    expect(evaluateAssertion(assertion, makeFrame({ newErrorCount: 3 }), makeFrame()).met).toBe(
      true
    );
  });
});

describe('frames', () => {
  it('holds once the run reaches the frame', () => {
    const assertion: GameAssertion = { kind: 'frames', n: 10 };
    expect(evaluateAssertion(assertion, makeFrame({ frame: 9 }), makeFrame()).met).toBe(false);
    expect(evaluateAssertion(assertion, makeFrame({ frame: 10 }), makeFrame()).met).toBe(true);
  });
});

describe('firstMetAssertion', () => {
  it('returns the first assertion that holds, with its index', () => {
    const assertions: GameAssertion[] = [
      { kind: 'frames', n: 100 },
      { kind: 'newErrors' },
      { kind: 'frames', n: 1 },
    ];
    const hit = firstMetAssertion(assertions, makeFrame({ frame: 5 }), makeFrame());
    expect(hit?.index).toBe(2);
  });

  it('returns null when none hold', () => {
    expect(firstMetAssertion([{ kind: 'frames', n: 100 }], makeFrame(), makeFrame())).toBeNull();
  });

  it('returns null for an empty list, so an absent `fail` channel never fires', () => {
    expect(firstMetAssertion([], makeFrame({ frame: 9 }), makeFrame())).toBeNull();
  });
});

describe('metadata helpers', () => {
  it('collects the node names the loop must resolve', () => {
    expect(
      assertionNodeNames([
        { kind: 'nodeGone', name: 'Player' },
        { kind: 'frames', n: 3 },
        { kind: 'nodeGone', name: 'Player' },
      ])
    ).toEqual(['Player']);
  });

  it('knows when game state must be sampled every frame', () => {
    expect(assertionsNeedGameState([{ kind: 'frames', n: 3 }])).toBe(false);
    expect(assertionsNeedGameState([{ kind: 'gameStateChanged', path: 'score' }])).toBe(true);
  });

  it('labels assertions compactly', () => {
    expect(describeAssertion({ kind: 'gameStateChanged', path: 'score', by: 1 })).toBe(
      'gameStateChanged score by +1'
    );
    expect(describeAssertion({ kind: 'gameState', path: 'wave', op: 'gte', value: 2 })).toBe(
      'gameState wave gte 2'
    );
    expect(describeAssertion({ kind: 'nodeGone', name: 'Player' })).toBe('nodeGone Player');
    expect(describeAssertion({ kind: 'newErrors' })).toBe('newErrors');
    expect(describeAssertion({ kind: 'frames', n: 30 })).toBe('frames 30');
    expect(describeAssertion({ kind: 'command', name: 'open-menu' })).toBe('command open-menu');
    expect(describeAssertion({ kind: 'command', name: 'buy-item', args: { slot: 2 } })).toBe(
      'command buy-item {"slot":2}'
    );
    expect(describeAssertion({ kind: 'signal', name: 'toggled', node: 'Music' })).toBe(
      'signal Music.toggled'
    );
    expect(describeAssertion({ kind: 'signal', name: 'died' })).toBe('signal died');
  });
});

/**
 * The binding proof for buttons (§5.8.4). Every negative branch is a separate
 * case on purpose: the value of this predicate is that "dispatched into a name
 * nobody registered" and "never dispatched" do not look alike in the report.
 */
describe('command predicate', () => {
  const dispatched = (entries: GameCommandLogEntry[], over: Partial<CommandWindow> = {}) =>
    makeFrame({ commands: commandWindow({ entries, ...over }) });

  it('is met by a dispatch that ran, and says how many and when', () => {
    const result = evaluateAssertion(
      { kind: 'command', name: 'open-menu' },
      dispatched([logEntry({ frame: 41 }), logEntry({ name: 'other' })]),
      makeFrame()
    );
    expect(result.met).toBe(true);
    expect(result.detail).toContain('dispatched 1×');
    expect(result.detail).toContain('41');
  });

  it('matches args as a subset — extra keys in the payload are ignored', () => {
    const frame = dispatched([
      logEntry({ name: 'buy-item', args: { slot: 2, price: 30, currency: 'gold' } }),
    ]);
    expect(
      evaluateAssertion({ kind: 'command', name: 'buy-item', args: { slot: 2 } }, frame, frame).met
    ).toBe(true);
    expect(
      evaluateAssertion({ kind: 'command', name: 'buy-item', args: { slot: 3 } }, frame, frame).met
    ).toBe(false);
  });

  it('compares a nested arg value as a whole subtree', () => {
    const frame = dispatched([logEntry({ name: 'move', args: { from: { x: 1, y: 2 } } })]);
    expect(
      evaluateAssertion(
        { kind: 'command', name: 'move', args: { from: { x: 1, y: 2 } } },
        frame,
        frame
      ).met
    ).toBe(true);
    expect(
      evaluateAssertion({ kind: 'command', name: 'move', args: { from: { x: 1 } } }, frame, frame)
        .met
    ).toBe(false);
  });

  it('reports the payloads it did see when the args do not match', () => {
    const result = evaluateAssertion(
      { kind: 'command', name: 'buy-item', args: { slot: 2 } },
      dispatched([logEntry({ name: 'buy-item', args: { slot: 1 } })]),
      makeFrame()
    );
    expect(result.met).toBe(false);
    expect(result.detail).toContain('slot":1');
  });

  it('does not silently fail when the payload was too large to journal', () => {
    const result = evaluateAssertion(
      { kind: 'command', name: 'buy-item', args: { slot: 2 } },
      dispatched([logEntry({ name: 'buy-item', argsOmitted: true })]),
      makeFrame()
    );
    expect(result.met).toBe(false);
    expect(result.detail).toContain('too large to journal');
  });

  it('refuses a dispatch that never ran, and names the reason', () => {
    const unknown = evaluateAssertion(
      { kind: 'command', name: 'open-menu' },
      dispatched([logEntry({ status: 'unknown', error: 'no command named "open-menu"' })]),
      makeFrame()
    );
    expect(unknown.met).toBe(false);
    expect(unknown.detail).toContain('nothing is registered under that name');

    const threw = evaluateAssertion(
      { kind: 'command', name: 'open-menu' },
      dispatched([logEntry({ status: 'error', error: 'boom' })]),
      makeFrame()
    );
    expect(threw.met).toBe(false);
    expect(threw.detail).toContain('boom');
  });

  it('makes a journal overflow visible instead of reading as "never dispatched"', () => {
    const result = evaluateAssertion(
      { kind: 'command', name: 'open-menu' },
      dispatched([logEntry({ name: 'tick' })], { dropped: 7 }),
      makeFrame()
    );
    expect(result.met).toBe(false);
    expect(result.detail).toContain('dropped 7');
  });

  it('says so when the command was dispatched just BEFORE the window opened', () => {
    const result = evaluateAssertion(
      { kind: 'command', name: 'open-menu' },
      dispatched([], { beforeWindow: [logEntry({ frame: 9 })] }),
      makeFrame()
    );
    expect(result.met).toBe(false);
    expect(result.detail).toContain('before the run started');
  });

  it('distinguishes "no registry at all" from "not dispatched"', () => {
    const none = evaluateAssertion(
      { kind: 'command', name: 'open-menu' },
      makeFrame({ commands: commandWindow({ available: false }) }),
      makeFrame()
    );
    expect(none.detail).toContain('no command registry');

    const uncollected = evaluateAssertion(
      { kind: 'command', name: 'open-menu' },
      makeFrame(),
      makeFrame()
    );
    expect(uncollected.detail).toContain('not collected');
  });

  it('reports a mid-run journal reset', () => {
    const result = evaluateAssertion(
      { kind: 'command', name: 'open-menu' },
      dispatched([], { reset: true }),
      makeFrame()
    );
    expect(result.detail).toContain('cleared mid-run');
  });
});

/**
 * The binding proof for stateful controls (§5.8.4): a checkbox cannot dispatch the
 * command that flips it, so `toggled` is the observable end of that wire.
 */
describe('signal predicate', () => {
  it('is met once the signal fired, with the frames and the emitters', () => {
    const frame = signalFrame([
      [
        { name: 'toggled', node: 'MusicCheckbox' },
        observation({ count: 2, firstFrame: 4, lastFrame: 9, emitters: ['MusicCheckbox'] }),
      ],
    ]);
    const result = evaluateAssertion(
      { kind: 'signal', name: 'toggled', node: 'MusicCheckbox' },
      frame,
      makeFrame()
    );
    expect(result.met).toBe(true);
    expect(result.detail).toContain('fired 2×');
    expect(result.detail).toContain('frames 4–9');
    expect(result.detail).toContain('MusicCheckbox');
  });

  it('keeps scoped and scene-wide watches apart', () => {
    const frame = signalFrame([
      [{ name: 'died' }, observation({ count: 3 })],
      [{ name: 'died', node: 'Player' }, observation({ count: 0 })],
    ]);
    expect(evaluateAssertion({ kind: 'signal', name: 'died' }, frame, makeFrame()).met).toBe(true);
    expect(
      evaluateAssertion({ kind: 'signal', name: 'died', node: 'Player' }, frame, makeFrame()).met
    ).toBe(false);
  });

  it('separates "the node was never there" from "the control stayed silent"', () => {
    const missing = evaluateAssertion(
      { kind: 'signal', name: 'toggled', node: 'Typo' },
      signalFrame([
        [{ name: 'toggled', node: 'Typo' }, observation({ attached: 0, everAttached: false })],
      ]),
      makeFrame()
    );
    expect(missing.met).toBe(false);
    expect(missing.detail).toContain('no live node named "Typo"');

    const silent = evaluateAssertion(
      { kind: 'signal', name: 'toggled', node: 'MusicCheckbox' },
      signalFrame([[{ name: 'toggled', node: 'MusicCheckbox' }, observation()]]),
      makeFrame()
    );
    expect(silent.detail).toContain('never fired');
    expect(silent.detail).toContain('listening on 1');
  });

  it('reports a sweep that could not reach every node', () => {
    const result = evaluateAssertion(
      { kind: 'signal', name: 'died' },
      signalFrame([[{ name: 'died' }, observation({ attachOverflow: true })]]),
      makeFrame()
    );
    expect(result.detail).toContain('sweep cap');
  });

  it('calls out a missing subscription as a harness problem, not a game result', () => {
    const result = evaluateAssertion({ kind: 'signal', name: 'toggled' }, makeFrame(), makeFrame());
    expect(result.met).toBe(false);
    expect(result.detail).toContain('no listener was installed');
  });
});

describe('assertion collectors', () => {
  it('flags a run that must read the command journal', () => {
    expect(assertionsNeedCommands([{ kind: 'frames', n: 1 }])).toBe(false);
    expect(assertionsNeedCommands([{ kind: 'command', name: 'open-menu' }])).toBe(true);
  });

  it('dedupes signal watches but keeps a scoped watch separate from a global one', () => {
    const watches = assertionSignalWatches([
      { kind: 'signal', name: 'toggled', node: 'Music' },
      { kind: 'signal', name: 'toggled', node: 'Music' },
      { kind: 'signal', name: 'toggled' },
      { kind: 'frames', n: 5 },
    ]);
    expect(watches).toEqual([{ name: 'toggled', node: 'Music' }, { name: 'toggled' }]);
  });

  it('does not add a signal target to the node watch list', () => {
    // `watch`/`presentNodes` is the nodeGone machinery; the signal watcher
    // resolves its own scope and reports it separately.
    expect(assertionNodeNames([{ kind: 'signal', name: 'toggled', node: 'Music' }])).toEqual([]);
  });
});

describe('parseAssertion', () => {
  it('accepts every supported kind', () => {
    expect(parseAssertion({ kind: 'gameState', path: 'wave', op: 'gte', value: 2 })).toEqual({
      assertion: { kind: 'gameState', path: 'wave', op: 'gte', value: 2 },
    });
    expect(parseAssertion({ kind: 'gameStateChanged', path: 'score', by: 1 })).toEqual({
      assertion: { kind: 'gameStateChanged', path: 'score', by: 1 },
    });
    expect(parseAssertion({ kind: 'nodeGone', name: 'Player' })).toEqual({
      assertion: { kind: 'nodeGone', name: 'Player' },
    });
    expect(parseAssertion({ kind: 'newErrors' })).toEqual({ assertion: { kind: 'newErrors' } });
    expect(parseAssertion({ kind: 'frames', n: 60 })).toEqual({
      assertion: { kind: 'frames', n: 60 },
    });
  });

  it('accepts the two binding predicates, with their optional halves', () => {
    expect(parseAssertion({ kind: 'command', name: 'buy-item', args: { slot: 2 } })).toEqual({
      assertion: { kind: 'command', name: 'buy-item', args: { slot: 2 } },
    });
    expect(parseAssertion({ kind: 'command', name: 'open-menu' })).toEqual({
      assertion: { kind: 'command', name: 'open-menu' },
    });
    expect(parseAssertion({ kind: 'signal', name: 'toggled', node: 'Music' })).toEqual({
      assertion: { kind: 'signal', name: 'toggled', node: 'Music' },
    });
    expect(parseAssertion({ kind: 'signal', name: 'died' })).toEqual({
      assertion: { kind: 'signal', name: 'died' },
    });
  });

  it('rejects command args that are not an object of fields', () => {
    const result = parseAssertion({ kind: 'command', name: 'buy-item', args: [2] });
    expect('error' in result && result.error).toContain('object of fields');
  });

  it('rejects a nameless command or signal', () => {
    expect('error' in parseAssertion({ kind: 'command' })).toBe(true);
    expect('error' in parseAssertion({ kind: 'signal', node: 'Music' })).toBe(true);
  });

  it('rejects an empty node scope rather than silently listening scene-wide', () => {
    const result = parseAssertion({ kind: 'signal', name: 'toggled', node: '' });
    expect('error' in result && result.error).toContain('omit it to listen scene-wide');
  });

  it('rejects a bad operator, naming the accepted ones', () => {
    const result = parseAssertion({ kind: 'gameState', path: 'wave', op: '>=', value: 2 });
    expect('error' in result && result.error).toContain('gte');
  });

  it('rejects frames(0) — it is true before the run starts', () => {
    const result = parseAssertion({ kind: 'frames', n: 0 });
    expect('error' in result && result.error).toContain('>= 1');
  });

  it('rejects an unknown kind, listing what this slice supports', () => {
    const result = parseAssertion({ kind: 'nodeExploded', name: 'Car' });
    expect('error' in result && result.error).toContain('gameStateChanged');
    expect('error' in result && result.error).toContain('nodeMoved');
  });

  it('rejects a non-object', () => {
    expect('error' in parseAssertion('gameState')).toBe(true);
  });

  it('names the offending index when a list is parsed', () => {
    const result = parseAssertions(
      [
        { kind: 'frames', n: 10 },
        { kind: 'gameState', path: '' },
      ],
      'until'
    );
    expect('error' in result && result.error).toContain('until[1]');
  });

  it('treats an absent list as empty and a non-array as an error', () => {
    expect(parseAssertions(undefined, 'fail')).toEqual({ assertions: [] });
    expect('error' in parseAssertions('frames', 'fail')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 predicates
// ---------------------------------------------------------------------------

/**
 * The transform snapshot is `GameInputService`'s exported shape, so these
 * literals are the same records the input layer produces for `observe`/`expect` —
 * if that shape changes, these specs stop compiling, which is the point.
 */
const snapshot = (
  name: string,
  world: { x?: number; y?: number; z?: number },
  over: Partial<LiveNodeSnapshot> = {}
): LiveNodeSnapshot => ({
  nodeId: `id-${name}`,
  name,
  type: 'Sprite2D',
  visible: true,
  position: { x: world.x ?? 0, y: world.y ?? 0, z: world.z ?? 0 },
  worldPosition: { x: world.x ?? 0, y: world.y ?? 0, z: world.z ?? 0 },
  rotationZ: 0,
  scale: { x: 1, y: 1, z: 1 },
  childCount: 0,
  visibleChildCount: 0,
  ...over,
});

const movedFrames = (
  from: { x?: number; y?: number; z?: number },
  to: { x?: number; y?: number; z?: number },
  name = 'Player'
): { baseline: AssertionFrame; frame: AssertionFrame } => ({
  baseline: makeFrame({
    presentNodes: new Set([name]),
    nodes: new Map([[name, snapshot(name, from)]]),
  }),
  frame: makeFrame({
    frame: 40,
    presentNodes: new Set([name]),
    nodes: new Map([[name, snapshot(name, to)]]),
  }),
});

describe('nodeMoved', () => {
  it('holds once the node travelled past the default floor', () => {
    const { baseline, frame } = movedFrames({ x: 0 }, { x: 3 });
    const outcome = evaluateAssertion({ kind: 'nodeMoved', name: 'Player' }, frame, baseline);
    expect(outcome.met).toBe(true);
    expect(outcome.detail).toContain('moved 3u');
  });

  it('does not hold for jitter below the floor', () => {
    const { baseline, frame } = movedFrames({ x: 0 }, { x: 0.2 });
    expect(evaluateAssertion({ kind: 'nodeMoved', name: 'Player' }, frame, baseline).met).toBe(
      false
    );
  });

  it('measures a SIGNED delta on the named axis, so direction is assertable', () => {
    const { baseline, frame } = movedFrames({ x: 0 }, { x: -4 });
    const left = evaluateAssertion(
      { kind: 'nodeMoved', name: 'Player', axis: 'x', max: 0 },
      frame,
      baseline
    );
    const right = evaluateAssertion(
      { kind: 'nodeMoved', name: 'Player', axis: 'x', min: 0 },
      frame,
      baseline
    );
    expect(left.met).toBe(true);
    expect(right.met).toBe(false);
    expect(left.detail).toContain('Δx -4');
  });

  it('cannot be satisfied by standing still when only a direction bound is given', () => {
    const { baseline, frame } = movedFrames({ x: 0 }, { x: 0 });
    const outcome = evaluateAssertion(
      { kind: 'nodeMoved', name: 'Player', axis: 'x', max: 0 },
      frame,
      baseline
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('at least 0.5');
  });

  it('lets an explicit small min lower the floor', () => {
    const { baseline, frame } = movedFrames({ y: 0 }, { y: 0.3 });
    expect(
      evaluateAssertion({ kind: 'nodeMoved', name: 'Player', axis: 'y', min: 0.2 }, frame, baseline)
        .met
    ).toBe(true);
  });

  it('reports a node that was never there separately from one that died', () => {
    const { baseline, frame } = movedFrames({ x: 0 }, { x: 5 });
    const unknown = evaluateAssertion({ kind: 'nodeMoved', name: 'Ghost' }, frame, baseline);
    expect(unknown.met).toBe(false);
    expect(unknown.detail).toContain('no origin to measure from');

    const died = evaluateAssertion(
      { kind: 'nodeMoved', name: 'Player' },
      makeFrame({ frame: 40, nodes: new Map() }),
      baseline
    );
    expect(died.met).toBe(false);
    expect(died.detail).toContain('no longer in the scene');
  });

  it('calls out a NaN transform instead of reporting motion', () => {
    const { baseline } = movedFrames({ x: 0 }, { x: 0 });
    const frame = makeFrame({
      frame: 12,
      presentNodes: new Set(['Player']),
      nodes: new Map([['Player', snapshot('Player', { x: Number.NaN, y: 0 })]]),
    });
    const outcome = evaluateAssertion({ kind: 'nodeMoved', name: 'Player' }, frame, baseline);
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('non-finite');
  });

  it('says so when no snapshots were collected at all', () => {
    const outcome = evaluateAssertion(
      { kind: 'nodeMoved', name: 'Player' },
      makeFrame({ frame: 3 }),
      makeFrame()
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('harness bug');
  });
});

describe('nodeAppeared', () => {
  it('holds when a name that was absent shows up', () => {
    const outcome = evaluateAssertion(
      { kind: 'nodeAppeared', query: 'WinBanner' },
      makeFrame({ frame: 90, presentNodes: new Set(['WinBanner']) }),
      makeFrame()
    );
    expect(outcome.met).toBe(true);
    expect(outcome.detail).toContain('absent at frame 0');
  });

  it('holds on a rising type count — the only reading that sees a pooled spawn', () => {
    const outcome = evaluateAssertion(
      { kind: 'nodeAppeared', query: 'Enemy2D' },
      makeFrame({ frame: 60, typeCounts: new Map([['Enemy2D', 4]]) }),
      makeFrame({ typeCounts: new Map([['Enemy2D', 1]]) })
    );
    expect(outcome.met).toBe(true);
    expect(outcome.detail).toContain('up from 1');
  });

  it('does not hold for a name that was already there', () => {
    const outcome = evaluateAssertion(
      { kind: 'nodeAppeared', query: 'Player' },
      makeFrame({ frame: 30, presentNodes: new Set(['Player']) }),
      makeFrame({ presentNodes: new Set(['Player']) })
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('already in the scene at frame 0');
  });

  it('says the type count was never collected rather than implying nothing spawned', () => {
    const outcome = evaluateAssertion(
      { kind: 'nodeAppeared', query: 'Enemy2D' },
      makeFrame({ frame: 30 }),
      makeFrame()
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('no live count was collected');
  });

  it('does not hold when the count stayed flat', () => {
    const outcome = evaluateAssertion(
      { kind: 'nodeAppeared', query: 'Enemy2D' },
      makeFrame({ frame: 30, typeCounts: new Map([['Enemy2D', 2]]) }),
      makeFrame({ typeCounts: new Map([['Enemy2D', 2]]) })
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('still 2');
  });
});

describe('nodeProperty', () => {
  const propertyFrame = (value: unknown, present = true): AssertionFrame =>
    makeFrame({
      frame: 20,
      presentNodes: present ? new Set(['Hud']) : new Set<string>(),
      nodeProperties: new Map([[nodePropertyKey('Hud', 'text'), value as never]]),
    });

  it('holds when the live property satisfies the operator', () => {
    const outcome = evaluateAssertion(
      { kind: 'nodeProperty', name: 'Hud', path: 'text', op: 'contains', value: 'Score' },
      propertyFrame('Score: 3'),
      makeFrame()
    );
    expect(outcome.met).toBe(true);
    expect(outcome.detail).toContain('Hud.text');
  });

  it('refuses to order a non-number and explains why, instead of coercing', () => {
    const outcome = evaluateAssertion(
      { kind: 'nodeProperty', name: 'Hud', path: 'text', op: 'gt', value: 2 },
      propertyFrame('3'),
      makeFrame()
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('orders numbers only');
  });

  it('tells a missing property apart from a missing node', () => {
    const missingProperty = evaluateAssertion(
      { kind: 'nodeProperty', name: 'Hud', path: 'text', op: 'eq', value: 'x' },
      propertyFrame(undefined),
      makeFrame()
    );
    expect(missingProperty.detail).toContain('has no property');

    const missingNode = evaluateAssertion(
      { kind: 'nodeProperty', name: 'Hud', path: 'text', op: 'eq', value: 'x' },
      propertyFrame(undefined, false),
      makeFrame()
    );
    expect(missingNode.detail).toContain('no live node answers');
  });

  it('reports an uncollected reading as a harness bug', () => {
    const outcome = evaluateAssertion(
      { kind: 'nodeProperty', name: 'Hud', path: 'text', op: 'eq', value: 'x' },
      makeFrame({ frame: 4 }),
      makeFrame()
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('harness bug');
  });
});

describe('axis', () => {
  const axisFrame = (value: unknown): AssertionFrame =>
    makeFrame({ frame: 15, axes: new Map([['Horizontal', value as number]]) });

  it('holds when the stick output passes the threshold', () => {
    const outcome = evaluateAssertion(
      { kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 },
      axisFrame(-0.62),
      makeFrame()
    );
    expect(outcome.met).toBe(true);
    expect(outcome.detail).toContain('axis Horizontal = -0.62');
  });

  it('names the gesture as the suspect when the axis never left zero', () => {
    const outcome = evaluateAssertion(
      { kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 },
      axisFrame(0),
      makeFrame()
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('did not reach the control');
  });

  it('refuses a non-numeric reading rather than comparing it', () => {
    const outcome = evaluateAssertion(
      { kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 },
      axisFrame('-0.9'),
      makeFrame()
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('not a finite number');
  });

  it('reports an unsampled axis as a harness bug, not as a resting stick', () => {
    const outcome = evaluateAssertion(
      { kind: 'axis', name: 'Vertical', op: 'gt', value: 0.4 },
      axisFrame(0.9),
      makeFrame()
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('not sampled');
  });
});

describe('phase 6 metadata helpers', () => {
  const assertions: GameAssertion[] = [
    { kind: 'nodeMoved', name: 'Player', axis: 'x', max: 0 },
    { kind: 'nodeProperty', name: 'Hud', path: 'text', op: 'contains', value: 'Score' },
    { kind: 'nodeAppeared', query: 'Enemy2D' },
    { kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 },
    { kind: 'axis', name: 'Horizontal', op: 'gt', value: 0.4 },
  ];

  it('asks the loop to resolve every node an assertion names', () => {
    expect(assertionNodeNames(assertions).sort()).toEqual(['Enemy2D', 'Hud', 'Player']);
  });

  it('asks for expensive snapshots only where displacement is measured', () => {
    expect(assertionSnapshotNames(assertions)).toEqual(['Player']);
  });

  it('collects type queries, property reads and axis names, deduped', () => {
    expect(assertionTypeQueries(assertions)).toEqual(['Enemy2D']);
    expect(assertionPropertyReads(assertions)).toEqual([
      { name: 'Hud', path: 'text', key: nodePropertyKey('Hud', 'text') },
    ]);
    expect(assertionAxisNames(assertions)).toEqual(['Horizontal']);
  });

  it('labels the new predicates compactly', () => {
    expect(describeAssertion(assertions[0])).toBe('nodeMoved Player (axis x, max 0)');
    expect(describeAssertion(assertions[2])).toBe('nodeAppeared Enemy2D');
    expect(describeAssertion(assertions[3])).toBe('axis Horizontal lt -0.4');
  });
});

describe('parsing the phase 6 predicates', () => {
  it('accepts a direction-bounded nodeMoved', () => {
    expect(parseAssertion({ kind: 'nodeMoved', name: 'Player', axis: 'x', max: 0 })).toEqual({
      assertion: { kind: 'nodeMoved', name: 'Player', axis: 'x', max: 0 },
    });
  });

  it('rejects a bad axis, a non-numeric bound and impossible bounds', () => {
    expect('error' in parseAssertion({ kind: 'nodeMoved', name: 'P', axis: 'w' })).toBe(true);
    expect('error' in parseAssertion({ kind: 'nodeMoved', name: 'P', min: '2' })).toBe(true);
    const impossible = parseAssertion({ kind: 'nodeMoved', name: 'P', min: 5, max: 1 });
    expect('error' in impossible && impossible.error).toContain('nothing can satisfy');
  });

  it('rejects a negative distance bound without an axis, and says how to mean direction', () => {
    const result = parseAssertion({ kind: 'nodeMoved', name: 'P', max: -2 });
    expect('error' in result && result.error).toContain('axis');
  });

  it('takes a nodeAppeared query under any of its plausible field names', () => {
    expect(parseAssertion({ kind: 'nodeAppeared', type: 'Enemy2D' })).toEqual({
      assertion: { kind: 'nodeAppeared', query: 'Enemy2D' },
    });
    expect('error' in parseAssertion({ kind: 'nodeAppeared' })).toBe(true);
  });

  it('requires a path and an operator for nodeProperty', () => {
    expect(
      parseAssertion({ kind: 'nodeProperty', node: 'Hud', property: 'text', op: 'eq', value: 'a' })
    ).toEqual({
      assertion: { kind: 'nodeProperty', name: 'Hud', path: 'text', op: 'eq', value: 'a' },
    });
    const noOp = parseAssertion({ kind: 'nodeProperty', name: 'Hud', path: 'text', value: 'a' });
    expect('error' in noOp && noOp.error).toContain('op');
  });

  it('keeps axis numeric and refuses "contains" on a number', () => {
    expect(parseAssertion({ kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 })).toEqual({
      assertion: { kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 },
    });
    const asString = parseAssertion({ kind: 'axis', name: 'Horizontal', op: 'lt', value: '-0.4' });
    expect('error' in asString && asString.error).toContain('finite number');
    const contains = parseAssertion({ kind: 'axis', name: 'Horizontal', op: 'contains', value: 1 });
    expect('error' in contains && contains.error).toContain('no meaning for a number');
  });
});
