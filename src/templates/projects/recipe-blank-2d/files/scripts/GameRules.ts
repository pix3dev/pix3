/**
 * GameRules — score, lives, timer, win/lose and the end flow.
 *
 * This is the blank recipe's only piece of game logic, and it is deliberately
 * about the *outcome* of a run, never about its mechanic. It owns:
 *   - the run state (score, lives, clock, outcome),
 *   - the HUD signals (`score-changed`, `lives-changed`, `time-changed`),
 *   - the result overlay and RETRY,
 *   - the `restart` intent,
 *   - the debug snapshot every verification tool reads.
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
 * RETRY dispatches the `restart` command (`scene.commands`) rather than calling a
 * method: a test replays the end flow without hunting for buttons, and one real
 * tap proves the binding once.
 */
import { Button2D, Label2D, Script, registerGameDebug, type PropertySchema } from '@pix3/runtime';

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
  private disposeDebug: (() => void) | null = null;
  private disposeCommands: (() => void)[] = [];
  /** Components `finish()` switched off, so `resetRun()` revives exactly those. */
  private frozen: { enabled: boolean }[] = [];

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      winMode: 'score',
      targetScore: 10,
      // No clock by default: a blank recipe that ended runs on a deadline nobody
      // asked for would look like a bug in the mechanic being built.
      timeLimitSec: 0,
      startingLives: 3,
      resultNode: 'result-overlay',
      resultLabel: 'result-label',
      winText: 'YOU WIN!',
      loseText: 'GAME OVER',
      retryButton: 'retry-button',
      gameScene: 'res://scenes/main.pix3scene',
      // Comma-separated node ids frozen (all their components disabled) on game
      // over. Add your mechanic's nodes here as you build them — a spawner that
      // keeps running behind the result screen is the classic leak.
      freezeNodes: '',
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
        str('resultNode', 'Result Overlay', 'Result'),
        str('resultLabel', 'Result Label', 'Result'),
        str('retryButton', 'Retry Button', 'Flow'),
        str('gameScene', 'Game Scene', 'Flow'),
        str('freezeNodes', 'Freeze Nodes', 'Flow'),
      ],
      groups: {
        Rules: { label: 'Rules', expanded: true },
        Result: { label: 'Result Screen', expanded: true },
        Flow: { label: 'Flow', expanded: false },
      },
    };
  }

  onStart(): void {
    this.lives = Math.max(1, Number(this.config.startingLives) || 1);
    const dispose = this.scene?.commands.register('restart', () => this.restart(), {
      description: 'Reload the game scene for a fresh run.',
    });
    this.disposeCommands = dispose ? [dispose] : [];

    this.disposeDebug = registerGameDebug({
      name: 'recipe-blank-2d',
      version: 1,
      // The registry IS the action list — never a second, hand-kept copy.
      actions: () => this.scene?.commands.list().map(command => command.name) ?? [],
      reset: () => this.resetRun(),
      snapshot: () => ({
        scene: 'game',
        phase: this.over ? (this.won ? 'won' : 'lost') : 'playing',
        score: this.score,
        lives: this.lives,
        winMode: String(this.config.winMode ?? 'score'),
        targetScore: Math.max(1, Number(this.config.targetScore) || 1),
        elapsedSec: roundHundredths(this.elapsed),
        // null when the run has no clock at all.
        timeLeftSec: this.timeLeftSec(),
      }),
    });

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

    this.setNodeVisible(String(this.config.resultNode ?? ''), false);
    this.bindButton(
      String(this.config.retryButton ?? ''),
      () => this.scene?.commands.dispatch('restart'),
      false
    );
    this.broadcast();
  }

  onUpdate(dt: number): void {
    if (this.over) {
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

  onDetach(): void {
    // Clearing is safe in any order: the disposer only clears the global when it
    // still holds *this* provider, so a scene that already registered its own wins.
    this.disposeDebug?.();
    this.disposeDebug = null;
    for (const dispose of this.disposeCommands) {
      dispose();
    }
    this.disposeCommands = [];
    super.onDetach();
  }

  /** Seconds left on the clock, or `null` when this run has no time limit. */
  private timeLeftSec(): number | null {
    const limit = Math.max(0, Number(this.config.timeLimitSec) || 0);
    return limit > 0 ? roundHundredths(Math.max(0, limit - this.elapsed)) : null;
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

  private broadcast(): void {
    const owner = this.node;
    owner?.emit('score-changed', this.score);
    owner?.emit('lives-changed', this.lives, Math.max(1, Number(this.config.startingLives) || 1));
    const limit = Math.max(0, Number(this.config.timeLimitSec) || 0);
    owner?.emit('time-changed', limit > 0 ? Math.max(0, limit - this.elapsed) : this.elapsed);
  }

  /** End the run. This is the ONLY sanctioned way to show the result screen. */
  finish(won: boolean): void {
    if (this.over) return;
    this.over = true;
    this.won = won;

    const label = this.findNode(String(this.config.resultLabel ?? ''));
    if (label instanceof Label2D) {
      label.setText(String((won ? this.config.winText : this.config.loseText) ?? ''));
    }
    this.setNodeVisible(String(this.config.resultNode ?? ''), true);
    this.setButtonEnabled(String(this.config.retryButton ?? ''), true);

    for (const id of String(this.config.freezeNodes ?? '').split(',')) {
      const node = this.findNode(id.trim());
      if (!node) continue;
      for (const component of node.components) {
        // Only remember what WE switched off: reviving everything on reset would
        // silently enable a component the scene author had left disabled.
        if (!component.enabled) continue;
        component.enabled = false;
        this.frozen.push(component);
      }
    }
    this.node?.emit(won ? 'game-won' : 'game-lost', this.score);
  }

  private restart(): void {
    void this.scene?.changeScene(String(this.config.gameScene ?? ''), { transition: 'fade' });
  }

  /**
   * Back to the state `onStart` left behind: score, lives, clock and outcome, the
   * result overlay hidden, the freeze `finish()` applied lifted, and anything a
   * `freezeNodes` component still has on the field dropped. Those leftovers are
   * state too — a run that begins amid the previous run's objects did not begin
   * from the start.
   *
   * Public because it is useful on its own (an in-run "try again" that skips the
   * scene reload); the debug provider's `reset` is this method.
   */
  resetRun(): void {
    for (const component of this.frozen) {
      component.enabled = true;
    }
    this.frozen = [];
    this.clearSpawned();

    this.score = 0;
    this.lives = Math.max(1, Number(this.config.startingLives) || 1);
    this.elapsed = 0;
    this.over = false;
    this.won = false;

    this.setNodeVisible(String(this.config.resultNode ?? ''), false);
    this.setButtonEnabled(String(this.config.retryButton ?? ''), false);
    this.broadcast();
  }

  /**
   * Ask every component on a `freezeNodes` node that owns spawned instances to
   * drop them. Duck-typed on purpose: the freeze list is whatever you wrote there,
   * so a spawner you write yourself joins in by offering a `clear()` method.
   */
  private clearSpawned(): void {
    for (const id of String(this.config.freezeNodes ?? '').split(',')) {
      const node = this.findNode(id.trim());
      if (!node) continue;
      for (const component of node.components) {
        const clear = (component as { clear?: unknown }).clear;
        if (typeof clear === 'function') {
          (clear as () => void).call(component);
        }
      }
    }
  }

  private bindButton(query: string, handler: () => void, enabled: boolean): void {
    const button = this.findNode(query);
    if (button instanceof Button2D) {
      button.enabled = enabled;
      button.connect('pressed', this, handler);
    }
  }

  private setButtonEnabled(query: string, enabled: boolean): void {
    const button = this.findNode(query);
    if (button instanceof Button2D) {
      button.enabled = enabled;
    }
  }

  private setNodeVisible(query: string, visible: boolean): void {
    const node = this.findNode(query);
    if (node) {
      node.visible = visible;
    }
  }
}
