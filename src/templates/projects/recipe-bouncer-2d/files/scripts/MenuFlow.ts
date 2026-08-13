/**
 * MenuFlow — drives the menu scene (the project's entry/export scene).
 *
 * PLAY transitions to the game scene with a fade. That is all it does: keep the
 * menu dumb so the game scene stays directly playable on its own (agents and
 * the editor open `main.pix3scene` and press play without going through here).
 */
import { Script, type PropertySchema } from '@pix3/runtime';

export class MenuFlow extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      gameScene: 'res://scenes/main.pix3scene',
      playButton: 'play-button',
    };
  }

  static getPropertySchema(): PropertySchema {
    const str = (name: string, label: string) => ({
      name,
      type: 'string' as const,
      ui: { label, group: 'Menu' },
      getValue: (s: unknown) => (s as MenuFlow).config[name],
      setValue: (s: unknown, v: unknown) => {
        (s as MenuFlow).config[name] = typeof v === 'string' ? v : '';
      },
    });

    return {
      nodeType: 'MenuFlow',
      properties: [str('gameScene', 'Game Scene'), str('playButton', 'Play Button')],
      groups: { Menu: { label: 'Menu Flow', expanded: true } },
    };
  }

  onStart(): void {
    const button = this.findNode(String(this.config.playButton ?? ''));
    if (!button) {
      console.warn(`[MenuFlow] Button "${this.config.playButton}" not found.`);
      return;
    }
    button.connect('pressed', this, () => this.startGame());
  }

  /** Transition into the game scene. */
  startGame(): void {
    // The press is the user gesture Web Audio waits for, so this is also what
    // unlocks sound for the run. `sfx` is procedural — no asset to author.
    this.scene?.audio.sfx('powerup');
    void this.scene?.changeScene(String(this.config.gameScene ?? ''), {
      transition: 'fade',
      durationSec: 0.3,
    });
  }
}
