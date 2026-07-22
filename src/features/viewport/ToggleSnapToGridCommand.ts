import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { ToggleUIFlagOperation } from './ToggleUIFlagOperation';

export class ToggleSnapToGridCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.toggle-snap-to-grid',
    title: 'Toggle Snap to Grid',
    description: 'Snap dragged 2D nodes to the grid (hold Alt while dragging to invert)',
    keywords: ['snap', 'grid', 'align', '2d'],
    menuPath: 'view',
    keybinding: 'Shift+G',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 21,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    await operations.invoke(new ToggleUIFlagOperation('snapToGrid', 'Toggle Snap to Grid'));

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
