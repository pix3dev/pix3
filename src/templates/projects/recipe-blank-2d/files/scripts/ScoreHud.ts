/**
 * ScoreHud — signal-driven HUD. Display only, no game logic.
 *
 * Listens on `sourceNode` (the node carrying `GameRules`) for:
 *   `score-changed` (score)
 *   `lives-changed` (lives, maxLives)
 *   `time-changed`  (seconds)
 *
 * If a HUD widget is missing from the scene it is quietly skipped, so you can
 * delete the timer or the lives bar without touching any script.
 *
 * With `GameRules.timeLimitSec` at 0 there is no clock, and `time-changed` carries
 * ELAPSED seconds instead — the label counts up. Set a limit and it counts down.
 */
import { Bar2D, Label2D, Script, type PropertySchema } from '@pix3/runtime';

export class ScoreHud extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // Node that emits the HUD signals (the GameRules host).
      sourceNode: 'game-root',
      scoreLabel: 'score-label',
      scoreFormat: 'SCORE {value}',
      timeLabel: 'time-label',
      timeFormat: '{value}',
      livesBar: 'lives-bar',
    };
  }

  static getPropertySchema(): PropertySchema {
    const str = (name: string, label: string, description?: string) => ({
      name,
      type: 'string' as const,
      ui: { label, group: 'HUD', description },
      getValue: (s: unknown) => (s as ScoreHud).config[name],
      setValue: (s: unknown, v: unknown) => {
        (s as ScoreHud).config[name] = typeof v === 'string' ? v : '';
      },
    });

    return {
      nodeType: 'ScoreHud',
      properties: [
        str(
          'sourceNode',
          'Source Node',
          'Node that emits score-changed / lives-changed / time-changed'
        ),
        str('scoreLabel', 'Score Label'),
        str('scoreFormat', 'Score Format', '{value} is replaced by the score'),
        str('timeLabel', 'Time Label'),
        str('timeFormat', 'Time Format', '{value} is replaced by whole seconds'),
        str('livesBar', 'Lives Bar'),
      ],
      groups: { HUD: { label: 'HUD', expanded: true } },
    };
  }

  onStart(): void {
    const source = this.findNode(String(this.config.sourceNode ?? ''));
    if (!source) {
      console.warn(`[ScoreHud] Source node "${this.config.sourceNode}" not found.`);
      return;
    }
    source.connect('score-changed', this, (...args: unknown[]) =>
      this.setScore(Number(args[0]) || 0)
    );
    source.connect('time-changed', this, (...args: unknown[]) =>
      this.setTime(Number(args[0]) || 0)
    );
    source.connect('lives-changed', this, (...args: unknown[]) =>
      this.setLives(Number(args[0]) || 0, Number(args[1]) || 0)
    );
    // Ask for the opening values now that the listeners are live: GameRules
    // starts before this HUD (parent components tick before children).
    source.emit('hud-ready');
  }

  private setScore(score: number): void {
    const label = this.findNode(String(this.config.scoreLabel ?? ''));
    if (label instanceof Label2D) {
      label.setText(
        String(this.config.scoreFormat ?? '{value}').replace('{value}', String(Math.round(score)))
      );
    }
  }

  private setTime(seconds: number): void {
    const label = this.findNode(String(this.config.timeLabel ?? ''));
    if (label instanceof Label2D) {
      label.setText(
        String(this.config.timeFormat ?? '{value}').replace(
          '{value}',
          String(Math.max(0, Math.ceil(seconds)))
        )
      );
    }
  }

  private setLives(lives: number, maxLives: number): void {
    const bar = this.findNode(String(this.config.livesBar ?? ''));
    if (bar instanceof Bar2D) {
      if (maxLives > 0) {
        bar.maxValue = maxLives;
      }
      bar.setValue(lives);
    }
  }
}
