/**
 * GameFlow — drives the game scene (main.pix3scene).
 *
 * Attach to the game scene root. Wires the MENU button to transition back to the
 * menu scene via a fade. Extend this with your win/lose flow — call
 * `this.scene.changeScene('res://scenes/menu.pix3scene')` on game over
 * to return to the menu, or transition to a results scene of your own.
 *
 * Two conventions in here are worth keeping as you build on this template:
 *
 * 1. **Intent-first handlers.** Every reaction to the UI lives in a named public
 *    method marked `Intent:`, registered as a **command** (`scene.commands`)
 *    that the signal handler dispatches. Tools (and you, from the console) then
 *    trigger the behaviour with `scene.commands.dispatch('return-to-menu')`
 *    instead of faking a click, and every raised intent is journalled with the
 *    frame it happened on.
 * 2. **A debug provider.** `registerGameDebug` publishes a JSON snapshot of the
 *    game's state so agents and dev tooling can read what the game is doing
 *    instead of guessing from pixels. Add YOUR state to `snapshot()` — score,
 *    lives, level, whatever the game owns — and keep every value JSON-safe.
 */
import { Script, registerGameDebug, type PropertySchema } from '@pix3/runtime';

/** Coarse state of the game scene; extend with your own phases (`won`, `lost`, …). */
type GamePhase = 'idle' | 'playing' | 'leaving';

export class GameFlow extends Script {
  private phase: GamePhase = 'idle';
  private menuButtonReady = false;
  private disposeDebug: (() => void) | null = null;
  private disposeCommands: (() => void)[] = [];

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // res:// path of the scene the MENU button transitions to.
      menuScene: 'res://scenes/menu.pix3scene',
      // Node id/name of the button that returns to the menu.
      menuButton: 'menu-button',
    };
  }

  static getPropertySchema(): PropertySchema {
    const stringProp = (name: string, label: string) => ({
      name,
      type: 'string' as const,
      ui: { label, group: 'Game' },
      getValue: (s: unknown) => (s as GameFlow).config[name],
      setValue: (s: unknown, v: unknown) => {
        (s as GameFlow).config[name] = typeof v === 'string' ? v : '';
      },
    });

    return {
      nodeType: 'GameFlow',
      properties: [stringProp('menuScene', 'Menu Scene'), stringProp('menuButton', 'Menu Button')],
      groups: { Game: { label: 'Game Flow', expanded: true } },
    };
  }

  onStart(): void {
    this.phase = 'playing';
    const commands = this.scene?.commands;
    this.disposeCommands = [
      commands?.register('return-to-menu', () => this.returnToMenu(), {
        description: 'Leave the game and transition back to the menu scene.',
      }),
    ].filter((dispose): dispose is () => void => dispose !== undefined);

    this.disposeDebug = registerGameDebug({
      name: 'minigame-2d',
      version: 1,
      // The registry IS the action list — never a second, hand-kept copy.
      actions: () => this.scene?.commands.list().map(command => command.name) ?? [],
      // What "the start" means for this scene, so a test can put the game back
      // without restarting it. All this template owns is `phase`, and `playing`
      // is the value `onStart` sets — a run that had already dispatched
      // `return-to-menu` would otherwise be stuck in `leaving`. Reset YOUR state
      // here as you add it (score, level, spawned things), and seed your RNG from
      // `seed` if you want two runs to be comparable and not merely to start
      // from the same values.
      reset: () => {
        this.phase = 'playing';
      },
      // Everything returned here must be JSON-serialisable — plain values only,
      // never live nodes or Three.js objects. Add your own state as you build.
      snapshot: () => ({
        phase: this.phase,
        menuScene: String(this.config.menuScene ?? ''),
        menuButtonReady: this.menuButtonReady,
      }),
    });

    const query = String(this.config.menuButton ?? '');
    if (!query) {
      return;
    }
    const button = this.findNode(query);
    if (button) {
      this.menuButtonReady = true;
      // The button raises the intent through the registry, so a single tap in a
      // test proves this binding and every later scenario can skip the tap.
      button.connect('pressed', this, () => {
        this.scene?.commands.dispatch('return-to-menu');
      });
    } else {
      console.warn(`[GameFlow] Button "${query}" not found.`);
    }
  }

  onDetach(): void {
    this.disposeDebug?.();
    this.disposeDebug = null;
    for (const dispose of this.disposeCommands) {
      dispose();
    }
    this.disposeCommands = [];
    this.phase = 'idle';
    this.menuButtonReady = false;
    super.onDetach();
  }

  /** Intent: leave the game and transition back to the menu scene (also on game over). */
  returnToMenu(): void {
    const menuScene = String(this.config.menuScene ?? '');
    if (!menuScene) {
      console.warn('[GameFlow] No menu scene configured.');
      return;
    }
    this.phase = 'leaving';
    void this.scene?.changeScene(menuScene, { transition: 'fade', durationSec: 0.3 });
  }
}
