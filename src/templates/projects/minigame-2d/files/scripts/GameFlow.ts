/**
 * GameFlow — drives the game scene (main.pix3scene).
 *
 * Attach to the game scene root. Wires the MENU button to transition back to the
 * menu scene via a fade. Extend this with your win/lose flow — call
 * `this.scene.changeScene('res://src/assets/scenes/menu.pix3scene')` on game over
 * to return to the menu, or transition to a results scene of your own.
 */
import { Script, type PropertySchema } from '@pix3/runtime';

export class GameFlow extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      // res:// path of the scene the MENU button transitions to.
      menuScene: 'res://src/assets/scenes/menu.pix3scene',
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
    const query = String(this.config.menuButton ?? '');
    if (!query) {
      return;
    }
    const button = this.findNode(query);
    if (button) {
      button.connect('pressed', this, () => this.returnToMenu());
    } else {
      console.warn(`[GameFlow] Button "${query}" not found.`);
    }
  }

  /** Transition back to the menu scene. Call this on game over too. */
  returnToMenu(): void {
    const menuScene = String(this.config.menuScene ?? '');
    if (!menuScene) {
      console.warn('[GameFlow] No menu scene configured.');
      return;
    }
    void this.scene?.changeScene(menuScene, { transition: 'fade', durationSec: 0.3 });
  }
}
