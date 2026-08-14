/**
 * The negative control of §5.4.4 — and the isolation that makes it mean
 * something.
 *
 * ## The trap being closed
 *
 * Any pointer press sets `Action_Primary` in the runtime's input service. A game
 * that reads `Action_Primary` as "shoot" shoots when the player taps **anywhere**
 * — including well outside the button that is supposedly being tested. So "I
 * tapped the FIRE button and the gun fired" is not evidence that the button
 * works: a completely dead button passes it. The evidence is the *pair*: the same
 * effect must NOT happen when the same gesture lands somewhere else.
 *
 * ## Why isolation is the hard half
 *
 * Running the negative gesture after the positive one, in the state the positive
 * one left behind, proves nothing either. The player may already be dead, the
 * round over, the ammo spent, the button disabled by its own handler — in every
 * one of those the effect cannot happen for reasons that have nothing to do with
 * where the finger landed, and calling that "control passed" manufactures
 * confidence out of a dead game.
 *
 * Hence the three-valued verdict. `passed` and `failed` both require that the
 * control gesture ran from the *same* starting state with the *same* budget;
 * anything else is `inconclusive`, and the report says which of the reasons
 * applies. A harness that cannot tell "the control proved the binding" from "the
 * control could not be run" is worse than one with no control at all, because the
 * first one is trusted.
 *
 * Everything here is pure except {@link isolateForControl}, which is async only
 * because a game's `reset` may be — and awaiting that promise is itself one of
 * the requirements (§5.5): a control run started on top of a half-torn-down state
 * is isolation in name only.
 */

import type { Json } from '@/core/agent-introspection';
import {
  formatJson,
  resolveJsonPath,
  type AssertionBaseline,
  type GameAssertion,
} from '@/services/agent/game-assertions';

// ---------------------------------------------------------------------------
// The gesture a run declares as its control
// ---------------------------------------------------------------------------

/**
 * Long enough that a control's own press machine (`Button2D` needs a real press,
 * not a one-frame blip) would have fired if the point had been over one. Shorter
 * than the main run's budget on purpose: the *window* the effect is looked for in
 * is the whole run, this is only how long the finger stays down.
 */
export const DEFAULT_CONTROL_HOLD_FRAMES = 40;

/**
 * The negative gesture, in the only denomination that survives a resized
 * viewport: a fraction of the canvas box (the same `nx`/`ny` a trace records) and
 * a hold counted in **frames**, because the game polls the pointer per tick.
 *
 * There is deliberately no default point. A harness-chosen "empty corner" is a
 * guess about someone else's layout, and a control gesture that quietly landed on
 * another button would report `failed` — the loudest possible wrong answer. The
 * caller reads `game_controls` and names a point nothing occupies.
 */
export interface NegativeControlSpec {
  /** Where the negative gesture lands: fractions of the canvas box, 0..1. */
  tap: { nx: number; ny: number };
  /** Frames the pointer stays down. Default {@link DEFAULT_CONTROL_HOLD_FRAMES}. */
  holdFrames: number;
  /** Seed handed to the game's `reset()`, so the control run replays the same randomness. */
  seed?: number;
}

/**
 * Validate a `control:` block from a tool call — next to the judgement it feeds,
 * for the same reason `parseMonkeySpec` lives next to the monkey.
 */
export function parseNegativeControlSpec(
  raw: unknown
): { spec: NegativeControlSpec } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      error: `"control" must be an object like {tap: {nx: 0.05, ny: 0.05}} — the same gesture as the one under test, aimed AWAY from the control.`,
    };
  }
  const record = raw as Record<string, unknown>;
  const tap = record.tap;
  if (typeof tap !== 'object' || tap === null || Array.isArray(tap)) {
    return {
      error: `"control.tap" is required: {nx, ny} in 0..1 of the canvas box. Pick a point no control occupies (game_controls lists where they are) — a "negative" gesture that lands on another button reports the effect as unbound when it is not.`,
    };
  }
  const { nx, ny } = tap as Record<string, unknown>;
  for (const [name, value] of [
    ['nx', nx],
    ['ny', ny],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return {
        error: `"control.tap.${name}" must be a number in 0..1 — a FRACTION of the canvas box, not a client pixel and not a world coordinate (the same denomination a trace's pointer events use).`,
      };
    }
  }
  const holdFrames = record.holdFrames;
  if (
    holdFrames !== undefined &&
    (typeof holdFrames !== 'number' || !Number.isInteger(holdFrames) || holdFrames < 1)
  ) {
    return { error: `"control.holdFrames" must be an integer >= 1.` };
  }
  const seed = record.seed;
  if (seed !== undefined && (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0)) {
    return { error: `"control.seed" must be a non-negative integer.` };
  }
  return {
    spec: {
      tap: { nx: nx as number, ny: ny as number },
      holdFrames: (holdFrames as number | undefined) ?? DEFAULT_CONTROL_HOLD_FRAMES,
      ...(seed !== undefined ? { seed: seed as number } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

/**
 * How the harness can put the game back to the start.
 *
 * `resetGame` is the game's own `GameDebugProvider.reset(seed)` (§5.5) — the good
 * path, because the game knows what "the start" means for it. `restartScene` is
 * the engine-level fallback: it restores the scene graph, but anything a script
 * kept in module state survives it, which is why the report names the method that
 * was used instead of pretending the two are equivalent.
 */
export interface ControlIsolationDeps {
  resetGame?: (seed?: number) => void | Promise<void>;
  restartScene?: () => void | Promise<void>;
  /** Seed handed to `reset`, so the control run replays the same randomness. */
  seed?: number;
}

export interface ControlIsolationReport {
  method: 'reset' | 'scene-restart' | 'none';
  /** False when the chosen method threw, or when there was no method at all. */
  ok: boolean;
  seed?: number;
  /** One line: what was done, or why nothing could be. */
  detail: string;
}

/**
 * Put the game back to the state the main run started from.
 *
 * Both branches `await` — a `reset` that returns a promise and is not awaited
 * hands the control run a game that is still tearing down, and every frame of the
 * control window then measures the wrong thing. A method that throws is reported
 * as a failed isolation rather than swallowed: the run continues, but its verdict
 * can only be `inconclusive`.
 */
export async function isolateForControl(
  deps: ControlIsolationDeps
): Promise<ControlIsolationReport> {
  if (deps.resetGame) {
    try {
      await deps.resetGame(deps.seed);
      return {
        method: 'reset',
        ok: true,
        ...(deps.seed !== undefined ? { seed: deps.seed } : {}),
        detail:
          deps.seed === undefined
            ? "the game's own reset() ran before the control gesture"
            : `the game's own reset(${deps.seed}) ran before the control gesture`,
      };
    } catch (error) {
      return {
        method: 'reset',
        ok: false,
        detail: `the game's reset() threw (${messageOf(error)}), so the control gesture would have run on top of the main run's leftovers`,
      };
    }
  }
  if (deps.restartScene) {
    try {
      await deps.restartScene();
      return {
        method: 'scene-restart',
        ok: true,
        detail:
          'the scene was restarted before the control gesture (module-level state kept by scripts survives this — a GameDebugProvider.reset(seed) would be exact)',
      };
    } catch (error) {
      return {
        method: 'scene-restart',
        ok: false,
        detail: `restarting the scene threw (${messageOf(error)}), so the starting state could not be restored`,
      };
    }
  }
  return {
    method: 'none',
    ok: false,
    detail:
      'the game exposes no reset(seed) and the scene could not be restarted, so the control gesture could only run on whatever state the main run left behind',
  };
}

// ---------------------------------------------------------------------------
// Precondition equality
// ---------------------------------------------------------------------------

/**
 * The part of a baseline that the run's own assertions depend on, as a comparable
 * map.
 *
 * Comparing whole baselines would be both too strict (a frame counter, a particle
 * seed) and too vague to report. Comparing exactly what the `until` predicates
 * read is the meaningful test: if every input to the judgement starts equal, the
 * two runs differ only in where the finger landed, which is the whole claim.
 *
 * Window-scoped predicates (`command`, `signal`, `newErrors`, `frames`) contribute
 * nothing — they are empty at frame 0 in both runs by construction.
 */
export function baselineFingerprint(
  assertions: readonly GameAssertion[],
  baseline: AssertionBaseline
): Map<string, string> {
  const fingerprint = new Map<string, string>();
  const addState = (path: string): void => {
    fingerprint.set(`state:${path}`, formatJson(resolveJsonPath(baseline.gameState, path)));
  };
  const addNode = (name: string): void => {
    const snapshot = baseline.nodes?.get(name);
    if (snapshot) {
      const p = snapshot.worldPosition;
      fingerprint.set(`node:${name}`, `at ${round2(p.x)}, ${round2(p.y)}, ${round2(p.z)}`);
      return;
    }
    fingerprint.set(`node:${name}`, baseline.presentNodes.has(name) ? 'present' : 'absent');
  };

  for (const assertion of assertions) {
    switch (assertion.kind) {
      case 'gameState':
      case 'gameStateChanged':
        addState(assertion.path);
        break;
      case 'nodeGone':
      case 'nodeMoved':
        addNode(assertion.name);
        break;
      case 'nodeAppeared':
        addNode(assertion.query);
        if (baseline.typeCounts?.has(assertion.query)) {
          fingerprint.set(
            `count:${assertion.query}`,
            String(baseline.typeCounts.get(assertion.query))
          );
        }
        break;
      case 'nodeProperty': {
        addNode(assertion.name);
        const key = `${assertion.name} ${assertion.path}`;
        if (baseline.nodeProperties?.has(key)) {
          fingerprint.set(
            `prop:${key}`,
            formatJson(baseline.nodeProperties.get(key) as Json | undefined)
          );
        }
        break;
      }
      case 'axis':
        fingerprint.set(`axis:${assertion.name}`, String(baseline.axes?.get(assertion.name) ?? 0));
        break;
      default:
        break;
    }
  }
  return fingerprint;
}

/** How many differences a report lists before it stops being readable. */
const MAX_DIFFERENCES = 5;

export interface PreconditionComparison {
  equal: boolean;
  /** Human-readable `key: main → control` lines, capped. */
  differences: string[];
  /**
   * True when a difference has the shape of an *irreversible* state — something
   * that was there in the main run and is gone in the control run, or a flag that
   * went true → false (a dead object, a spent button, a finished round).
   *
   * This is a classification of a difference already found, not a separate test:
   * the verdict is `inconclusive` either way. It exists so the report can say
   * "the object had already died" instead of "a value differs", which is the
   * difference between a person fixing the test and a person re-reading it.
   */
  irreversible: boolean;
}

export function comparePreconditions(
  main: ReadonlyMap<string, string>,
  control: ReadonlyMap<string, string>
): PreconditionComparison {
  const differences: string[] = [];
  let irreversible = false;
  let extra = 0;
  for (const [key, value] of main) {
    const now = control.get(key) ?? '(not measured)';
    if (now === value) continue;
    if ((value !== 'absent' && now === 'absent') || (value === 'true' && now === 'false')) {
      irreversible = true;
    }
    if (differences.length < MAX_DIFFERENCES) {
      differences.push(`${key}: ${value} → ${now}`);
    } else {
      extra += 1;
    }
  }
  if (extra > 0) differences.push(`… and ${extra} more`);
  return { equal: differences.length === 0, differences, irreversible };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type ControlVerdict = 'passed' | 'failed' | 'inconclusive';

export type ControlInconclusiveReason =
  | 'not-run'
  | 'no-isolation'
  | 'precondition-drift'
  | 'irreversible'
  | 'short-budget'
  | 'error';

/** How the control run ended, in the loop's own vocabulary. */
export interface ControlRunOutcome {
  kind: 'until' | 'fail' | 'timeout' | 'error' | 'precondition-already-met';
  frame: number;
  /** Index within the channel that fired, when one did. */
  index?: number;
  /** The predicate's own evidence line. */
  detail?: string;
}

export interface ControlJudgementInput {
  isolation: ControlIsolationReport;
  /** The `until` list both runs are judged by — the control must NOT satisfy it. */
  until: readonly GameAssertion[];
  mainBaseline: AssertionBaseline;
  /** Frame-0 record of the control run; null when the run never started. */
  controlBaseline: AssertionBaseline | null;
  controlOutcome: ControlRunOutcome | null;
  /** Frame budgets — the control gets the main run's, or the verdict is inconclusive. */
  mainFrameBudget: number;
  controlFrameBudget: number;
}

export interface ControlJudgement {
  verdict: ControlVerdict;
  reason?: ControlInconclusiveReason;
  /** One line for the verdict tail. */
  note: string;
  differences?: string[];
}

/**
 * Decide whether the negative control proved anything.
 *
 * The order of the checks is the argument: everything that could make the run
 * meaningless is ruled out **before** its result is read, so a `passed` can only
 * be reached by a control gesture that started from the same state, had the same
 * time to work, and still produced nothing.
 *
 * The one place where the order runs the other way is a control that *did* fire:
 * that is decisive whatever the budget was, because seeing the effect without the
 * control is the exact failure the mechanism exists to catch.
 */
export function judgeNegativeControl(input: ControlJudgementInput): ControlJudgement {
  const { controlOutcome, controlBaseline, isolation } = input;
  if (!controlOutcome || !controlBaseline) {
    return {
      verdict: 'inconclusive',
      reason: 'not-run',
      note: 'the negative control never ran, so the assertion is not distinguishable from a tap that would have worked anywhere',
    };
  }
  if (controlOutcome.kind === 'error') {
    return {
      verdict: 'inconclusive',
      reason: 'error',
      note: `the negative control run errored at frame ${controlOutcome.frame}${controlOutcome.detail ? `: ${controlOutcome.detail}` : ''}`,
    };
  }
  if (!isolation.ok) {
    return {
      verdict: 'inconclusive',
      reason: 'no-isolation',
      note: `the control gesture did not start from the same state: ${isolation.detail}`,
    };
  }

  const comparison = comparePreconditions(
    baselineFingerprint(input.until, input.mainBaseline),
    baselineFingerprint(input.until, controlBaseline)
  );
  if (!comparison.equal) {
    return {
      verdict: 'inconclusive',
      reason: comparison.irreversible ? 'irreversible' : 'precondition-drift',
      note: comparison.irreversible
        ? `the state the assertion depends on did not come back after ${describeMethod(isolation)} — something the main run consumed is still gone (${comparison.differences.join('; ')}), so the control could not have produced the effect for reasons unrelated to where the gesture landed`
        : `the control run started from a different state than the main run (${comparison.differences.join('; ')}), so the two are not comparable`,
      differences: comparison.differences,
    };
  }

  if (controlOutcome.kind === 'until') {
    const slot = controlOutcome.index === undefined ? '' : `until[${controlOutcome.index}] `;
    return {
      verdict: 'failed',
      note: `the effect happened WITHOUT the control: ${slot}fired at frame ${controlOutcome.frame} of the negative gesture${controlOutcome.detail ? ` (${controlOutcome.detail})` : ''}. The assertion proves nothing about this control — any tap produces it (§5.4.4)`,
    };
  }
  if (controlOutcome.kind === 'precondition-already-met') {
    return {
      verdict: 'inconclusive',
      reason: 'precondition-drift',
      note: `the assertion was already true at frame 0 of the control run${controlOutcome.detail ? ` (${controlOutcome.detail})` : ''}, so the gesture was never given a chance to be the cause`,
    };
  }
  if (input.controlFrameBudget < input.mainFrameBudget) {
    return {
      verdict: 'inconclusive',
      reason: 'short-budget',
      note: `the negative control ran for ${input.controlFrameBudget} frames against the main run's ${input.mainFrameBudget}, so "the effect did not happen" may only mean "not yet" — give the control the same budget`,
    };
  }
  return {
    verdict: 'passed',
    note: `the same gesture away from the control produced nothing in ${input.controlFrameBudget} frames from the same state (${describeMethod(isolation)})`,
  };
}

// ---------------------------------------------------------------------------
// How the verdict line is marked
// ---------------------------------------------------------------------------

export interface ControlStrengthInput {
  /**
   * True when the run's own input operated an on-screen control (a tap, a drag,
   * a named interaction) — the only case §5.4.4 is about. A run driven purely by
   * keys or by dispatched commands has no "tapped somewhere else" to compare
   * against, and marking it WEAK would train everyone to ignore the marker.
   */
  usedScreenControl: boolean;
  /** The judgement, when a control run happened at all. */
  judgement?: ControlJudgement | null;
  /** True when the main run passed — a marker on a failing run is noise. */
  passed: boolean;
}

export interface ControlStrength {
  /** True when the result must not be read as proof of the control's binding. */
  weak: boolean;
  /** Prefix for the verdict tail: `WEAK`, `CONTROL INCONCLUSIVE`, `CONTROL FAILED`. */
  marker?: string;
  /** The explanation that follows the marker. */
  note?: string;
}

/**
 * Turn a control judgement (or its absence) into the marker the verdict carries.
 *
 * A missing control on a passing, control-driven run is `WEAK` — the result may
 * well be right, and saying so is more useful than refusing to report it. A
 * control that ran and failed is not weak, it is *wrong*, and a control that
 * could not be isolated is neither: all three get different words because a
 * reader acts differently on each.
 */
export function assessControlStrength(input: ControlStrengthInput): ControlStrength {
  const judgement = input.judgement;
  if (!judgement) {
    if (!input.passed || !input.usedScreenControl) return { weak: false };
    return {
      weak: true,
      marker: 'WEAK',
      note: 'this run operated an on-screen control and had no negative control, so it cannot tell a working control from a tap that any point on screen would have produced (any pointer press raises Action_Primary). Add control: with the same gesture away from the control.',
    };
  }
  switch (judgement.verdict) {
    case 'passed':
      return { weak: false };
    case 'failed':
      return { weak: true, marker: 'CONTROL FAILED', note: judgement.note };
    default:
      return { weak: true, marker: 'CONTROL INCONCLUSIVE', note: judgement.note };
  }
}

const describeMethod = (isolation: ControlIsolationReport): string =>
  isolation.method === 'reset'
    ? 'the game reset itself'
    : isolation.method === 'scene-restart'
      ? 'the scene restarted'
      : 'no isolation';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const round2 = (n: number): number => Math.round(n * 100) / 100;
