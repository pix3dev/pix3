import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { ViewportRendererService } from '@/services/viewport/ViewportRenderService';
import type { TransformMode } from '@/state';
import { ServiceContainer } from '@/fw/di';

/**
 * Sets the viewport transform tool (Unity's Q/W/E/R).
 *
 * Transform modes:
 * - select: Selection mode (no gizmo)
 * - translate: Move tool
 * - rotate: Rotation tool
 * - scale: Scale tool
 *
 * The four modes are *radio* menu items: each declares its own `checked` predicate over
 * `appState.ui.transformMode`, so exactly one is checked, and the viewport toolbar highlights the
 * same button by reading those very predicates through `CommandRegistry.isChecked`. Writing the
 * mode into `appState.ui` is what makes that possible — a field on the renderer service is not in
 * any snapshot, which is why pressing `W` used to leave the toolbar showing `select`.
 *
 * Each mode is its own class with its own metadata literal rather than one class with a computed
 * one: the menu guard (`CommandRegistry.menu.spec.ts`) reads metadata off disk, and four commands
 * sharing a single computed literal are exactly what it cannot check.
 */
export abstract class SetTransformModeCommand extends CommandBase<void, void> {
  abstract readonly metadata: CommandMetadata;

  /** The mode this command activates. */
  protected abstract readonly mode: TransformMode;

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const container = ServiceContainer.getInstance();
    const viewportRenderer = container.getService<ViewportRendererService>(
      container.getOrCreateToken(ViewportRendererService)
    );

    // View state, not scene state: written straight onto the proxy like the navigation mode, so it
    // never lands on the undo stack (`ToggleNavigationModeCommand` sets the precedent).
    context.state.ui.transformMode = this.mode;
    viewportRenderer.setTransformMode(this.mode);

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}

export class SelectTransformModeCommand extends SetTransformModeCommand {
  protected readonly mode: TransformMode = 'select';

  readonly metadata: CommandMetadata = {
    id: 'view.transform-mode-select',
    title: 'Select',
    description: 'Set viewport transform mode to Select',
    keywords: ['transform', 'tool', 'select'],
    menuPath: 'view',
    keybinding: 'Q',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 200,
    checked: snapshot => snapshot.ui.transformMode === 'select',
  };
}

export class TranslateTransformModeCommand extends SetTransformModeCommand {
  protected readonly mode: TransformMode = 'translate';

  readonly metadata: CommandMetadata = {
    id: 'view.transform-mode-translate',
    title: 'Move',
    description: 'Set viewport transform mode to Move',
    keywords: ['transform', 'tool', 'translate', 'move'],
    menuPath: 'view',
    keybinding: 'W',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 201,
    checked: snapshot => snapshot.ui.transformMode === 'translate',
  };
}

export class RotateTransformModeCommand extends SetTransformModeCommand {
  protected readonly mode: TransformMode = 'rotate';

  readonly metadata: CommandMetadata = {
    id: 'view.transform-mode-rotate',
    title: 'Rotate',
    description: 'Set viewport transform mode to Rotate',
    keywords: ['transform', 'tool', 'rotate'],
    menuPath: 'view',
    keybinding: 'E',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 202,
    checked: snapshot => snapshot.ui.transformMode === 'rotate',
  };
}

export class ScaleTransformModeCommand extends SetTransformModeCommand {
  protected readonly mode: TransformMode = 'scale';

  readonly metadata: CommandMetadata = {
    id: 'view.transform-mode-scale',
    title: 'Scale',
    description: 'Set viewport transform mode to Scale',
    keywords: ['transform', 'tool', 'scale'],
    menuPath: 'view',
    keybinding: 'R',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 203,
    checked: snapshot => snapshot.ui.transformMode === 'scale',
  };
}

/** Command id of the transform-mode command for a mode — the toolbar and the menu share these. */
export const transformModeCommandId = (mode: TransformMode): string =>
  `view.transform-mode-${mode}`;

/** All four transform-mode commands, in menu (and toolbar) order. */
export const createTransformModeCommands = (): SetTransformModeCommand[] => [
  new SelectTransformModeCommand(),
  new TranslateTransformModeCommand(),
  new RotateTransformModeCommand(),
  new ScaleTransformModeCommand(),
];
