import { describe, expect, it } from 'vitest';

import type { AssertionBaseline, GameAssertion } from './game-assertions';
import type { LiveNodeSnapshot } from './GameInputService';
import {
  assessControlStrength,
  baselineFingerprint,
  comparePreconditions,
  isolateForControl,
  judgeNegativeControl,
  parseNegativeControlSpec,
  DEFAULT_CONTROL_HOLD_FRAMES,
  type ControlIsolationReport,
  type ControlJudgementInput,
  type ControlRunOutcome,
} from './game-control';

/**
 * What these tests defend is one sentence: `passed` and `failed` require the
 * control gesture to have run **from the same state with the same budget**, and
 * everything else is `inconclusive` *with the reason named*.
 *
 * That is not a formality. A harness that reports "control passed" when the
 * control could not be run is worse than one with no negative control at all,
 * because the first is trusted — a dead button, a spent round, a player who was
 * already dead all produce "the effect did not happen" for reasons that have
 * nothing to do with where the finger landed. So the cases carried here are the
 * three that a service-level test never reaches: `irreversible`,
 * `short-budget`, `precondition-drift` — alongside the two real outcomes, so it
 * stays provable that the guards did not simply swallow every verdict.
 *
 * Everything is literals: no runner, no scene, no game.
 */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const baseline = (over: Partial<AssertionBaseline> = {}): AssertionBaseline => ({
  frame: 0,
  gameTimeMs: 0,
  gameState: null,
  presentNodes: new Set<string>(),
  newErrorCount: 0,
  ...over,
});

const liveNode = (name: string, x = 0, y = 0, z = 0): LiveNodeSnapshot => ({
  nodeId: `id-${name}`,
  name,
  type: 'Sprite2D',
  visible: true,
  position: { x, y, z },
  worldPosition: { x, y, z },
  rotationZ: 0,
  rotation: { x: 0, y: 0, z: 0 },
  forward: { x: 0, y: 0, z: -1 },
  scale: { x: 1, y: 1, z: 1 },
  childCount: 0,
  visibleChildCount: 0,
});

const nodes = (...snapshots: LiveNodeSnapshot[]): ReadonlyMap<string, LiveNodeSnapshot> =>
  new Map(snapshots.map(snapshot => [snapshot.name, snapshot]));

const outcome = (over: Partial<ControlRunOutcome> = {}): ControlRunOutcome => ({
  kind: 'timeout',
  frame: 300,
  ...over,
});

const isolated: ControlIsolationReport = {
  method: 'reset',
  ok: true,
  detail: "the game's own reset() ran before the control gesture",
};

/** The shape of a run that SHOULD reach a real verdict, so each test breaks one thing. */
const judgementInput = (over: Partial<ControlJudgementInput> = {}): ControlJudgementInput => ({
  isolation: isolated,
  until: [{ kind: 'gameState', path: 'score', op: 'gte', value: 1 }],
  mainBaseline: baseline({ gameState: { score: 0 } }),
  controlBaseline: baseline({ gameState: { score: 0 } }),
  controlOutcome: outcome(),
  mainFrameBudget: 300,
  controlFrameBudget: 300,
  ...over,
});

// ---------------------------------------------------------------------------
// parseNegativeControlSpec
// ---------------------------------------------------------------------------

describe('parseNegativeControlSpec', () => {
  const error = (raw: unknown): string => {
    const parsed = parseNegativeControlSpec(raw);
    if (!('error' in parsed))
      throw new Error(`expected a rejection, got ${JSON.stringify(parsed)}`);
    return parsed.error;
  };

  it('accepts a tap and defaults the hold to the press-machine floor', () => {
    const parsed = parseNegativeControlSpec({ tap: { nx: 0.05, ny: 0.95 } });
    expect(parsed).toEqual({
      spec: { tap: { nx: 0.05, ny: 0.95 }, holdFrames: DEFAULT_CONTROL_HOLD_FRAMES },
    });
  });

  it('omits seed entirely when none was given, rather than inventing 0', () => {
    // A `seed: 0` would be handed to the game's reset() as a real seed, quietly
    // changing what the control run replays.
    const parsed = parseNegativeControlSpec({ tap: { nx: 0, ny: 0 } });
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) return;
    expect('seed' in parsed.spec).toBe(false);
  });

  it('keeps an explicit seed and hold', () => {
    const parsed = parseNegativeControlSpec({ tap: { nx: 1, ny: 0.5 }, holdFrames: 7, seed: 0 });
    expect(parsed).toEqual({ spec: { tap: { nx: 1, ny: 0.5 }, holdFrames: 7, seed: 0 } });
  });

  it('rejects a missing tap, and says where a safe point comes from', () => {
    expect(error({})).toMatch(/game_controls/);
    expect(error(null)).toMatch(/must be an object/);
    expect(error([{ tap: { nx: 0, ny: 0 } }])).toMatch(/must be an object/);
  });

  it('rejects coordinates that are not canvas fractions', () => {
    // The loudest wrong answer this module can produce is a "negative" gesture
    // that landed on another control, so the denomination is policed here.
    expect(error({ tap: { nx: 640, ny: 0.5 } })).toMatch(/FRACTION of the canvas box/);
    expect(error({ tap: { nx: 0.5, ny: -0.1 } })).toMatch(/"control\.tap\.ny"/);
    expect(error({ tap: { nx: '0.5', ny: 0.5 } })).toMatch(/"control\.tap\.nx"/);
    expect(error({ tap: { nx: Number.NaN, ny: 0.5 } })).toMatch(/"control\.tap\.nx"/);
  });

  it('rejects a hold or seed that is not a usable integer', () => {
    expect(error({ tap: { nx: 0, ny: 0 }, holdFrames: 0 })).toMatch(/integer >= 1/);
    expect(error({ tap: { nx: 0, ny: 0 }, holdFrames: 1.5 })).toMatch(/integer >= 1/);
    expect(error({ tap: { nx: 0, ny: 0 }, seed: -1 })).toMatch(/non-negative integer/);
  });
});

// ---------------------------------------------------------------------------
// baselineFingerprint
// ---------------------------------------------------------------------------

describe('baselineFingerprint', () => {
  it('records exactly what the run’s own predicates read', () => {
    const until: GameAssertion[] = [
      { kind: 'gameState', path: 'score', op: 'gte', value: 10 },
      { kind: 'gameStateChanged', path: 'lives' },
      { kind: 'nodeMoved', name: 'Player', axis: 'x', max: 0 },
      { kind: 'nodeProperty', name: 'ScoreLabel', path: 'text', op: 'eq', value: '0' },
      { kind: 'axis', name: 'Horizontal', op: 'lt', value: -0.4 },
    ];
    const fingerprint = baselineFingerprint(
      until,
      baseline({
        gameState: { score: 0, lives: 3 },
        nodes: nodes(liveNode('Player', 1.005, -2, 0)),
        nodeProperties: new Map([['ScoreLabel text', '0']]),
        axes: new Map([['Horizontal', 0]]),
      })
    );

    expect([...fingerprint.entries()]).toEqual([
      ['state:score', '0'],
      ['state:lives', '3'],
      ['node:Player', 'at 1, -2, 0'],
      ['node:ScoreLabel', 'absent'],
      ['prop:ScoreLabel text', '0'],
      ['axis:Horizontal', '0'],
    ]);
  });

  it('ignores window-scoped predicates, which are empty at frame 0 in both runs', () => {
    const until: GameAssertion[] = [
      { kind: 'frames', n: 300 },
      { kind: 'newErrors', min: 1 },
      { kind: 'command', name: 'restart' },
      { kind: 'signal', name: 'pressed', node: 'Retry' },
    ];
    expect(baselineFingerprint(until, baseline({ gameState: { score: 0 } })).size).toBe(0);
  });

  it('reduces a node with no transform snapshot to present/absent', () => {
    const until: GameAssertion[] = [{ kind: 'nodeGone', name: 'Enemy' }];
    const present = baselineFingerprint(until, baseline({ presentNodes: new Set(['Enemy']) }));
    expect(present.get('node:Enemy')).toBe('present');
    expect(baselineFingerprint(until, baseline()).get('node:Enemy')).toBe('absent');
  });

  it('records the type count a pooled spawn is judged by, not only the name', () => {
    const until: GameAssertion[] = [{ kind: 'nodeAppeared', query: 'Enemy2D' }];
    const fingerprint = baselineFingerprint(
      until,
      baseline({ typeCounts: new Map([['Enemy2D', 4]]) })
    );
    expect(fingerprint.get('count:Enemy2D')).toBe('4');
    // A recycled node keeps its identity, so the by-name reading alone would call
    // two very different starting fields identical.
    expect(fingerprint.get('node:Enemy2D')).toBe('absent');
  });
});

// ---------------------------------------------------------------------------
// comparePreconditions
// ---------------------------------------------------------------------------

describe('comparePreconditions', () => {
  it('calls two identical fingerprints equal', () => {
    const main = new Map([['state:score', '0']]);
    expect(comparePreconditions(main, new Map(main))).toEqual({
      equal: true,
      differences: [],
      irreversible: false,
    });
  });

  it('reports a plain value difference as reversible drift', () => {
    const comparison = comparePreconditions(
      new Map([['state:score', '0']]),
      new Map([['state:score', '7']])
    );
    expect(comparison.equal).toBe(false);
    expect(comparison.irreversible).toBe(false);
    expect(comparison.differences).toEqual(['state:score: 0 → 7']);
  });

  it('flags a node that was there and is gone as irreversible', () => {
    // The classic false "control passed": the target the assertion is about died
    // during the main run, so nothing could have happened in the control run.
    const comparison = comparePreconditions(
      new Map([['node:Enemy', 'present']]),
      new Map([['node:Enemy', 'absent']])
    );
    expect(comparison).toEqual({
      equal: false,
      differences: ['node:Enemy: present → absent'],
      irreversible: true,
    });
  });

  it('flags a flag that went true → false as irreversible', () => {
    expect(
      comparePreconditions(
        new Map([['state:playerAlive', 'true']]),
        new Map([['state:playerAlive', 'false']])
      ).irreversible
    ).toBe(true);
    // The other direction is a game that came back to life, which is drift, not
    // a consumed resource.
    expect(
      comparePreconditions(
        new Map([['state:playerAlive', 'false']]),
        new Map([['state:playerAlive', 'true']])
      ).irreversible
    ).toBe(false);
  });

  it('names a key the control run never measured instead of calling it equal', () => {
    const comparison = comparePreconditions(new Map([['state:score', '0']]), new Map());
    expect(comparison.equal).toBe(false);
    expect(comparison.differences).toEqual(['state:score: 0 → (not measured)']);
  });

  it('caps the listed differences and counts the rest', () => {
    const main = new Map(Array.from({ length: 8 }, (_, i) => [`state:k${i}`, '0'] as const));
    const control = new Map(Array.from({ length: 8 }, (_, i) => [`state:k${i}`, '1'] as const));
    const comparison = comparePreconditions(main, control);
    expect(comparison.differences).toHaveLength(6);
    expect(comparison.differences.at(-1)).toBe('… and 3 more');
  });
});

// ---------------------------------------------------------------------------
// isolateForControl — the one impure function, and the await is the point
// ---------------------------------------------------------------------------

describe('isolateForControl', () => {
  it("prefers the game's own reset and awaits it before returning", async () => {
    // §5.5: a reset whose promise is dropped hands the control run a game that is
    // still tearing down, and every frame of the window then measures the wrong
    // state. `settled` proves the await happened, not merely that reset was called.
    let settled = false;
    const report = await isolateForControl({
      seed: 11,
      resetGame: async () => {
        await Promise.resolve();
        settled = true;
      },
      restartScene: () => {
        throw new Error('the scene must not be restarted when the game can reset itself');
      },
    });
    expect(settled).toBe(true);
    expect(report).toMatchObject({ method: 'reset', ok: true, seed: 11 });
    expect(report.detail).toContain('reset(11)');
  });

  it('reports a throwing reset as failed isolation rather than swallowing it', async () => {
    const report = await isolateForControl({ resetGame: () => Promise.reject(new Error('boom')) });
    expect(report).toMatchObject({ method: 'reset', ok: false });
    expect(report.detail).toContain('boom');
  });

  it('falls back to a scene restart and says the fallback is approximate', async () => {
    const report = await isolateForControl({ restartScene: () => {} });
    expect(report).toMatchObject({ method: 'scene-restart', ok: true });
    expect(report.detail).toContain('module-level state');
  });

  it('reports no method at all as a failure, never as a clean start', async () => {
    expect(await isolateForControl({})).toMatchObject({ method: 'none', ok: false });
  });
});

// ---------------------------------------------------------------------------
// judgeNegativeControl — the three-valued verdict
// ---------------------------------------------------------------------------

describe('judgeNegativeControl', () => {
  it('passes only when the same gesture elsewhere produced nothing from the same state', () => {
    const judgement = judgeNegativeControl(judgementInput());
    expect(judgement.verdict).toBe('passed');
    expect(judgement.reason).toBeUndefined();
    expect(judgement.note).toContain('300 frames');
    expect(judgement.note).toContain('the game reset itself');
  });

  it('fails when the effect happened WITHOUT the control', () => {
    const judgement = judgeNegativeControl(
      judgementInput({
        controlOutcome: outcome({ kind: 'until', frame: 12, index: 0, detail: 'score 0 → 3' }),
      })
    );
    expect(judgement.verdict).toBe('failed');
    expect(judgement.reason).toBeUndefined();
    expect(judgement.note).toContain('until[0]');
    expect(judgement.note).toContain('score 0 → 3');
  });

  it('lets a fired control outrank a short budget — seeing the effect is decisive', () => {
    // The one check whose order runs the other way: a tap away from the control
    // that produced the effect proves the binding is unproven, whatever the budget.
    const judgement = judgeNegativeControl(
      judgementInput({
        controlOutcome: outcome({ kind: 'until', frame: 5 }),
        controlFrameBudget: 30,
      })
    );
    expect(judgement.verdict).toBe('failed');
  });

  it('is inconclusive with reason "short-budget" when the control got less time', () => {
    // "The effect did not happen" and "the effect had not happened YET" are the
    // same observation; only the budget separates them.
    const judgement = judgeNegativeControl(
      judgementInput({ mainFrameBudget: 300, controlFrameBudget: 60 })
    );
    expect(judgement.verdict).toBe('inconclusive');
    expect(judgement.reason).toBe('short-budget');
    expect(judgement.note).toContain("60 frames against the main run's 300");
    expect(judgement.note).toContain('same budget');
  });

  it('is inconclusive with reason "irreversible" when the state never came back', () => {
    const until: GameAssertion[] = [{ kind: 'nodeGone', name: 'Enemy' }];
    const judgement = judgeNegativeControl(
      judgementInput({
        until,
        mainBaseline: baseline({ presentNodes: new Set(['Enemy']) }),
        controlBaseline: baseline({ presentNodes: new Set() }),
      })
    );
    expect(judgement.verdict).toBe('inconclusive');
    expect(judgement.reason).toBe('irreversible');
    expect(judgement.differences).toEqual(['node:Enemy: present → absent']);
    // The note has to say what a reader should do about it: the subject of the
    // assertion is missing, so the gesture never had a chance either way.
    expect(judgement.note).toContain('unrelated to where the gesture landed');
  });

  it('is inconclusive with reason "precondition-drift" when the two starts differ', () => {
    const judgement = judgeNegativeControl(
      judgementInput({
        mainBaseline: baseline({ gameState: { score: 0 } }),
        controlBaseline: baseline({ gameState: { score: 4 } }),
      })
    );
    expect(judgement.verdict).toBe('inconclusive');
    expect(judgement.reason).toBe('precondition-drift');
    expect(judgement.differences).toEqual(['state:score: 0 → 4']);
    expect(judgement.note).toContain('not comparable');
  });

  it('will not read a drifted control run as "failed" even when it fired', () => {
    // Drift is checked BEFORE the outcome for exactly this case: a control run
    // that starts mid-game can trip the predicate on leftovers, and calling that
    // "the effect happens without the control" would condemn a working control.
    const judgement = judgeNegativeControl(
      judgementInput({
        controlBaseline: baseline({ gameState: { score: 4 } }),
        controlOutcome: outcome({ kind: 'until', frame: 3 }),
      })
    );
    expect(judgement.verdict).toBe('inconclusive');
    expect(judgement.reason).toBe('precondition-drift');
  });

  it('is inconclusive with reason "precondition-drift" when the assertion was already true', () => {
    const judgement = judgeNegativeControl(
      judgementInput({
        controlOutcome: outcome({ kind: 'precondition-already-met', frame: 0, detail: 'score 9' }),
      })
    );
    expect(judgement.verdict).toBe('inconclusive');
    expect(judgement.reason).toBe('precondition-drift');
    expect(judgement.note).toContain('never given a chance to be the cause');
  });

  it('is inconclusive with reason "not-run" when there is no control run at all', () => {
    expect(judgeNegativeControl(judgementInput({ controlOutcome: null }))).toMatchObject({
      verdict: 'inconclusive',
      reason: 'not-run',
    });
    expect(judgeNegativeControl(judgementInput({ controlBaseline: null }))).toMatchObject({
      verdict: 'inconclusive',
      reason: 'not-run',
    });
  });

  it('is inconclusive with reason "error" when the control run itself broke', () => {
    const judgement = judgeNegativeControl(
      judgementInput({
        controlOutcome: outcome({
          kind: 'error',
          frame: 4,
          detail: 'TypeError: x is not a function',
        }),
      })
    );
    expect(judgement).toMatchObject({ verdict: 'inconclusive', reason: 'error' });
    expect(judgement.note).toContain('TypeError');
  });

  it('is inconclusive with reason "no-isolation" when the start could not be restored', () => {
    const judgement = judgeNegativeControl(
      judgementInput({
        isolation: { method: 'none', ok: false, detail: 'the game exposes no reset(seed)' },
      })
    );
    expect(judgement).toMatchObject({ verdict: 'inconclusive', reason: 'no-isolation' });
    expect(judgement.note).toContain('no reset(seed)');
  });

  it('accepts a scene restart as isolation, and still names the weaker method', () => {
    const judgement = judgeNegativeControl(
      judgementInput({
        isolation: { method: 'scene-restart', ok: true, detail: 'the scene was restarted' },
      })
    );
    expect(judgement.verdict).toBe('passed');
    expect(judgement.note).toContain('the scene restarted');
  });
});

// ---------------------------------------------------------------------------
// assessControlStrength — the marker a reader acts on
// ---------------------------------------------------------------------------

describe('assessControlStrength', () => {
  it('marks a passing screen-control run with no negative control as WEAK', () => {
    const strength = assessControlStrength({ usedScreenControl: true, passed: true });
    expect(strength.weak).toBe(true);
    expect(strength.marker).toBe('WEAK');
    expect(strength.note).toContain('Action_Primary');
  });

  it('leaves a key- or command-driven run unmarked — there is nothing to compare', () => {
    // Marking these WEAK would teach everyone to ignore the marker.
    expect(assessControlStrength({ usedScreenControl: false, passed: true })).toEqual({
      weak: false,
    });
  });

  it('leaves a failing run unmarked — a marker there is noise', () => {
    expect(assessControlStrength({ usedScreenControl: true, passed: false })).toEqual({
      weak: false,
    });
  });

  it('clears the marker once a control passed', () => {
    expect(
      assessControlStrength({
        usedScreenControl: true,
        passed: true,
        judgement: { verdict: 'passed', note: 'nothing happened away from the control' },
      })
    ).toEqual({ weak: false });
  });

  it('separates a control that FAILED from one that could not be run', () => {
    // Three different words because a reader acts differently on each: fix the
    // game, fix the test, or make the game resettable.
    const failed = assessControlStrength({
      usedScreenControl: true,
      passed: true,
      judgement: { verdict: 'failed', note: 'the effect happened WITHOUT the control' },
    });
    expect(failed).toEqual({
      weak: true,
      marker: 'CONTROL FAILED',
      note: 'the effect happened WITHOUT the control',
    });

    for (const reason of ['irreversible', 'short-budget', 'precondition-drift'] as const) {
      const strength = assessControlStrength({
        usedScreenControl: true,
        passed: true,
        judgement: { verdict: 'inconclusive', reason, note: `because ${reason}` },
      });
      expect(strength).toEqual({
        weak: true,
        marker: 'CONTROL INCONCLUSIVE',
        note: `because ${reason}`,
      });
    }
  });
});
