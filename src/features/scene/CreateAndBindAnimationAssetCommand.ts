import {
  CommandBase,
  type CommandContext,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import { normalizeAnimationAssetPath } from './animation-asset-utils';
import {
  CreateAndBindAnimationAssetOperation,
  type CreateAndBindAnimationAssetOperationParams,
} from './CreateAndBindAnimationAssetOperation';

export interface CreateAndBindAnimationAssetCommandPayload {
  assetPath: string;
}

export class CreateAndBindAnimationAssetCommand extends CommandBase<
  CreateAndBindAnimationAssetCommandPayload,
  void
> {
  readonly metadata: CommandMetadata = {
    id: 'scene.create-and-bind-animation-asset',
    title: 'Create and Bind Animation Asset',
    description: 'Create a .pix3anim asset and bind it to a selected animated sprite',
    keywords: ['animation', 'asset', 'bind', 'spritesheet', 'pix3anim'],
  };

  constructor(private readonly params: CreateAndBindAnimationAssetOperationParams) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    if (context.state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened before creating animation assets',
        scope: 'project',
        recoverable: true,
      };
    }

    if (!this.params.nodeId.trim() || !this.params.assetPath.trim()) {
      return {
        canExecute: false,
        reason: 'Animation asset path and target node are required',
        scope: 'scene',
      };
    }

    return { canExecute: true };
  }

  async execute(
    context: CommandContext
  ): Promise<CommandExecutionResult<CreateAndBindAnimationAssetCommandPayload>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const assetPath = normalizeAnimationAssetPath(this.params.assetPath);
    const pushed = await operations.invokeAndPush(
      new CreateAndBindAnimationAssetOperation({
        ...this.params,
        assetPath,
      })
    );

    return {
      didMutate: pushed,
      payload: { assetPath },
    };
  }
}
