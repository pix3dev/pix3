import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { SceneManager } from '@pix3/runtime';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import { Align2DNodesCommand } from './Align2DNodesCommand';
import {
  align2DActionBlockedReason,
  canRunAlign2DAction,
  computeAlign2DCapabilities,
} from './align-2d-capabilities';
import { ALIGN_2D_ACTION_LABELS, type Align2DActionId } from './types';

/**
 * `Node > Align` / `Node > Distribute` — one menu row per alignment action.
 *
 * Before this file the whole alignment strip lived only on the viewport toolbar
 * (`scene.align-2d-nodes`, `addToMenu: false`): no menu home, no command-palette entry, no slot a
 * user could bind a shortcut to. These rows are deliberately *thin* — each delegates to
 * {@link Align2DNodesCommand}, which pushes the existing `Align2DNodesOperation` through
 * `OperationService`, so a menu row and the toolbar button produce the same single undo entry and
 * none of the alignment maths is duplicated here.
 *
 * `preconditions()` reads the same {@link computeAlign2DCapabilities} the toolbar reads, so a greyed
 * row and a hidden toolbar group always mean the same thing.
 *
 * **No default keybindings.** Figma’s `Alt+A/D/W/S` are taken on this platform (Chrome menus, and
 * `Alt+Shift` switches the Windows keyboard layout), so the slot is left for the user to bind.
 */
export abstract class Align2DMenuCommand extends CommandBase<void, void> {
  abstract readonly metadata: CommandMetadata;

  /** The alignment action this row runs. */
  protected abstract readonly action: Align2DActionId;

  preconditions(context: CommandContext): CommandPreconditionResult {
    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const sceneGraph = sceneManager.getActiveSceneGraph();
    if (!sceneGraph) {
      return {
        canExecute: false,
        reason: 'An active scene is required to align 2D nodes',
        scope: 'scene',
      };
    }

    const capabilities = computeAlign2DCapabilities(sceneGraph, context.state.selection.nodeIds);
    if (!canRunAlign2DAction(this.action, capabilities)) {
      return {
        canExecute: false,
        reason: align2DActionBlockedReason(this.action),
        scope: 'selection',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    // Straight through the toolbar's command: same operation, same undo entry.
    const result = await new Align2DNodesCommand({ action: this.action }).execute(context);

    // The operation pushes the new transforms into the viewport but does not mark it dirty, so
    // without this the move would only appear on the next 500 ms heartbeat (the toolbar handler
    // does the same thing after its dispatch).
    if (result.didMutate) {
      const token = context.container.getOrCreateToken(ViewportRendererService);
      if (context.container.hasService(token)) {
        context.container.getService<ViewportRendererService>(token).requestRender();
      }
    }

    return result;
  }
}

export class Align2DContainerLeftCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'container-left';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.container-left',
    title: ALIGN_2D_ACTION_LABELS['container-left'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 100,
  };
}

export class Align2DContainerCenterXCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'container-center-x';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.container-center-x',
    title: ALIGN_2D_ACTION_LABELS['container-center-x'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 110,
  };
}

export class Align2DContainerRightCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'container-right';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.container-right',
    title: ALIGN_2D_ACTION_LABELS['container-right'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 120,
  };
}

export class Align2DContainerTopCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'container-top';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.container-top',
    title: ALIGN_2D_ACTION_LABELS['container-top'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 130,
  };
}

export class Align2DContainerCenterYCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'container-center-y';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.container-center-y',
    title: ALIGN_2D_ACTION_LABELS['container-center-y'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 140,
  };
}

export class Align2DContainerBottomCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'container-bottom';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.container-bottom',
    title: ALIGN_2D_ACTION_LABELS['container-bottom'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 150,
  };
}

export class Align2DSelectionLeftCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'selection-left';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.selection-left',
    title: ALIGN_2D_ACTION_LABELS['selection-left'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 200,
  };
}

export class Align2DSelectionCenterXCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'selection-center-x';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.selection-center-x',
    title: ALIGN_2D_ACTION_LABELS['selection-center-x'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 210,
  };
}

export class Align2DSelectionRightCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'selection-right';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.selection-right',
    title: ALIGN_2D_ACTION_LABELS['selection-right'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 220,
  };
}

export class Align2DSelectionTopCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'selection-top';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.selection-top',
    title: ALIGN_2D_ACTION_LABELS['selection-top'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 230,
  };
}

export class Align2DSelectionCenterYCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'selection-center-y';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.selection-center-y',
    title: ALIGN_2D_ACTION_LABELS['selection-center-y'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 240,
  };
}

export class Align2DSelectionBottomCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'selection-bottom';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.selection-bottom',
    title: ALIGN_2D_ACTION_LABELS['selection-bottom'],
    description: 'Align the selected 2D nodes',
    keywords: ['align', '2d', 'layout', 'arrange'],
    menuPath: 'node/align',
    addToMenu: true,
    menuOrder: 250,
  };
}

export class Align2DDistributeGapXCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'distribute-gap-x';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.distribute-gap-x',
    title: ALIGN_2D_ACTION_LABELS['distribute-gap-x'],
    description: 'Distribute the selected 2D nodes',
    keywords: ['distribute', 'spacing', '2d', 'layout', 'arrange'],
    menuPath: 'node/distribute',
    addToMenu: true,
    menuOrder: 100,
  };
}

export class Align2DDistributeCenterXCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'distribute-center-x';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.distribute-center-x',
    title: ALIGN_2D_ACTION_LABELS['distribute-center-x'],
    description: 'Distribute the selected 2D nodes',
    keywords: ['distribute', 'spacing', '2d', 'layout', 'arrange'],
    menuPath: 'node/distribute',
    addToMenu: true,
    menuOrder: 110,
  };
}

export class Align2DDistributeGapYCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'distribute-gap-y';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.distribute-gap-y',
    title: ALIGN_2D_ACTION_LABELS['distribute-gap-y'],
    description: 'Distribute the selected 2D nodes',
    keywords: ['distribute', 'spacing', '2d', 'layout', 'arrange'],
    menuPath: 'node/distribute',
    addToMenu: true,
    menuOrder: 120,
  };
}

export class Align2DDistributeCenterYCommand extends Align2DMenuCommand {
  protected readonly action: Align2DActionId = 'distribute-center-y';

  readonly metadata: CommandMetadata = {
    id: 'scene.align-2d.distribute-center-y',
    title: ALIGN_2D_ACTION_LABELS['distribute-center-y'],
    description: 'Distribute the selected 2D nodes',
    keywords: ['distribute', 'spacing', '2d', 'layout', 'arrange'],
    menuPath: 'node/distribute',
    addToMenu: true,
    menuOrder: 130,
  };
}

/** Every alignment/distribution menu row, in menu order. Spread into the shell's `registerMany`. */
export const createAlign2DMenuCommands = (): Align2DMenuCommand[] => [
  new Align2DContainerLeftCommand(),
  new Align2DContainerCenterXCommand(),
  new Align2DContainerRightCommand(),
  new Align2DContainerTopCommand(),
  new Align2DContainerCenterYCommand(),
  new Align2DContainerBottomCommand(),
  new Align2DSelectionLeftCommand(),
  new Align2DSelectionCenterXCommand(),
  new Align2DSelectionRightCommand(),
  new Align2DSelectionTopCommand(),
  new Align2DSelectionCenterYCommand(),
  new Align2DSelectionBottomCommand(),
  new Align2DDistributeGapXCommand(),
  new Align2DDistributeCenterXCommand(),
  new Align2DDistributeGapYCommand(),
  new Align2DDistributeCenterYCommand(),
];
