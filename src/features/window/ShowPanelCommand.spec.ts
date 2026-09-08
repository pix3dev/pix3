import { describe, expect, it } from 'vitest';

import { PANEL_DISPLAY_TITLES, type PanelComponentType } from '@/core/LayoutManager';
import { KeybindingService } from '@/services/editor/KeybindingService';
import { CommandRegistry } from '@/services/core/CommandRegistry';
import { createShowPanelCommands, type ShowPanelCommand } from './ShowPanelCommand';
import { ResetLayoutCommand } from './ResetLayoutCommand';

/** The panel each row shows — `panel` is protected, and this is the point of the row. */
const panelOf = (command: ShowPanelCommand): PanelComponentType =>
  (command as unknown as { panel: PanelComponentType }).panel;

describe('Window menu rows', () => {
  const commands = createShowPanelCommands();

  it('covers every panel that had no way back after its tab was closed', () => {
    expect(commands.map(panelOf)).toEqual([
      'scene-tree',
      'inspector',
      'assets',
      'logs',
      'profiler',
      'runtime',
      'game',
    ]);
  });

  it('labels each row exactly as the tab it opens', () => {
    for (const command of commands) {
      expect(command.metadata.title).toBe(PANEL_DISPLAY_TITLES[panelOf(command)]);
    }
  });

  it('keeps every row a plain action, never a checkbox', () => {
    // A checkable row would invite closing a dock from the menu, and Golden Layout answers that by
    // collapsing the stack and moving its neighbours. Closing stays on the tab's ×.
    const registry = new CommandRegistry(new KeybindingService());
    registry.registerMany(...commands);

    for (const command of commands) {
      expect(command.metadata.checked).toBeUndefined();
      expect(registry.isChecked(command.metadata.id)).toBeUndefined();
    }
  });

  it('takes the Window slots the spec assigns, in order', () => {
    const registry = new CommandRegistry(new KeybindingService());
    registry.registerMany(...commands, new ResetLayoutCommand());

    const [section] = registry.buildMenuSections();
    expect(section.id).toBe('window');
    expect(section.items.map(item => [item.label, item.menuOrder])).toEqual([
      ['Scene Tree', 100],
      ['Inspector', 110],
      ['Assets', 120],
      ['Logs', 210],
      ['Profiler', 220],
      ['Runtime', 230],
      ['Game', 500],
      ['Reset Layout…', 900],
    ]);
  });

  it('gives Reset Layout an ellipsis, because it asks before discarding the layout', () => {
    expect(new ResetLayoutCommand().metadata.title).toBe('Reset Layout…');
  });
});
