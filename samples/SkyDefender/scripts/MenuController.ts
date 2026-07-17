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
 * Campaign opens the conquest map (fresh run); Continue restores the saved
 * run and returns to the map; Survival enters the battle scene directly in
 * endless-escalation mode (GameFlow reads the hand-off).
 */
export class MenuController extends Script {
  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      battleScene: 'res://src/assets/scenes/main.pix3scene',
      mapScene: 'res://src/assets/scenes/map.pix3scene',
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
        {
          name: 'mapScene',
          type: 'string',
          ui: { label: 'Map Scene', group: 'Menu' },
          getValue: (c: unknown) => (c as MenuController).config.mapScene,
          setValue: (c: unknown, v: unknown) => {
            (c as MenuController).config.mapScene = String(v);
          },
        },
      ],
      groups: { Menu: { label: 'Menu', expanded: true } },
    };
  }

  onStart(): void {
    this.wireButton('campaign-button', () => this.startCampaign());
    this.wireButton('survival-button', () => this.startSurvival());

    // Continue only shows up when a previous run survives in localStorage.
    const continueButton = this.findNode('continue-button');
    if (continueButton) {
      const hasSave = session.loadRun();
      continueButton.visible = hasSave;
      (continueButton as NodeBase & { enabled?: boolean }).enabled = hasSave;
      if (hasSave) continueButton.connect('click', this, () => this.continueRun());
    }
  }

  private wireButton(id: string, handler: () => void): void {
    const button: NodeBase | null = this.findNode(id);
    if (!button) {
      console.warn(`[MenuController] Button not found: ${id}`);
      return;
    }
    button.connect('click', this, handler);
  }

  private startCampaign(): void {
    session.resetRun('campaign'); // fresh wallet + starting loadout
    globalThis.__SD_MODE = 'campaign';
    void this.goTo(this.mapScenePath());
  }

  private continueRun(): void {
    // loadRun() already restored the state in onStart; survival saves have no
    // mid-run meaning, so Continue always resumes on the campaign map.
    globalThis.__SD_MODE = 'campaign';
    void this.goTo(this.mapScenePath());
  }

  /** Scene YAML replaces `config` wholesale — older scenes may lack the key. */
  private mapScenePath(): string {
    return String(this.config.mapScene || 'res://src/assets/scenes/map.pix3scene');
  }

  private startSurvival(): void {
    session.resetRun('survival');
    globalThis.__SD_MODE = 'survival';
    void this.goTo(String(this.config.battleScene));
  }

  private async goTo(scenePath: string): Promise<void> {
    if (!this.scene) return;
    this.scene.audio.play(CLICK_SOUND, { bus: 'sfx' });
    await this.scene.changeScene(scenePath, { transition: 'fade' });
  }
}
