import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { ToggleUIFlagOperation } from './ToggleUIFlagOperation';

export class ToggleDirectionAxesCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.toggle-direction-axes',
    title: 'Toggle Direction Axes',
    description: 'Show or hide per-node direction-axis gizmos (X/Y/Z) in the running game preview',
    keywords: ['axes', 'axis', 'direction', 'orientation', 'gizmo', 'debug', 'toggle'],
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 25,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    await operations.invoke(
      new ToggleUIFlagOperation('showDirectionAxes', 'Toggle Direction Axes')
    );

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
