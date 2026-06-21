import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import { ToggleUIFlagOperation } from './ToggleUIFlagOperation';

export class ToggleCollidersCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.toggle-colliders',
    title: 'Toggle Physics Colliders',
    description: 'Show or hide physics collider wireframes in the running game preview',
    keywords: ['collider', 'colliders', 'physics', 'debug', 'wireframe', 'toggle'],
    menuPath: 'view',
    addToMenu: true,
    menuOrder: 24,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    await operations.invoke(
      new ToggleUIFlagOperation('showPhysicsColliders', 'Toggle Physics Colliders')
    );

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
