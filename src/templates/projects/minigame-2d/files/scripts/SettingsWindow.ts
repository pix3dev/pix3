/**
 * SettingsWindow — behavior for the settings-window prefab.
 *
 * Attach to the prefab root. The Music / SFX checkboxes mute or restore the
 * engine audio buses (`scene.audio.setBusVolume`), CLOSE hides the window.
 * Node lookups are relative to the prefab subtree so multiple instances work.
 *
 * Handlers are **intent-first**: each behaviour lives in a named public method
 * marked `Intent:`, and the signal handlers below do nothing but call one. The
 * two switches are also registered as commands — `settings.toggle-music` /
 * `settings.toggle-sfx`, namespaced so this prefab's intents never collide with
 * the menu's `open-settings` / `close-settings` — so a test flips sound without
 * hunting for a checkbox on screen.
 *
 * Note on the checkboxes: they are event-driven, not polled. `Checkbox2D` splits
 * its signals the way Godot does — `click` is the POINTER signal ("the box was
 * clicked"), `toggled` is the STATE signal ("the box is now checked/unchecked"),
 * emitted after the flip with the new value as its payload. Anything that
 * applies the state connects to `toggled`, so the handler can simply read
 * `checked` (or take the payload) and get the value the user just chose.
 */
import { Script, Checkbox2D, type NodeBase, type PropertySchema } from '@pix3/runtime';

/** One live signal connection, kept so `onDetach` can take it back down. */
interface SignalBinding {
  node: NodeBase;
  signal: string;
  handler: () => void;
}

export class SettingsWindow extends Script {
  private musicToggle: Checkbox2D | null = null;
  private sfxToggle: Checkbox2D | null = null;
  private readonly bindings: SignalBinding[] = [];
  private disposeCommands: (() => void)[] = [];

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

    // Match the buses to the boxes as authored, before anyone clicks anything:
    // without the old per-frame read, nothing else would ever apply the initial state.
    if (this.musicToggle) {
      this.setMusicEnabled(this.musicToggle.checked);
    }
    if (this.sfxToggle) {
      this.setSfxEnabled(this.sfxToggle.checked);
    }

    this.connectToggle(this.musicToggle, enabled => this.setMusicEnabled(enabled));
    this.connectToggle(this.sfxToggle, enabled => this.setSfxEnabled(enabled));

    // The commands flip the BOX, not the bus: `toggled` then applies the bus, so
    // a dispatched intent leaves exactly the state a tap would (checkmark, bus,
    // snapshot). Applying the bus here instead would drift the two apart, and
    // dispatching from the `toggled` handler would make the command dispatch
    // itself — the registry caps that recursion, but the loop is the bug.
    const commands = this.scene?.commands;
    this.disposeCommands = [
      commands?.register('settings.toggle-music', () => this.musicToggle?.toggle(), {
        description: 'Flip the music checkbox, muting or restoring the music bus.',
      }),
      commands?.register('settings.toggle-sfx', () => this.sfxToggle?.toggle(), {
        description: 'Flip the SFX checkbox, muting or restoring the sound-effects bus.',
      }),
    ].filter((dispose): dispose is () => void => dispose !== undefined);

    const closeButton = this.findInSubtree<NodeBase>(String(this.config.closeButton ?? ''));
    if (closeButton) {
      this.bind(closeButton, 'pressed', () => this.closeWindow());
    } else {
      console.warn('[SettingsWindow] Close button not found.');
    }
  }

  onDetach(): void {
    for (const binding of this.bindings) {
      binding.node.disconnect(binding.signal, this, binding.handler);
    }
    this.bindings.length = 0;
    // A settings window can be freed while its scene keeps running, and a
    // command pointing at a detached prefab is exactly the dead intent the
    // registry's scene-scoped lifetime is meant to prevent.
    for (const dispose of this.disposeCommands) {
      dispose();
    }
    this.disposeCommands = [];
    this.musicToggle = null;
    this.sfxToggle = null;
  }

  /** Intent: hide the settings window. */
  closeWindow(): void {
    if (this.node) {
      this.node.visible = false;
    }
  }

  /** Intent: mute or restore the music bus. */
  setMusicEnabled(enabled: boolean): void {
    if (!this.scene) {
      return; // No audio yet — the next click applies it.
    }
    this.scene.audio.setBusVolume('music', enabled ? 1 : 0);
  }

  /** Intent: mute or restore the sound-effects bus. */
  setSfxEnabled(enabled: boolean): void {
    if (!this.scene) {
      return;
    }
    this.scene.audio.setBusVolume('sfx', enabled ? 1 : 0);
  }

  /**
   * Call `apply` with the checkbox's new state. `toggled` fires once the flip is
   * applied, so `checked` is the value the user just chose.
   */
  private connectToggle(toggle: Checkbox2D | null, apply: (enabled: boolean) => void): void {
    if (!toggle) {
      return;
    }
    this.bind(toggle, 'toggled', () => apply(toggle.checked));
  }

  /** Connect a signal and remember it, so `onDetach` leaves no listener behind. */
  private bind(node: NodeBase, signal: string, handler: () => void): void {
    node.connect(signal, this, handler);
    this.bindings.push({ node, signal, handler });
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
