import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { ToggleUIFlagOperation } from './ToggleUIFlagOperation';

export class ToggleAxisGizmoCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.toggle-axis-gizmo',
    title: 'Toggle Axis Gizmo',
    description: 'Show or hide the orientation gizmo (X/Y/Z axes) in the viewport corner',
    keywords: ['axes', 'axis', 'gizmo', 'orientation', 'view cube', 'viewport', 'toggle'],
    menuPath: 'view',
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
    await operations.invoke(new ToggleUIFlagOperation('showAxisGizmo', 'Toggle Axis Gizmo'));

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
