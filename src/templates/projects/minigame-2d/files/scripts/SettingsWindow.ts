/**
 * SettingsWindow — behavior for the settings-window prefab.
 *
 * Attach to the prefab root. The Music / SFX checkboxes mute or restore the
 * engine audio buses (`scene.audio.setBusVolume`), CLOSE hides the window.
 * Node lookups are relative to the prefab subtree so multiple instances work.
 */
import { Script, Checkbox2D, type NodeBase, type PropertySchema } from '@pix3/runtime';

export class SettingsWindow extends Script {
  private musicToggle: Checkbox2D | null = null;
  private sfxToggle: Checkbox2D | null = null;

  constructor(id: string, type: string) {
    super(id, type);
    this.config = {
      musicToggle: 'music-toggle',
      sfxToggle: 'sfx-toggle',
      closeButton: 'close-button',
    };
  }

  static getPropertySchema(): PropertySchema {
    return {
      nodeType: 'SettingsWindow',
      properties: [
        {
          name: 'musicToggle',
          type: 'string',
          ui: { label: 'Music Checkbox', group: 'Settings' },
          getValue: s => (s as SettingsWindow).config.musicToggle,
          setValue: (s, v) => {
            (s as SettingsWindow).config.musicToggle = typeof v === 'string' ? v : '';
          },
        },
        {
          name: 'sfxToggle',
          type: 'string',
          ui: { label: 'SFX Checkbox', group: 'Settings' },
          getValue: s => (s as SettingsWindow).config.sfxToggle,
          setValue: (s, v) => {
            (s as SettingsWindow).config.sfxToggle = typeof v === 'string' ? v : '';
          },
        },
        {
          name: 'closeButton',
          type: 'string',
          ui: { label: 'Close Button', group: 'Settings' },
          getValue: s => (s as SettingsWindow).config.closeButton,
          setValue: (s, v) => {
            (s as SettingsWindow).config.closeButton = typeof v === 'string' ? v : '';
          },
        },
      ],
      groups: { Settings: { label: 'Settings Window', expanded: true } },
    };
  }

  onStart(): void {
    this.musicToggle = this.findInSubtree(String(this.config.musicToggle ?? ''));
    this.sfxToggle = this.findInSubtree(String(this.config.sfxToggle ?? ''));

    const closeButton = this.findInSubtree<NodeBase>(String(this.config.closeButton ?? ''));
    if (closeButton) {
      closeButton.connect('pressed', this, () => {
        if (this.node) {
          this.node.visible = false;
        }
      });
    } else {
      console.warn('[SettingsWindow] Close button not found.');
    }
  }

  onUpdate(): void {
    if (!this.scene) {
      return;
    }
    if (this.musicToggle) {
      this.scene.audio.setBusVolume('music', this.musicToggle.checked ? 1 : 0);
    }
    if (this.sfxToggle) {
      this.scene.audio.setBusVolume('sfx', this.sfxToggle.checked ? 1 : 0);
    }
  }

  /** Search this prefab's subtree by node id or name (instance-safe). */
  private findInSubtree<T extends NodeBase = NodeBase>(query: string): T | null {
    if (!query || !this.node) {
      return null;
    }
    const visit = (node: NodeBase): NodeBase | null => {
      if (node.nodeId === query || node.name === query) {
        return node;
      }
      for (const child of node.children) {
        if (child instanceof Object && 'nodeId' in child) {
          const found = visit(child as NodeBase);
          if (found) {
            return found;
          }
        }
      }
      return null;
    };
    return visit(this.node) as T | null;
  }
}
