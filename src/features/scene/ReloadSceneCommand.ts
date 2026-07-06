import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/OperationService';
import {
  ReloadSceneOperation,
  type ReloadSceneOperationParams,
} from '@/features/scene/ReloadSceneOperation';

/**
 * ReloadSceneCommand reloads a scene from its file source.
 * Typically triggered automatically when external file changes are detected.
 * Not exposed in menu - used internally for file watching.
 */
export class ReloadSceneCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'scene.reload',
    title: 'Reload Scene',
    description: 'Reload scene from file (internal, triggered by external change)',
    keywords: ['reload', 'scene', 'refresh', 'file-change'],
  };

  private readonly params: ReloadSceneOperationParams;

  constructor(params: ReloadSceneOperationParams) {
    super();
    this.params = params;
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const { state } = context;

    const descriptor = state.scenes.descriptors[this.params.sceneId];
    if (!descriptor) {
      return {
        canExecute: false,
        reason: 'Scene not found for reload',
        scope: 'scene',
        recoverable: false,
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const op = new ReloadSceneOperation(this.params);
    // Use invoke (never pushes) — a reload is not undoable — then clear history:
    // the in-memory graph was replaced and its nodes disposed, so any existing
    // undo entries for this scene now reference detached/disposed nodes.
    await operationService.invoke(op);
    operationService.clearHistory();

    return { didMutate: true, payload: undefined };
  }
}
