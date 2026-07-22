import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { ToggleUIFlagOperation } from './ToggleUIFlagOperation';

export class ToggleGridCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.toggle-grid',
    title: 'Toggle Grid',
    description: 'Show or hide the grid in the viewport',
    keywords: ['grid', 'viewport', 'toggle'],
    menuPath: 'view',
    keybinding: 'G',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 20,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    await operations.invoke(new ToggleUIFlagOperation('showGrid', 'Toggle Grid'));

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
