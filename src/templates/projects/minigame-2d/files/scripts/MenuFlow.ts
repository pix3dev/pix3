/**
 * MenuFlow — drives the menu scene.
 *
 * Attach to the menu scene root. PLAY transitions to the game scene via a fade
 * (`this.scene.changeScene`), SETTINGS shows the settings-window prefab instance.
 * The game lives in its own scene (main.pix3scene) so it can be opened and played
 * on its own; this menu is the entry point wired into the full build flow.
 */
import { Script, type PropertySchema } from '@pix3/runtime';

export class MenuFlow extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // res:// path of the scene PLAY transitions to.
      gameScene: 'res://scenes/main.pix3scene',
      // Node id/name of the settings-window prefab instance to toggle.
      settingsNode: 'settings-window',
      playButton: 'play-button',
      settingsButton: 'settings-button',
    };
  }

  static getPropertySchema(): PropertySchema {
    const stringProp = (name: string, label: string) => ({
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
      properties: [
        stringProp('gameScene', 'Game Scene'),
        stringProp('settingsNode', 'Settings Window'),
        stringProp('playButton', 'Play Button'),
        stringProp('settingsButton', 'Settings Button'),
      ],
      groups: { Menu: { label: 'Menu Flow', expanded: true } },
    };
  }

  onStart(): void {
    this.connectButton(String(this.config.playButton ?? ''), () => this.startGame());
    this.connectButton(String(this.config.settingsButton ?? ''), () =>
      this.setNodeVisible(String(this.config.settingsNode ?? ''), true)
    );
  }

  private startGame(): void {
    const gameScene = String(this.config.gameScene ?? '');
    if (!gameScene) {
      console.warn('[MenuFlow] No game scene configured.');
      return;
    }
    void this.scene?.changeScene(gameScene, { transition: 'fade', durationSec: 0.3 });
  }

  private connectButton(query: string, handler: () => void): void {
    if (!query) {
      return;
    }
    const button = this.findNode(query);
    if (button) {
      button.connect('pressed', this, handler);
    } else {
      console.warn(`[MenuFlow] Button "${query}" not found.`);
    }
  }

  private setNodeVisible(query: string, visible: boolean): void {
    if (!query) {
      return;
    }
    const node = this.findNode(query);
    if (node) {
      node.visible = visible;
    } else {
      console.warn(`[MenuFlow] Node "${query}" not found.`);
    }
  }
}
