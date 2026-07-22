import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import {
  ViewportRendererService,
  type TransformMode,
} from '@/services/viewport/ViewportRenderService';
import { ServiceContainer } from '@/fw/di';

/**
 * Command to set the transform tool mode in the viewport.
 *
 * Transform modes:
 * - select: Selection mode (no gizmo)
 * - translate: Move tool
 * - rotate: Rotation tool
 * - scale: Scale tool
 */
export class SetTransformModeCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata;

  private readonly mode: TransformMode;

  constructor(mode: TransformMode) {
    super();
    this.mode = mode;

    const modeLabels: Record<TransformMode, string> = {
      select: 'Select',
      translate: 'Translate',
      rotate: 'Rotate',
      scale: 'Scale',
    };

    const modeKeys: Record<TransformMode, string> = {
      select: 'Q',
      translate: 'W',
      rotate: 'E',
      scale: 'R',
    };

    this.metadata = {
      id: `view.transform-mode-${mode}`,
      title: `${modeLabels[mode]} Mode`,
      description: `Set viewport transform mode to ${modeLabels[mode]}`,
      keywords: ['transform', 'tool', mode],
      menuPath: 'view',
      keybinding: modeKeys[mode],
      when: 'viewportFocused && !isInputFocused',
      addToMenu: true,
      menuOrder: 10 + ['select', 'translate', 'rotate', 'scale'].indexOf(mode),
    };
  }

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(_context: CommandContext): Promise<CommandExecutionResult<void>> {
    const container = ServiceContainer.getInstance();
    const viewportRenderer = container.getService<ViewportRendererService>(
      container.getOrCreateToken(ViewportRendererService)
    );

    viewportRenderer.setTransformMode(this.mode);

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
