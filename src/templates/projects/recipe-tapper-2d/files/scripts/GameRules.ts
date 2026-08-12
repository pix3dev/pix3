/**
 * GameRules — score, lives, timer, win/lose and the end flow.
 *
 * Listens on its own node for the semantic signals `TouchRules` emits
 * (`touch-scored` / `touch-damaged`), keeps the run state, and re-broadcasts
 * `score-changed` / `lives-changed` / `time-changed` for the HUD. It is the only
 * script that decides when the run is over.
 *
 * Win modes:
 *   `score`   — reach `targetScore`; the time limit (if any) is a deadline.
 *   `time`    — play until the timer ends, then win if `targetScore` was reached.
 *   `survive` — stay alive until the timer ends; reaching it is the win.
 * In every mode, running out of lives loses.
 */
import { Button2D, Label2D, Script, type PropertySchema } from '@pix3/runtime';

type WinMode = 'score' | 'time' | 'survive';

export class GameRules extends Script {
  private score = 0;
  private lives = 3;
  private elapsed = 0;
  private over = false;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      winMode: 'time',
      targetScore: 18,
      timeLimitSec: 30,
      startingLives: 3,
      resultNode: 'result-overlay',
      resultLabel: 'result-label',
      winText: 'YOU WIN!',
      loseText: 'GAME OVER',
      retryButton: 'retry-button',
      menuButton: 'menu-button',
      menuScene: 'res://scenes/menu.pix3scene',
      gameScene: 'res://scenes/main.pix3scene',
      // Comma-separated node ids frozen (all their components disabled) on game over.
      freezeNodes: 'spawner-targets,spawner-hazards',
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
        str('menuButton', 'Menu Button', 'Flow'),
        str('menuScene', 'Menu Scene', 'Flow'),
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
    const owner = this.node;
    owner?.connect('touch-scored', this, (...args: unknown[]) => this.addScore(Number(args[0]) || 0));
    owner?.connect('touch-damaged', this, (...args: unknown[]) => this.takeDamage(Number(args[0]) || 0));
    // The HUD announces itself once it is connected, so it never misses the
    // opening values (its onStart runs after this one).
    owner?.connect('hud-ready', this, () => this.broadcast());

    this.setNodeVisible(String(this.config.resultNode ?? ''), false);
    this.bindButton(String(this.config.retryButton ?? ''), () => this.restart(), false);
    this.bindButton(String(this.config.menuButton ?? ''), () => this.toMenu(), true);
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

  private addScore(amount: number): void {
    if (this.over) return;
    this.score += amount;
    this.node?.emit('score-changed', this.score);
  }

  private takeDamage(amount: number): void {
    if (this.over) return;
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

  /** End the run. Call this from your own code for a custom win/lose condition. */
  finish(won: boolean): void {
    if (this.over) return;
    this.over = true;

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
        component.enabled = false;
      }
    }
    this.node?.emit(won ? 'game-won' : 'game-lost', this.score);
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
