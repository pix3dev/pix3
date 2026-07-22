import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';

export class UndoCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'edit.undo',
    title: 'Undo',
    description: 'Undo the last action',
    keywords: ['undo', 'revert', 'history'],
    menuPath: 'edit',
    keybinding: 'Mod+Z',
    when: '!isInputFocused',
    addToMenu: true,
    menuOrder: 0,
  };

  private readonly operations: OperationService;

  constructor(operations: OperationService) {
    super();
    this.operations = operations;
  }

  preconditions(_context: CommandContext): CommandPreconditionResult {
    if (!this.operations.history.canUndo) {
      return {
        canExecute: false,
        reason: 'No actions available to undo',
        scope: 'service',
        recoverable: false,
      };
    }

    return { canExecute: true };
  }

  async execute(_context: CommandContext): Promise<CommandExecutionResult<void>> {
    const success = await this.operations.undo();

    return {
      didMutate: success,
      payload: undefined,
    };
  }
}
