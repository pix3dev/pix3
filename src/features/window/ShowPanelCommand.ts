import { inject } from '@/fw/di';
import {
  LayoutManagerService,
  PANEL_COMPONENT_TYPES,
  PANEL_DISPLAY_TITLES,
  type PanelComponentType,
} from '@/core/LayoutManager';
import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
} from '@/core/command';
import { openGameSurface } from '@/features/scripts/play-workspace';

/**
 * `Window ▸ <panel>` — open-or-focus one dockable panel.
 *
 * Every closable panel needs a way back after its tab was closed (spec §2.5), and there are seven
 * of them missing before this file: Scene Tree, Inspector, Assets, Logs, Profiler, Runtime, Game.
 * Seven bespoke command classes would be seven copies of the same three lines, so this is one base
 * class plus one thin subclass per panel — the subclass carries nothing but the panel it shows and
 * its own metadata literal.
 *
 * The metadata stays a *literal* in each subclass on purpose: the menu guard
 * (`CommandRegistry.menu.spec.ts`) parses these literals off disk to prove `(menuPath, menuOrder)`
 * is unique, and a computed `menuOrder` reads back as `NaN` and slips past it. The title is taken
 * from `PANEL_DISPLAY_TITLES` because the rule is that a Window row reads exactly like the tab it
 * opens — one source of names, so a tab rename cannot leave the menu behind.
 *
 * Behaviour: idempotent, and **never checkable**. A checkbox would invite closing a dock from the
 * menu, and in Golden Layout that collapses the stack and moves its neighbours; closing stays on
 * the tab's × (Unity does the same). Opening a panel is also not a scene change, hence
 * `didMutate: false` — no Operation, no undo entry.
 */
export abstract class ShowPanelCommand extends CommandBase<void, void> {
  abstract readonly metadata: CommandMetadata;

  /** The panel this row shows. */
  protected abstract readonly panel: PanelComponentType;

  @inject(LayoutManagerService)
  protected readonly layoutManager!: LayoutManagerService;

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    await this.reveal(context);
    return {
      didMutate: false,
      payload: undefined,
    };
  }

  /**
   * How this panel is revealed. The default — and the case for every dockable panel — is
   * `LayoutManager.showPanel()`, which focuses the panel when it is in the layout and docks it back
   * into its home stack when it is not. Overridden only by the Game row, which is a *document*.
   */
  protected async reveal(_context: CommandContext): Promise<void> {
    this.layoutManager.showPanel(this.panel);
  }
}

export class ShowSceneTreePanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.sceneTree;

  readonly metadata: CommandMetadata = {
    id: 'window.show-scene-tree',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.sceneTree],
    description: 'Show the Scene Tree panel',
    keywords: ['scene', 'tree', 'hierarchy', 'outliner', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 100,
  };
}

export class ShowInspectorPanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.inspector;

  readonly metadata: CommandMetadata = {
    id: 'window.show-inspector',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.inspector],
    description: 'Show the Inspector panel',
    keywords: ['inspector', 'properties', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 110,
  };
}

export class ShowAssetsPanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.assets;

  readonly metadata: CommandMetadata = {
    id: 'window.show-assets',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.assets],
    description: 'Show the Assets panel',
    keywords: ['assets', 'browser', 'files', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 120,
  };
}

export class ShowLogsPanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.logs;

  readonly metadata: CommandMetadata = {
    id: 'window.show-logs',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.logs],
    description: 'Show the Logs panel',
    keywords: ['logs', 'console', 'output', 'errors', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 210,
  };
}

export class ShowProfilerPanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.profiler;

  readonly metadata: CommandMetadata = {
    id: 'window.show-profiler',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.profiler],
    description: 'Show the Profiler panel',
    keywords: ['profiler', 'performance', 'fps', 'stats', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 220,
  };
}

export class ShowRuntimePanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.runtime;

  readonly metadata: CommandMetadata = {
    id: 'window.show-runtime',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.runtime],
    description: 'Show the Runtime panel',
    keywords: ['runtime', 'live', 'nodes', 'play', 'panel', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 230,
  };
}

/**
 * The Game surface is a *document* in the editor stack, not a docked panel: it is keyed by a tab id
 * and has no place to be docked into. `openGameSurface()` is the existing open-or-focus for it
 * (and the only one that is Flow-aware — Flow mounts the stage permanently and has no tabs), so
 * this row delegates there instead of to `LayoutManager.showPanel()`.
 */
export class ShowGamePanelCommand extends ShowPanelCommand {
  protected readonly panel: PanelComponentType = PANEL_COMPONENT_TYPES.game;

  readonly metadata: CommandMetadata = {
    id: 'window.show-game',
    title: PANEL_DISPLAY_TITLES[PANEL_COMPONENT_TYPES.game],
    description: 'Show the Game view the running scene is drawn on',
    keywords: ['game', 'play', 'preview', 'view', 'tab', 'window'],
    menuPath: 'window',
    addToMenu: true,
    menuOrder: 500,
  };

  protected async reveal(context: CommandContext): Promise<void> {
    await openGameSurface(context.container);
  }
}

/** Every `Window ▸ <panel>` row, in menu order. Spread into the shell's `registerMany`. */
export const createShowPanelCommands = (): ShowPanelCommand[] => [
  new ShowSceneTreePanelCommand(),
  new ShowInspectorPanelCommand(),
  new ShowAssetsPanelCommand(),
  new ShowLogsPanelCommand(),
  new ShowProfilerPanelCommand(),
  new ShowRuntimePanelCommand(),
  new ShowGamePanelCommand(),
];
