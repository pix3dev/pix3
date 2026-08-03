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
  CreateAnimationAssetOperation,
  type CreateAnimationAssetOperationParams,
} from './CreateAnimationAssetOperation';

export interface CreateAnimationAssetCommandPayload {
  assetPath: string;
}

/**
 * Create a standalone `.pix3anim` resource — no node binding. This is the Sprite Editor's
 * "Create animation…" path (turn a spritesheet into a sprite folder); the inspector's
 * bind-to-node flow uses {@link CreateAndBindAnimationAssetCommand} instead.
 */
export class CreateAnimationAssetCommand extends CommandBase<
  CreateAnimationAssetCommandPayload,
  void
> {
  readonly metadata: CommandMetadata = {
    id: 'assets.create-animation-asset',
    title: 'Create Animation Asset',
    description: 'Create a .pix3anim animation metadata asset',
    keywords: ['animation', 'asset', 'spritesheet', 'pix3anim', 'sprite'],
  };

  constructor(private readonly params: CreateAnimationAssetOperationParams) {
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

    if (!this.params.assetPath.trim()) {
      return {
        canExecute: false,
        reason: 'Animation asset path is required',
        scope: 'project',
      };
    }

    return { canExecute: true };
  }

  async execute(
    context: CommandContext
  ): Promise<CommandExecutionResult<CreateAnimationAssetCommandPayload>> {
    const operations = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );
    const assetPath = normalizeAnimationAssetPath(this.params.assetPath);
    const pushed = await operations.invokeAndPush(
      new CreateAnimationAssetOperation({
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
