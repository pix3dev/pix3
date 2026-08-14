/**
 * MenuFlow — drives the menu scene (the project's entry/export scene).
 *
 * PLAY transitions to the game scene with a fade. That is all it does: keep the
 * menu dumb so the game scene stays directly playable on its own (agents and
 * the editor open `main.pix3scene` and press play without going through here).
 *
 * PLAY does not call `startGame()` directly: it dispatches the command
 * `start-game` (`scene.commands`). A test can then leave the menu without a tap,
 * every raised intent lands in `scene.commands.log` with its frame, and one real
 * tap is enough to prove the button is still wired to the intent it claims.
 *
 * It registers a debug provider too. `registerGameDebug` is global and
 * last-wins, and only the running scene's flow script registers one — so
 * without this, everything a tool reads while the menu is up would come back
 * empty (or, worse, stale from the previous scene).
 */
import { Script, registerGameDebug, type PropertySchema } from '@pix3/runtime';

export class MenuFlow extends Script {
  private playButtonReady = false;
  private disposeDebug: (() => void) | null = null;
  private disposeCommands: (() => void)[] = [];

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
    const commands = this.scene?.commands;
    this.disposeCommands = [
      commands?.register('start-game', () => this.startGame(), {
        description: 'Leave the menu and transition into the game scene.',
      }),
    ].filter((dispose): dispose is () => void => dispose !== undefined);

    this.disposeDebug = registerGameDebug({
      name: 'recipe-arena-2d',
      version: 1,
      // The registry IS the action list — never a second, hand-kept copy.
      actions: () => this.scene?.commands.list().map(command => command.name) ?? [],
      // `scene` is what tells a reader which flow answered: the game scene's
      // GameRules publishes under the same name.
      snapshot: () => ({
        scene: 'menu',
        gameScene: String(this.config.gameScene ?? ''),
        playButtonReady: this.playButtonReady,
      }),
    });

    const button = this.findNode(String(this.config.playButton ?? ''));
    if (!button) {
      console.warn(`[MenuFlow] Button "${this.config.playButton}" not found.`);
      return;
    }
    this.playButtonReady = true;
    button.connect('pressed', this, () => {
      this.scene?.commands.dispatch('start-game');
    });
  }

  onDetach(): void {
    // Safe in any order: the disposer clears the global only while it still
    // holds *this* provider, so the next scene's registration is never wiped.
    this.disposeDebug?.();
    this.disposeDebug = null;
    // The scene's registry is cleared on stop anyway; this covers the other
    // case — this script being detached while the scene keeps running.
    for (const dispose of this.disposeCommands) {
      dispose();
    }
    this.disposeCommands = [];
    this.playButtonReady = false;
    super.onDetach();
  }

  /** Transition into the game scene. */
  startGame(): void {
    void this.scene?.changeScene(String(this.config.gameScene ?? ''), {
      transition: 'fade',
      durationSec: 0.3,
    });
  }
}
