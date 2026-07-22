import {
  CommandBase,
  type CommandExecutionResult,
  type CommandMetadata,
  type CommandContext,
  type CommandPreconditionResult,
} from '@/core/command';
import { OperationService } from '@/services/core/OperationService';
import {
  SaveAnimationOperation,
  type SaveAnimationOperationParams,
} from './SaveAnimationOperation';

export class SaveAnimationCommand extends CommandBase<void, void> {
  readonly metadata: CommandMetadata = {
    id: 'animation.save',
    title: 'Save Animation',
    description: 'Save the active animation asset to its current file',
    keywords: ['save', 'animation'],
  };

  constructor(private readonly params?: SaveAnimationOperationParams) {
    super();
  }

  preconditions(context: CommandContext): CommandPreconditionResult {
    const { state } = context;

    if (state.project.status !== 'ready') {
      return {
        canExecute: false,
        reason: 'Project must be opened before saving animations',
        scope: 'project',
        recoverable: true,
      };
    }

    if (state.project.backend === 'cloud') {
      return {
        canExecute: false,
        reason: 'Cloud animation assets are synchronized automatically.',
        scope: 'external',
        recoverable: true,
      };
    }

    const animationId = this.params?.animationId ?? state.animations.activeAnimationId;
    if (!animationId) {
      return {
        canExecute: false,
        reason: 'An active animation is required to save',
        scope: 'service',
      };
    }

    const descriptor = state.animations.descriptors[animationId];
    if (!descriptor) {
      return {
        canExecute: false,
        reason: 'Active animation descriptor not found',
        scope: 'service',
      };
    }

    if (!state.animations.resources[animationId]) {
      return {
        canExecute: false,
        reason: 'Active animation resource not found',
        scope: 'service',
      };
    }

    return { canExecute: true };
  }

  async execute(context: CommandContext): Promise<CommandExecutionResult<void>> {
    const operationService = context.container.getService<OperationService>(
      context.container.getOrCreateToken(OperationService)
    );

    const pushed = await operationService.invokeAndPush(
      new SaveAnimationOperation({ animationId: this.params?.animationId })
    );

    return { didMutate: pushed, payload: undefined };
  }
}
