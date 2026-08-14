/**
 * MenuFlow — drives the menu scene.
 *
 * Attach to the menu scene root. PLAY transitions to the game scene via a fade
 * (`this.scene.changeScene`), SETTINGS shows the settings-window prefab instance.
 * The game lives in its own scene (main.pix3scene) so it can be opened and played
 * on its own; this menu is the entry point wired into the full build flow.
 *
 * Handlers here are **intent-first**: each button's behaviour lives in a named
 * public method marked `Intent:`, and the intent is registered as a **command**
 * (`scene.commands`) that the button's signal handler dispatches. Three things
 * follow, all for free: a test drives the menu with
 * `scene.commands.dispatch('start-game')` instead of a tap; every raised intent
 * lands in `scene.commands.log` with the frame it happened on; and one real tap
 * is enough to prove the button is still wired to the intent it claims.
 *
 * It also registers a debug provider, exactly like `GameFlow` does for the game
 * scene. `registerGameDebug` is global and last-wins, and only the running
 * scene's flow script registers one — so without this, every tool reading the
 * game while the menu is up would get nothing (or stale game-scene state).
 */
import {
  Checkbox2D,
  NodeBase,
  Script,
  registerGameDebug,
  type PropertySchema,
} from '@pix3/runtime';

export class MenuFlow extends Script {
  private playButtonReady = false;
  private settingsButtonReady = false;
  private disposeDebug: (() => void) | null = null;
  private disposeCommands: (() => void)[] = [];

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
    // Register the intents first, then point the buttons at them: a button
    // dispatches, it does not call the method, so the command journal is the
    // whole truth about what the player asked for.
    const commands = this.scene?.commands;
    this.disposeCommands = [
      commands?.register('start-game', () => this.startGame(), {
        description: 'Leave the menu and transition into the game scene.',
      }),
      commands?.register(
        'open-settings',
        () => {
          this.openSettings();
          // Returning a reverse step is all it takes to make an intent
          // undoable: `scene.commands.undo()` closes the window again.
          return { undo: () => this.closeSettings() };
        },
        { description: 'Show the settings window over the menu.', undoable: true }
      ),
      commands?.register('close-settings', () => this.closeSettings(), {
        description: 'Hide the settings window.',
      }),
    ].filter((dispose): dispose is () => void => dispose !== undefined);

    this.playButtonReady = this.connectButton(String(this.config.playButton ?? ''), () => {
      this.scene?.commands.dispatch('start-game');
    });
    this.settingsButtonReady = this.connectButton(String(this.config.settingsButton ?? ''), () => {
      this.scene?.commands.dispatch('open-settings');
    });

    this.disposeDebug = registerGameDebug({
      name: 'minigame-2d',
      version: 1,
      // The registry IS the action list — never a second, hand-kept copy.
      actions: () => this.scene?.commands.list().map(command => command.name) ?? [],
      // What "the start" means for the menu: the fresh menu has the settings
      // window closed, and an earlier `open-settings` is the one piece of state a
      // later run would inherit. Deliberately NOT reset here: the checkboxes
      // inside the window, which are player settings — a reset that silently
      // reverted someone's audio choice would be a worse lie than not resetting.
      // `seed` is ignored; the menu has no randomness to seed.
      reset: () => this.closeSettings(),
      // Same `name` as GameFlow — one game, one identity; `scene` says which
      // flow answered. Everything here must stay JSON-serialisable.
      snapshot: () => ({
        scene: 'menu',
        gameScene: String(this.config.gameScene ?? ''),
        playButtonReady: this.playButtonReady,
        settingsButtonReady: this.settingsButtonReady,
        settingsVisible: this.isSettingsVisible(),
        // Checkbox state inside the settings window, keyed by node id
        // (`music-toggle` / `sfx-toggle` in the shipped prefab).
        settingsToggles: this.readSettingsToggles(),
      }),
    });
  }

  onDetach(): void {
    // Safe in any order: the disposer clears the global only while it still
    // holds *this* provider, so the game scene's registration is never wiped.
    this.disposeDebug?.();
    this.disposeDebug = null;
    // The scene's registry is cleared on stop anyway; this covers the other
    // case — this script being detached while the scene keeps running.
    for (const dispose of this.disposeCommands) {
      dispose();
    }
    this.disposeCommands = [];
    this.playButtonReady = false;
    this.settingsButtonReady = false;
    super.onDetach();
  }

  /** Intent: leave the menu and transition into the game scene. */
  startGame(): void {
    const gameScene = String(this.config.gameScene ?? '');
    if (!gameScene) {
      console.warn('[MenuFlow] No game scene configured.');
      return;
    }
    void this.scene?.changeScene(gameScene, { transition: 'fade', durationSec: 0.3 });
  }

  /** Intent: show the settings window over the menu. */
  openSettings(): void {
    this.setNodeVisible(String(this.config.settingsNode ?? ''), true);
  }

  /** Intent: hide the settings window (its own CLOSE button does this too). */
  closeSettings(): void {
    this.setNodeVisible(String(this.config.settingsNode ?? ''), false);
  }

  /** Returns whether the button was found and wired (reported in the snapshot). */
  private connectButton(query: string, handler: () => void): boolean {
    if (!query) {
      return false;
    }
    const button = this.findNode(query);
    if (!button) {
      console.warn(`[MenuFlow] Button "${query}" not found.`);
      return false;
    }
    button.connect('pressed', this, handler);
    return true;
  }

  private isSettingsVisible(): boolean {
    const node = this.findNode(String(this.config.settingsNode ?? ''));
    return node?.visible === true;
  }

  /** Every Checkbox2D under the settings window, by node id → checked. */
  private readSettingsToggles(): Record<string, boolean> {
    const toggles: Record<string, boolean> = {};
    const root = this.findNode(String(this.config.settingsNode ?? ''));
    if (!root) {
      return toggles;
    }
    const visit = (node: NodeBase): void => {
      if (node instanceof Checkbox2D) {
        toggles[node.nodeId] = node.checked;
      }
      for (const child of node.children) {
        // `children` also holds plain Three.js objects (visuals), not just nodes.
        if (child instanceof NodeBase) {
          visit(child);
        }
      }
    };
    visit(root);
    return toggles;
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
