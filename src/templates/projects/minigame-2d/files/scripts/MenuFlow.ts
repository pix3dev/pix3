/**
 * MenuFlow — wires the menu/game screen switch and opens the settings window.
 *
 * Attach to the UI root. PLAY hides the menu and shows the game screen, BACK
 * returns to the menu, SETTINGS shows the settings-window prefab instance.
 */
import { Script, type PropertySchema } from '@pix3/runtime';

export class MenuFlow extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      menuNode: 'menu-screen',
      gameNode: 'game-screen',
      settingsNode: 'settings-window',
      playButton: 'play-button',
      settingsButton: 'settings-button',
      backButton: 'back-button',
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
        stringProp('menuNode', 'Menu Screen'),
        stringProp('gameNode', 'Game Screen'),
        stringProp('settingsNode', 'Settings Window'),
        stringProp('playButton', 'Play Button'),
        stringProp('settingsButton', 'Settings Button'),
        stringProp('backButton', 'Back Button'),
      ],
      groups: { Menu: { label: 'Menu Flow', expanded: true } },
    };
  }

  onStart(): void {
    this.connectButton(String(this.config.playButton ?? ''), () => this.showGame(true));
    this.connectButton(String(this.config.backButton ?? ''), () => this.showGame(false));
    this.connectButton(String(this.config.settingsButton ?? ''), () =>
      this.setNodeVisible(String(this.config.settingsNode ?? ''), true)
    );
  }

  private showGame(inGame: boolean): void {
    this.setNodeVisible(String(this.config.menuNode ?? ''), !inGame);
    this.setNodeVisible(String(this.config.gameNode ?? ''), inGame);
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
