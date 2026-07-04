import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import { SceneManager } from '@pix3/runtime';
import { isPrefabInstanceRoot } from '@/features/scene/prefab-utils';
import {
  UnlinkPrefabInstanceOperation,
  type UnlinkPrefabInstanceOperationParams,
} from '@/features/scene/UnlinkPrefabInstanceOperation';

export class UnlinkPrefabInstanceCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.unlink-prefab-instance',
    title: 'Unlink Prefab Instance',
    description: 'Convert a prefab instance into plain, editable scene nodes',
    keywords: ['prefab', 'unlink', 'unpack', 'instance', 'break', 'flatten'],
  };

  private readonly params: UnlinkPrefabInstanceOperationParams;

  constructor(params: UnlinkPrefabInstanceOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (!context.state.scenes.activeSceneId) {
      return { canExecute: false, reason: 'No active scene', scope: 'scene' };
    }
    if (context.state.collaboration.isReadOnly) {
      return { canExecute: false, reason: 'Scene is read-only', scope: 'service' };
    }
    if (context.state.ui.isPlaying) {
      return {
        canExecute: false,
        reason: 'Cannot unlink prefabs during play mode',
        scope: 'service',
      };
    }

    const sceneManager = context.container.getService<SceneManager>(
      context.container.getOrCreateToken(SceneManager)
    );
    const node = sceneManager.getActiveSceneGraph()?.nodeMap.get(this.params.nodeId);
    if (!node || !isPrefabInstanceRoot(node)) {
      return {
        canExecute: false,
        reason: 'Select a prefab instance root to unlink',
        scope: 'selection',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const op = new UnlinkPrefabInstanceOperation(this.params);
    const pushed = await operationService.invokeAndPush(op);

    return { didMutate: pushed, payload: undefined };
  }
}
