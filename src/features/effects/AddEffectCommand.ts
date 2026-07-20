/**
 * AddEffectCommand - command to attach a shader effect to a shader-effect host
 * node (GeometryMesh, Sprite2D, AnimatedSprite2D, Button2D, ...).
 */
import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import {
  PREFAB_COMPONENT_LOCK_REASON,
  isPrefabInstanceNode,
} from '@/features/scene/scene-command-utils';
import { AddEffectOperation, type AddEffectParams } from './AddEffectOperation';

export class AddEffectCommand extends CommandBase<object, void> {
  readonly metadata: CommandMetadata = {
    id: 'effects.add-effect',
    title: 'Add Effect',
    description: 'Attach a shader effect to a node',
    keywords: ['add', 'effect', 'shader', 'dissolve', 'rim', 'flash'],
  };

  private readonly params: AddEffectParams;

  constructor(params: AddEffectParams) {
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
    const op = new AddEffectOperation(this.params);
    const pushed = await operations.invokeAndPush(op);
    return { didMutate: pushed, payload: {} };
  }
}
