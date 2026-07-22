/**
 * ToggleScriptEnabledCommand - Command to toggle script enabled state
 */

import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  PREFAB_COMPONENT_LOCK_REASON,
  isPrefabInstanceNode,
} from '@/features/scene/scene-command-utils';
import {
  ToggleScriptEnabledOperation,
  type ToggleScriptEnabledParams,
} from './ToggleScriptEnabledOperation';

export class ToggleScriptEnabledCommand extends CommandBase<object, void> {
  readonly metadata: CommandMetadata = {
    id: 'scripts.toggle-enabled',
    title: 'Toggle Script Enabled',
    description: 'Enable or disable a behavior or controller',
    keywords: ['toggle', 'enable', 'disable', 'behavior', 'controller'],
  };

  private readonly params: ToggleScriptEnabledParams;

  constructor(params: ToggleScriptEnabledParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (!context.snapshot.scenes.activeSceneId) {
      return { canExecute: false, reason: 'No active scene', scope: 'scene' };
    }
    if (!this.params.nodeId) {
      return { canExecute: false, reason: 'No target node specified', scope: 'selection' };
    }
    if (isPrefabInstanceNode(context, this.params.nodeId)) {
      return { canExecute: false, reason: PREFAB_COMPONENT_LOCK_REASON, scope: 'selection' };
    }
    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<object>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const op = new ToggleScriptEnabledOperation(this.params);
    const pushed = await operations.invokeAndPush(op);
    return { didMutate: pushed, payload: {} };
  }
}
