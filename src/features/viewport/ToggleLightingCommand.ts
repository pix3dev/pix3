import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { ToggleUIFlagOperation } from './ToggleUIFlagOperation';

export class ToggleLightingCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'view.toggle-lighting',
    title: 'Toggle System Lighting',
    description: 'Toggle fallback viewport lighting for scenes without explicit light sources',
    keywords: ['lighting', 'viewport', 'toggle'],
    menuPath: 'view',
    keybinding: 'L',
    when: 'viewportFocused && !isInputFocused',
    addToMenu: true,
    menuOrder: 23,
  };

  preconditions(_context: CommandContext): CommandPreconditionResult {
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    await operations.invoke(new ToggleUIFlagOperation('showLighting', 'Toggle System Lighting'));

    return {
      didMutate: true,
      payload: undefined,
    };
  }
}
