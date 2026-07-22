import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';

export class RedoCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'edit.redo',
    title: 'Redo',
    description: 'Redo the last undone action',
    keywords: ['redo', 'history'],
    menuPath: 'edit',
    keybinding: 'Mod+Shift+Z | Ctrl+Y',
    when: '!isInputFocused',
    addToMenu: true,
    menuOrder: 1,
  };

  private readonly operations: OperationService;

  constructor(operations: OperationService) {
    super();
    this.operations = operations;
  }

  preconditions(_context: CommandContext): CommandPreconditionResult {
    if (!this.operations.history.canRedo) {
      return {
        canExecute: false,
        reason: 'No actions available to redo',
        scope: 'service',
        recoverable: false,
      };
    }

    return { canExecute: true };
  }

  async execute(_context: CommandContext): Promise<CommandExecutionResult<void>> {
    const success = await this.operations.redo();

    return {
      didMutate: success,
      payload: undefined,
    };
  }
}
