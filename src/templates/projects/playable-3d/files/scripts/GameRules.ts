/**
 * GameRules — score, lives, timer and the win/lose decision for the 3D recipe.
 *
 * The same bookkeeping the 2D blank recipe ships, so a 3D idea starts with the *outcome*
 * of a run already built and spends its first increment on the mechanic. It owns:
 *   - the run state (score, lives, clock, outcome),
 *   - the HUD signals (`score-changed`, `lives-changed`, `time-changed`),
 *   - the win/lose decision.
 *
 * Your mechanic talks to it in either of two ways, whichever suits the script:
 *   1. call the methods — `rules.addScore(1)`, `rules.loseLife()`, `rules.finish(true)`;
 *   2. emit on the node that carries this component — `node.emit('score-added', 1)`
 *      or `node.emit('life-lost', 1)` — which needs no reference at all.
 *
 * Win modes:
 *   `score`   — reach `targetScore`; a non-zero time limit is a deadline.
 *   `time`    — play until the clock ends, then win if `targetScore` was reached.
 *   `survive` — stay alive until the clock ends; reaching it is the win.
 * In every mode, running out of lives loses. `timeLimitSec: 0` means no clock,
 * so the HUD's time label counts elapsed seconds up instead of down.
 *
 * **Two things it deliberately does NOT own**, because `GameFlow` on the same node already
 * does, and a playable may have exactly one of each:
 *
 * - **The end screen.** `finish(won)` writes the outcome text and dispatches GameFlow's
 *   `finish` command. One result surface, one phase machine — a second overlay would give
 *   the playable two ways to be over and no way to agree which one happened.
 * - **The debug provider.** `registerGameDebug` keeps ONE provider, so a second call here
 *   would silently displace GameFlow's and take every intro/end verification down with it.
 *   Instead {@link GameRules.bookkeeping} is read by GameFlow's snapshot, and the numbers
 *   below arrive in the same JSON as the phase.
 *
 * The wiring in both directions is duck-typed on purpose: delete this component and
 * GameFlow still runs the gate, the timer and the CTA exactly as it did before. Delete
 * GameFlow instead and set `startWithFlow: false`, or nothing ever starts the run.
 */
import { Label2D, Script, type PropertySchema } from '@pix3/runtime';

type WinMode = 'score' | 'time' | 'survive';

/** Snapshot numbers are read by humans and diffed by tools — keep them short. */
function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

export class GameRules extends Script {
  private score = 0;
  private lives = 3;
  private elapsed = 0;
  private over = false;
  private won = false;
  /** False until the run actually begins — see `startWithFlow`. */
  private running = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      winMode: 'score',
      targetScore: 10,
      // No clock by default: a recipe that ended runs on a deadline nobody asked for
      // would look like a bug in the mechanic being built.
      timeLimitSec: 0,
      startingLives: 3,
      resultLabel: 'end-label',
      winText: 'YOU WIN!',
      loseText: 'GAME OVER',
      // Wait for GameFlow to leave the tap gate before the clock starts and the win
      // condition is evaluated. Without it a `survive` run with a time limit is WON while
      // the intro overlay is still up, having survived nothing. Set it false if you delete
      // GameFlow — then the run starts with the scene.
      startWithFlow: true,
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, min: number, max: number, step: number) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Rules', min, max, step, slider: true },
      getValue: (s: unknown) => (s as GameRules).config[name],
      setValue: (s: unknown, v: unknown) => {
        const n = Number(v);
        (s as GameRules).config[name] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
      },
    });
    const str = (name: string, label: string, group: string) => ({
      name,
      type: 'string' as const,
      ui: { label, group },
      getValue: (s: unknown) => (s as GameRules).config[name],
      setValue: (s: unknown, v: unknown) => {
        (s as GameRules).config[name] = typeof v === 'string' ? v : '';
      },
    });

    return {
      nodeType: 'GameRules',
      properties: [
        {
          name: 'winMode',
          type: 'select',
          ui: { label: 'Win Mode', group: 'Rules', options: ['score', 'time', 'survive'] },
          getValue: s => (s as GameRules).config.winMode,
          setValue: (s, v) => {
            (s as GameRules).config.winMode = v === 'time' || v === 'survive' ? v : 'score';
          },
        },
        num('targetScore', 'Target Score', 1, 99999, 1),
        num('timeLimitSec', 'Time Limit (s)', 0, 600, 1),
        num('startingLives', 'Starting Lives', 1, 20, 1),
        str('winText', 'Win Text', 'Result'),
        str('loseText', 'Lose Text', 'Result'),
        str('resultLabel', 'Result Label', 'Result'),
        {
          name: 'startWithFlow',
          type: 'boolean',
          ui: {
            label: 'Start With Flow',
            description: 'Wait for GameFlow to leave the tap gate before the run begins',
            group: 'Rules',
          },
          getValue: s => (s as GameRules).config.startWithFlow !== false,
          setValue: (s, v) => {
            (s as GameRules).config.startWithFlow = v !== false;
          },
        },
      ],
      groups: {
        Rules: { label: 'Rules', expanded: true },
        Result: { label: 'Result Text', expanded: true },
      },
    };
  }

  onStart(): void {
    this.lives = Math.max(1, Number(this.config.startingLives) || 1);
    this.running = this.config.startWithFlow === false;

    const owner = this.node;
    // The signal channel: a mechanic script can score without holding a reference
    // to this component. Same effect as calling the methods below.
    owner?.connect('score-added', this, (...args: unknown[]) =>
      this.addScore(Number(args[0]) || 0)
    );
    owner?.connect('life-lost', this, (...args: unknown[]) => this.loseLife(Number(args[0]) || 1));
    // The HUD announces itself once it is connected, so it never misses the
    // opening values (its onStart runs after this one).
    owner?.connect('hud-ready', this, () => this.broadcast());
    this.broadcast();
  }

  onUpdate(dt: number): void {
    if (this.over || !this.running) {
      return;
    }
    this.elapsed += dt;
    const limit = Math.max(0, Number(this.config.timeLimitSec) || 0);
    this.node?.emit('time-changed', limit > 0 ? Math.max(0, limit - this.elapsed) : this.elapsed);

    if (this.lives <= 0) {
      this.finish(false);
      return;
    }
    const raw = String(this.config.winMode ?? 'score');
    const mode: WinMode = raw === 'time' ? 'time' : raw === 'survive' ? 'survive' : 'score';
    const target = Math.max(1, Number(this.config.targetScore) || 1);
    const timeUp = limit > 0 && this.elapsed >= limit;

    if (mode === 'score') {
      if (this.score >= target) this.finish(true);
      else if (timeUp) this.finish(false);
    } else if (mode === 'time') {
      if (timeUp) this.finish(this.score >= target);
    } else if (timeUp) {
      this.finish(true);
    }
  }

  /**
   * The run has begun: start the clock and start judging the win condition. Called by
   * `GameFlow` when the tap gate opens, so the timer measures play and not the time the
   * intro overlay spent on screen.
   */
  startRun(): void {
    if (this.over) return;
    this.running = true;
  }

  /**
   * The run ended somewhere else — `GameFlow`'s placeholder timer, or a `finish` command
   * dispatched by a test. Without this the phase said `ended` while the rules kept ticking,
   * reported `outcome: null`, and (with a time limit) fired a SECOND ending that rewrote the
   * result label behind the end screen.
   *
   * With no verdict passed, the rules read their own win condition — the run is over, and
   * "was it won?" is exactly the question this component exists to answer.
   */
  endRun(won?: boolean): void {
    if (this.over) return;
    this.finish(won ?? this.score >= Math.max(1, Number(this.config.targetScore) || 1));
  }

  /** Score. Call it from your mechanic, or emit `score-added` on this node. */
  addScore(amount: number): void {
    if (this.over) return;
    this.score += amount;
    this.node?.emit('score-changed', this.score);
  }

  /** Lose lives. Call it from your mechanic, or emit `life-lost` on this node. */
  loseLife(amount = 1): void {
    if (this.over) return;
    this.lives = Math.max(0, this.lives - Math.max(1, amount));
    this.node?.emit(
      'lives-changed',
      this.lives,
      Math.max(1, Number(this.config.startingLives) || 1)
    );
  }

  /**
   * End the run: write the outcome text, then hand the end screen to `GameFlow`.
   *
   * Dispatching its `finish` command rather than reaching for the component keeps the
   * ending in ONE place and journals it, so a routine can watch the run end by intent.
   */
  finish(won: boolean): void {
    if (this.over) return;
    this.over = true;
    this.running = false;
    this.won = won;

    const label = this.findNode(String(this.config.resultLabel ?? ''));
    if (label instanceof Label2D) {
      label.setText(String((won ? this.config.winText : this.config.loseText) ?? ''));
    }
    this.scene?.commands.dispatch('finish');
    this.node?.emit(won ? 'game-won' : 'game-lost', this.score);
  }

  /**
   * The run's numbers, for GameFlow's debug snapshot. Kept flat and JSON-serialisable —
   * it is merged into that snapshot, so it is what every verification tool reads.
   */
  bookkeeping(): Record<string, unknown> {
    return {
      score: this.score,
      lives: this.lives,
      winMode: String(this.config.winMode ?? 'score'),
      targetScore: Math.max(1, Number(this.config.targetScore) || 1),
      // null when the run has no clock at all.
      timeLeftSec: this.timeLeftSec(),
      outcome: this.over ? (this.won ? 'won' : 'lost') : null,
      // Whether the clock and the win condition are live. A run that reads `phase: playing`
      // while this is false is a run stuck behind the gate.
      running: this.running,
    };
  }

  /**
   * Back to the state `onStart` left behind. Called by GameFlow's `restart`, so one intent
   * arms a fresh run everywhere — a restart that put the gate back but kept last run's score
   * is the kind of half-reset that makes a routine's second pass meaningless.
   */
  resetRun(): void {
    this.score = 0;
    this.lives = Math.max(1, Number(this.config.startingLives) || 1);
    this.elapsed = 0;
    this.over = false;
    this.won = false;
    // Back behind the gate, exactly as at `onStart` — a reset that left the clock running
    // would spend the next intro overlay burning the new run's time limit.
    this.running = this.config.startWithFlow === false;
    this.broadcast();
  }

  /** Seconds left on the clock, or `null` when this run has no time limit. */
  private timeLeftSec(): number | null {
    const limit = Math.max(0, Number(this.config.timeLimitSec) || 0);
    return limit > 0 ? roundHundredths(Math.max(0, limit - this.elapsed)) : null;
  }

  private broadcast(): void {
    const owner = this.node;
    owner?.emit('score-changed', this.score);
    owner?.emit('lives-changed', this.lives, Math.max(1, Number(this.config.startingLives) || 1));
    const limit = Math.max(0, Number(this.config.timeLimitSec) || 0);
    owner?.emit('time-changed', limit > 0 ? Math.max(0, limit - this.elapsed) : this.elapsed);
  }
}
