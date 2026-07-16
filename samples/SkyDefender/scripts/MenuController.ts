import { Script } from '@pix3/runtime';
import type { NodeBase, PropertySchema } from '@pix3/runtime';
import { session, type GameMode } from './SdSession';

const CLICK_SOUND = 'res://src/assets/audio/gui/mm/wind_button_press.mp3';

/** Menu → battle mode hand-off (SdSession owns the run's gold/purchases). */
declare global {
  // eslint-disable-next-line no-var
  var __SD_MODE: GameMode | undefined;
}

/**
 * MenuController — wires the main-menu buttons to scene changes.
 * Campaign runs the authored Lvl-1 waves; Survival enters the same battle
 * scene in endless-escalation mode (GameFlow reads the hand-off).
 */
export class MenuController extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      battleScene: 'res://src/assets/scenes/main.pix3scene',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'MenuController',
      properties: [
        {
          name: 'battleScene',
          type: 'string',
          ui: { label: 'Battle Scene', group: 'Menu' },
          getValue: (c: unknown) => (c as MenuController).config.battleScene,
          setValue: (c: unknown, v: unknown) => {
            (c as MenuController).config.battleScene = String(v);
          },
        },
      ],
      groups: { Menu: { label: 'Menu', expanded: true } },
    };
  }

  onStart(): void {
    this.wireButton('campaign-button', 'campaign');
    this.wireButton('survival-button', 'survival');
  }

  private wireButton(id: string, mode: GameMode): void {
    const button: NodeBase | null = this.findNode(id);
    if (!button) {
      console.warn(`[MenuController] Button not found: ${id}`);
      return;
    }
    button.connect('click', this, () => {
      void this.enterBattle(mode);
    });
  }

  private async enterBattle(mode: GameMode): Promise<void> {
    if (!this.scene) return;
    globalThis.__SD_MODE = mode;
    session.resetRun(mode); // fresh wallet + starting loadout for the new run
    this.scene.audio.play(CLICK_SOUND, { bus: 'sfx' });
    await this.scene.changeScene(String(this.config.battleScene), { transition: 'fade' });
  }
}
