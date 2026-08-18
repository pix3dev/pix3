/**
 * GridRules — score, lives and the end of the run for a carving board.
 *
 * Same shape as the other recipes' `GameRules`, with the win condition the board dictates: you win
 * by clearing every non-core cube (`board-cleared`), you lose by running out of lives. The optional
 * clock is a deadline, not a mode of its own.
 *
 * Listens on its own node (`game-root`) for what `GridBoard` emits:
 *   `cell-cleared`  (remaining) → +1 score
 *   `core-hit`      (remaining) → −1 life
 *   `board-cleared` ()          → win
 *   `board-built`   (clearable, cores) → the target for the HUD
 *
 * The end-screen buttons dispatch the commands `restart` and `return-to-menu` (`scene.commands`)
 * rather than calling methods, so a test can replay the end flow without hunting for buttons.
 *
 * It publishes the run through `registerGameDebug`: `remaining` is the number that matters here —
 * an agent proving "the tap removed a cube" reads it instead of comparing screenshots.
 */
import { Button2D, Label2D, Script, registerGameDebug, type PropertySchema } from '@pix3/runtime';

function roundHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

export class GridRules extends Script {
  private score = 0;
  private lives = 3;
  private remaining = 0;
  private clearable = 0;
  private elapsed = 0;
  private over = false;
  private won = false;
  private disposeDebug: (() => void) | null = null;
  private disposeCommands: (() => void)[] = [];

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      startingLives: 3,
      // 0 = no clock. With a limit, running it out loses.
      timeLimitSec: 0,
      resultNode: 'result-overlay',
      resultLabel: 'result-label',
      retryButton: 'retry-button',
      menuButton: 'menu-button',
      winText: 'SHAPE REVEALED',
      loseText: 'CORE DESTROYED',
      gameScene: 'res://scenes/main.pix3scene',
      menuScene: 'res://scenes/menu.pix3scene',
    };
  }

  static getPropertySchema(): PropertySchema {
    const num = (name: string, label: string, min: number, max: number) => ({
      name,
      type: 'number' as const,
      ui: { label, group: 'Rules', min, max, step: 1, slider: true },
      getValue: (s: unknown) => (s as GridRules).config[name],
      setValue: (s: unknown, v: unknown) => {
        const n = Number(v);
        (s as GridRules).config[name] = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
      },
    });
    const str = (name: string, label: string, group: string) => ({
      name,
      type: 'string' as const,
      ui: { label, group },
      getValue: (s: unknown) => (s as GridRules).config[name],
      setValue: (s: unknown, v: unknown) => {
        (s as GridRules).config[name] = typeof v === 'string' ? v : '';
      },
    });

    return {
      nodeType: 'GridRules',
      properties: [
        num('startingLives', 'Starting Lives', 1, 9),
        num('timeLimitSec', 'Time Limit (s)', 0, 600),
        str('resultNode', 'Result Overlay', 'End'),
        str('resultLabel', 'Result Label', 'End'),
        str('retryButton', 'Retry Button', 'End'),
        str('menuButton', 'Menu Button', 'End'),
        str('winText', 'Win Text', 'End'),
        str('loseText', 'Lose Text', 'End'),
        str('gameScene', 'Game Scene', 'Scenes'),
        str('menuScene', 'Menu Scene', 'Scenes'),
      ],
      groups: {
        Rules: { label: 'Rules', expanded: true },
        End: { label: 'End Screen', expanded: false },
        Scenes: { label: 'Scenes', expanded: false },
      },
    };
  }

  onStart(): void {
    this.lives = Math.max(1, Number(this.config.startingLives) || 1);
    const commands = this.scene?.commands;
    this.disposeCommands = [
      commands?.register('restart', () => this.restart(), {
        description: 'Reload the game scene for a fresh board.',
      }),
      commands?.register('return-to-menu', () => this.toMenu(), {
        description: 'Leave the run and go back to the menu scene.',
      }),
    ].filter((dispose): dispose is () => void => dispose !== undefined);

    this.disposeDebug = registerGameDebug({
      name: 'recipe-grid-3d',
      version: 1,
      actions: () => this.scene?.commands.list().map(command => command.name) ?? [],
      snapshot: () => ({
        scene: 'game',
        phase: this.over ? (this.won ? 'won' : 'lost') : 'playing',
        score: this.score,
        lives: this.lives,
        // The board's own number: cubes still to clear. This is what proves a tap landed.
        remaining: this.remaining,
        clearable: this.clearable,
        elapsedSec: roundHundredths(this.elapsed),
        timeLeftSec: this.timeLeftSec(),
      }),
    });

    const owner = this.node;
    owner?.connect('board-built', this, (...args: unknown[]) => {
      this.clearable = Number(args[0]) || 0;
      this.remaining = this.clearable;
      this.broadcast();
    });
    owner?.connect('cell-cleared', this, (...args: unknown[]) => this.onCellCleared(Number(args[0]) || 0));
    owner?.connect('core-hit', this, () => this.takeDamage(1));
    owner?.connect('board-cleared', this, () => this.finish(true));
    owner?.connect('hud-ready', this, () => this.broadcast());

    this.setNodeVisible(String(this.config.resultNode ?? ''), false);
    this.bindButton(String(this.config.retryButton ?? ''), () => this.scene?.commands.dispatch('restart'), false);
    this.bindButton(String(this.config.menuButton ?? ''), () => this.scene?.commands.dispatch('return-to-menu'), true);
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
    if (limit > 0 && this.elapsed >= limit) {
      this.finish(false);
    }
  }

  onDetach(): void {
    this.disposeDebug?.();
    this.disposeDebug = null;
    for (const dispose of this.disposeCommands) {
      dispose();
    }
    this.disposeCommands = [];
    super.onDetach();
  }

  /** End the run. Public so a custom rule can call it. */
  finish(won: boolean): void {
    if (this.over) {
      return;
    }
    this.over = true;
    this.won = won;
    const label = this.findNode(String(this.config.resultLabel ?? ''));
    if (label instanceof Label2D) {
      label.setText(String((won ? this.config.winText : this.config.loseText) ?? ''));
    }
    this.setNodeVisible(String(this.config.resultNode ?? ''), true);
    this.setButtonEnabled(String(this.config.retryButton ?? ''), true);
    this.node?.emit(won ? 'game-won' : 'game-lost', this.score);
  }

  private onCellCleared(remaining: number): void {
    if (this.over) {
      return;
    }
    this.remaining = remaining;
    this.score += 1;
    this.node?.emit('score-changed', this.score);
  }

  private takeDamage(amount: number): void {
    if (this.over) {
      return;
    }
    this.lives = Math.max(0, this.lives - Math.max(1, amount));
    this.node?.emit('lives-changed', this.lives, Math.max(1, Number(this.config.startingLives) || 1));
  }

  private broadcast(): void {
    const owner = this.node;
    owner?.emit('score-changed', this.score);
    owner?.emit('lives-changed', this.lives, Math.max(1, Number(this.config.startingLives) || 1));
    const limit = Math.max(0, Number(this.config.timeLimitSec) || 0);
    owner?.emit('time-changed', limit > 0 ? Math.max(0, limit - this.elapsed) : this.elapsed);
  }

  private timeLeftSec(): number | null {
    const limit = Math.max(0, Number(this.config.timeLimitSec) || 0);
    return limit > 0 ? roundHundredths(Math.max(0, limit - this.elapsed)) : null;
  }

  private restart(): void {
    void this.scene?.changeScene(String(this.config.gameScene ?? ''), { transition: 'fade' });
  }

  private toMenu(): void {
    void this.scene?.changeScene(String(this.config.menuScene ?? ''), { transition: 'fade' });
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
